#include "ota_web.h"
#include "version.h"
#include "settings.h"

#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "power.h"

#include <string.h>

static const char *TAG = "ota_web";

#define OTA_CONFIRM_MS 45000
#define WEB_CHUNK      4096
#define SNIFF_MIN      64      /* 判定前至少攒够的字节数（TCP 首段可能很短） */

/* httpd 任务栈只有 4KB：收包缓冲一律静态共享，绝不能在栈上放大数组
   （R1.0.1 的 handler 在栈上放了 buf[4096]+head[8192]，一进来就栈溢出断连）。 */
static char s_buf[WEB_CHUNK];

/* ---- 写入分区：逐扇区「首次写入前先擦」 ---- */

/*
 * 不用 esp_ota_begin()/整片预擦：整片擦 930KB 约 5~15s，期间无数据流动，
 * 慢客户端容易超时（FB-004）。recv 块大小是任意的（TCP 分段），必须按扇区边界
 * 拆开写，否则会跨进未擦除扇区造成静默数据损坏。
 * 返回实际写入字节数，失败返回 -1。
 */
static int write_sectors(const esp_partition_t *part, size_t off, const char *p, int n)
{
    int done = 0;
    while (n > 0) {
        size_t at = off + (size_t)done;
        if ((at & 0xFFF) == 0) {                        /* 到达扇区起点：先擦 */
            uint32_t elen = 0x1000;
            if (at + elen > part->size) elen = (uint32_t)(part->size - at);
            if (esp_partition_erase_range(part, at, elen) != ESP_OK) return -1;
        }
        uint32_t room = 0x1000 - (uint32_t)(at & 0xFFF);  /* 距本扇区尾 */
        uint32_t w = ((uint32_t)n < room) ? (uint32_t)n : room;
        if (esp_partition_write(part, at, p, w) != ESP_OK) return -1;
        done += (int)w;
        p += w;
        n -= (int)w;
    }
    return done;
}

/* ---- 固件 OTA ---- */

/*
 * pre > 0 表示「首块已由统一入口预读进 s_buf，长度为 pre 字节」；
 * pre == 0 表示由本函数自行开始接收。
 * 预读字节必须原样参与写入 —— 丢掉文件头整包就报废。
 */
static esp_err_t ota_stream(httpd_req_t *req, int pre)
{
    power_activity();                 /* R1.0.8：长传输期间禁止空闲休眠 */
    size_t total = req->content_len;
    if (total == 0)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty image");

    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    if (!part)
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no ota slot");
    if (total > part->size)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "image too large");

    int n = pre;
    if (n == 0) {
        n = httpd_req_recv(req, s_buf, WEB_CHUNK);
        if (n <= 0)
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty body");
    }
    if ((uint8_t)s_buf[0] != 0xE9)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "not an ESP32 image");

    ESP_LOGI(TAG, "OTA start: %u bytes -> %s", (unsigned)total, part->label);

    size_t written = 0;
    bool ok = true;
    for (;;) {
        int w = write_sectors(part, written, s_buf, n);
        if (w < 0) { ok = false; break; }
        written += (size_t)w;
        if (written >= total) break;
        n = httpd_req_recv(req, s_buf, WEB_CHUNK);
        if (n <= 0) { ok = false; break; }
        power_activity();
    }

    if (!ok || written != total)
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "ota write failed");

    /* 最小镜像校验（替代 esp_ota_end 的关键项）：
       0xE9 魔数 + 芯片型号（扩展头 0x0C 处 chip_id，ESP32-C3=0x0005）+
       app 描述符 magic 0xABCD5432（偏移 0x20）。
       更深层的段校验交给回滚兜底：新固件 45s 内不确认则自动回滚旧版。 */
    uint8_t hdr[64];
    if (esp_partition_read(part, 0, hdr, sizeof(hdr)) != ESP_OK || hdr[0] != 0xE9)
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "ota verify failed");
    uint16_t chip_id = (uint16_t)(hdr[0x0C] | (hdr[0x0D] << 8));
    if (chip_id != 0x0005 ||     /* ESP32-C3 */
        hdr[0x20] != 0x32 || hdr[0x21] != 0x54 || hdr[0x22] != 0xCD || hdr[0x23] != 0xAB)
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "ota verify failed");

    if (esp_ota_set_boot_partition(part) != ESP_OK)
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "set boot failed");

    /* 升级行为，顺序与时机都是契约：只在「已通过校验、确定要切槽重启」之后
       才重置设置（热点名 / 密码保留，见 settings.c）；上传中断或校验失败
       一律不动任何状态。控制页随固件换新，不再有独立的页面热更标记要清。 */
    settings_reset_for_upgrade();

    ESP_LOGI(TAG, "OTA done, rebooting into %s", part->label);
    httpd_resp_set_type(req, "text/plain");
    /* 页面可能从离线客户端/file:// 等跨源发起上传（固定目标 192.168.4.1），
       带上 ACAO 让浏览器能读到成功响应，否则页面会误报 net。 */
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_sendstr(req, "OK firmware, rebooting");
    vTaskDelay(pdMS_TO_TICKS(1000));
    power_restart();
    return ESP_OK;
}

/* 新固件跑稳 45s 后取消回滚。 */
static void confirm_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(OTA_CONFIRM_MS));
    esp_err_t e = esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGI(TAG, "OTA rollback cancel -> %s", esp_err_to_name(e));
    vTaskDelete(NULL);
}

void ota_web_confirm(void)
{
    xTaskCreate(confirm_task, "ota_confirm", 2048, NULL, 5, NULL);
}

/* ---- 上传入口 ---- */

/*
 * 只接受 ESP32 固件镜像。判据只能是内容魔数：页面为避开跨源预检一向把文件
 * 包成 text/plain Blob，且 Blob 不带 filename，Content-Type 与文件名都不可用。
 * ★ 改这里必须同步改 page/src/61-ota.js 的 sniffKind()：前端要用同一套规则
 *   预判，因为 OTA 成功后约 1 秒即重启，响应有可能发不出去。
 */
static esp_err_t upload_handler(httpd_req_t *req)
{
    power_activity();
    size_t total = req->content_len;
    if (total == 0)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty body");

    /* 累积到 >=64B 才判定：「首块很短」不是结论，只是 TCP 分段。
       预读的字节留在 s_buf 里，原样交给下游写入。 */
    int got = 0;
    while (got < SNIFF_MIN && (size_t)got < total) {
        int k = httpd_req_recv(req, s_buf + got, WEB_CHUNK - got);
        if (k <= 0) break;
        got += k;
    }
    if (got <= 0)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "truncated body");

    if ((uint8_t)s_buf[0] != 0xE9) {
        ESP_LOGW(TAG, "upload rejected: not an ESP32 image (first byte 0x%02x)",
                 (unsigned)(uint8_t)s_buf[0]);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST,
            "unrecognized payload: upload a .bin firmware image");
    }

    ESP_LOGI(TAG, "upload: firmware %u bytes (%d B pre-read)", (unsigned)total, got);
    return ota_stream(req, got);
}

void ota_web_register(httpd_handle_t server)
{
    httpd_uri_t up = {
        .uri = "/api/upload", .method = HTTP_POST, .handler = upload_handler, .user_ctx = NULL,
    };
    httpd_register_uri_handler(server, &up);
}
