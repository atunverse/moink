#include "ota_web.h"
#include "version.h"
#include "settings.h"

#include "nvs.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "power.h"

#include <string.h>
#include <stdlib.h>

static const char *TAG = "ota_web";

#define NVS_NS       "moink"
#define NVS_WEB_LEN  "web_len"
#define NVS_WEB_CRC  "web_crc"
#define NVS_PAGE_VER "page_ver"

#define OTA_CONFIRM_MS 45000
#define WEB_CHUNK      4096
#define SNIFF_MIN      64      /* 判定前至少攒够的字节数（TCP 首段可能很短） */

/* httpd 任务栈只有 4KB：收包缓冲一律静态共享，绝不能在栈上放大数组
   （R1.0.1 的 web handler 在栈上放了 buf[4096]+head[8192]，一进来就栈溢出断连）。 */
static char s_buf[WEB_CHUNK];
static uint8_t s_head[2048];   /* 页面头部快照：版本 meta 在 <head> 顶部，2KB 足够 */

/* 页面版本标记：index.html 头部须含 <meta name="moink-page-version" content="R1.2.0"> */
#define VER_MARKER    "moink-page-version"
#define VER_CONTENT   "content=\""

/* ---- CRC32（IEEE 802.3，poly 0xEDB88320 反射）---- */
static uint32_t crc32_update(uint32_t crc, const uint8_t *d, size_t n)
{
    crc = ~crc;
    for (size_t i = 0; i < n; i++) {
        crc ^= d[i];
        for (int b = 0; b < 8; b++) {
            crc = (crc >> 1) ^ (0xEDB88320UL & (0 - (crc & 1)));
        }
    }
    return ~crc;
}

static const esp_partition_t *find_web(void)
{
    return esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
                                    ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "web");
}

/* R1.0.8：页面有效性三态缓存（-1 未测 / 0 无效 / 1 有效），键 = (len, crc)。
   NVS 里 len/crc 是上传时记录的摘要，二者未变则 flash 内容视为未变，
   GET / 不必每次做 960KB 全分区读 + 逐位 CRC（原来每次多 100~300ms）。 */
static int s_page_ok = -1;
static uint32_t s_page_len = 0, s_page_crc = 0;

static void page_cache_invalidate(void) { s_page_ok = -1; }

/* ---- NVS 小助手（独立句柄，惰性打开）---- */
static nvs_handle_t nvs_open_rw(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return 0;
    return h;
}

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

/* ---- 路径 1：固件 OTA ---- */

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

    /* R1.2.0（FB-015）升级行为，顺序与时机都是契约：
       ① 页面随固件一起换新 —— 清除设备上的页面热更标记，新固件起来后 GET /
          直接吐内嵌新页面（原 FB-012 的 ?sync_page=1 已变成默认行为）；
       ② 强制重置设备设置，避免旧状态带病升级（热点名/密码保留，见 settings.c）。
       两者都在「已通过校验、确定要切槽重启」之后才做：上传中断 / 校验失败
       一律不动任何状态。 */
    ota_web_clear();
    settings_reset_for_upgrade();

    ESP_LOGI(TAG, "OTA done, rebooting into %s", part->label);
    httpd_resp_set_type(req, "text/plain");
    /* 页面可能从离线客户端/file:// 等跨源发起上传（固定目标 192.168.4.1），
       带上 ACAO 让浏览器能读到成功响应，否则页面会误报 net。 */
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_sendstr(req, "OK firmware, rebooting");
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
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

/* ---- 路径 2：控制页热更（写 web 分区）---- */

/* 在数据流头部扫版本标记，命中则提取 content="..." 存到 out。 */
static void extract_version(const uint8_t *head, size_t n, char *out, size_t outlen)
{
    if (outlen == 0) return;
    out[0] = '\0';

    char *tmp = malloc(n + 1);
    if (!tmp) return;
    memcpy(tmp, head, n);
    tmp[n] = '\0';

    const char *m = strstr(tmp, VER_MARKER);
    if (!m) { free(tmp); return; }
    const char *c = strstr(m, VER_CONTENT);
    if (!c) { free(tmp); return; }
    c += strlen(VER_CONTENT);

    size_t i = 0;
    while (c[i] && c[i] != '"' && i < outlen - 1) {
        out[i] = c[i];
        i++;
    }
    out[i] = '\0';
    free(tmp);
}

/* pre 语义同 ota_stream()。 */
static esp_err_t web_stream(httpd_req_t *req, int pre)
{
    power_activity();
    const esp_partition_t *part = find_web();
    if (!part)
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no web partition");

    size_t total = req->content_len;
    if (total == 0 || total > part->size)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "page too large");

    int n = pre;
    if (n == 0) {
        n = httpd_req_recv(req, s_buf, WEB_CHUNK);
        if (n <= 0)
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty body");
    }

    size_t written = 0, head_len = 0;
    uint32_t crc = 0;
    bool ok = true;
    for (;;) {
        crc = crc32_update(crc, (const uint8_t *)s_buf, (size_t)n);

        if (head_len < sizeof(s_head)) {
            size_t keep = sizeof(s_head) - head_len;
            if (keep > (size_t)n) keep = (size_t)n;
            memcpy(s_head + head_len, s_buf, keep);
            head_len += keep;
        }

        int w = write_sectors(part, written, s_buf, n);
        if (w < 0) { ok = false; break; }
        written += (size_t)w;
        if (written >= total) break;
        n = httpd_req_recv(req, s_buf, WEB_CHUNK);
        if (n <= 0) { ok = false; break; }
        power_activity();
    }

    if (!ok || written != total)
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "page write failed");

    char ver[32];
    extract_version(s_head, head_len, ver, sizeof(ver));

    nvs_handle_t h = nvs_open_rw();
    if (h) {
        nvs_set_u32(h, NVS_WEB_LEN, (uint32_t)written);
        nvs_set_u32(h, NVS_WEB_CRC, crc);
        if (ver[0]) nvs_set_str(h, NVS_PAGE_VER, ver);
        nvs_commit(h);
        nvs_close(h);
    }
    page_cache_invalidate();          /* R1.0.8：新页面上传后重新校验 */

    ESP_LOGI(TAG, "control page stored: %u bytes, crc 0x%08lx, ver '%s'",
             (unsigned)written, (unsigned long)crc, ver[0] ? ver : "?");
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_sendstr(req, "OK page");
}

/* ---- 统一入口：嗅探 + 分流 ---- */

#define KIND_UNKNOWN 0
#define KIND_FW      1
#define KIND_PAGE    2

/* 大小写不敏感的前缀比较（只用 <string.h>，不依赖 strncasecmp 的头文件归属）。 */
static bool prefix_ci(const char *s, const char *lit)
{
    for (int i = 0; lit[i]; i++) {
        char a = s[i];
        if (!a) return false;
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (a != lit[i]) return false;
    }
    return true;
}

/*
 * 按首块内容识别升级类型。
 * ★ 改这里必须同步改 page/index.html 的 sniffKind()：前端用**同一套规则**预判，
 *   因为固件 OTA 成功后 1 秒即重启，响应有可能发不出去，前端不能靠响应判类型。
 * 判据只能是内容魔数：页面为避开跨源预检一向把文件包成 text/plain Blob，
 * 且 Blob 不带 filename，Content-Type 与文件名都不可用。
 */
static int sniff_kind(const char *p, int n)
{
    if (n >= 1 && (uint8_t)p[0] == 0xE9) return KIND_FW;   /* ESP 镜像魔数 */
    for (int i = 0; i + 9 <= n; i++) {
        if (prefix_ci(p + i, "<!doctype")) return KIND_PAGE;
        if (prefix_ci(p + i, "<html"))     return KIND_PAGE;
    }
    return KIND_UNKNOWN;
}

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

    int kind = sniff_kind(s_buf, got);
    if (kind == KIND_UNKNOWN) {
        ESP_LOGW(TAG, "upload rejected: unrecognized payload (%dB head, first byte 0x%02x)",
                 got, (unsigned)(uint8_t)s_buf[0]);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST,
            "unrecognized payload: upload a .bin firmware image or the control page .html");
    }

    ESP_LOGI(TAG, "upload: %s, %u bytes (%d B pre-read)",
             (kind == KIND_FW) ? "firmware" : "control page", (unsigned)total, got);
    return (kind == KIND_FW) ? ota_stream(req, got) : web_stream(req, got);
}

/* ---- 路由与页面读取 ---- */

static esp_err_t web_clear_handler(httpd_req_t *req);

void ota_web_register(httpd_handle_t server)
{
    httpd_uri_t up = {
        .uri = "/api/upload", .method = HTTP_POST, .handler = upload_handler, .user_ctx = NULL,
    };
    httpd_uri_t wclear = {
        .uri = "/api/web/clear", .method = HTTP_POST, .handler = web_clear_handler, .user_ctx = NULL,
    };
    httpd_register_uri_handler(server, &up);
    httpd_register_uri_handler(server, &wclear);
}

void ota_web_clear(void)
{
    nvs_handle_t h = nvs_open_rw();
    if (h) {
        nvs_erase_key(h, NVS_WEB_LEN);
        nvs_erase_key(h, NVS_WEB_CRC);
        nvs_erase_key(h, NVS_PAGE_VER);
        nvs_commit(h);
        nvs_close(h);
    }
    page_cache_invalidate();          /* R1.0.8：页面已清，重新校验 */
    ESP_LOGI(TAG, "control page cleared, back to embedded page");
}

static esp_err_t web_clear_handler(httpd_req_t *req)
{
    ota_web_clear();
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_sendstr(req, "OK");
}

bool ota_web_has_page(void)
{
    /* len + CRC32 双重校验：flash 写入损坏时自动判无效，
       page_handler 回退内嵌页（自愈），不再把坏页面吐给浏览器。 */
    const esp_partition_t *part = find_web();
    if (!part) return false;

    nvs_handle_t h = nvs_open_rw();
    if (!h) return false;
    uint32_t len = 0, want = 0;
    bool ok = (nvs_get_u32(h, NVS_WEB_LEN, &len) == ESP_OK && len > 0 && len <= part->size &&
               nvs_get_u32(h, NVS_WEB_CRC, &want) == ESP_OK);
    nvs_close(h);
    if (!ok) { s_page_ok = 0; return false; }

    if (s_page_ok >= 0 && s_page_len == len && s_page_crc == want)
        return (s_page_ok == 1);        /* (len,crc) 未变 -> 沿用上次全量校验结论 */

    uint32_t calc = 0, off = 0;
    while (off < len) {
        uint32_t chunk = len - off;
        if (chunk > WEB_CHUNK) chunk = WEB_CHUNK;
        if (esp_partition_read(part, off, s_buf, chunk) != ESP_OK) return false;
        calc = crc32_update(calc, (const uint8_t *)s_buf, chunk);
        off += chunk;
    }
    if (calc != want) {
        ESP_LOGW(TAG, "control page crc mismatch (want 0x%08lx got 0x%08lx), fallback to embedded",
                 (unsigned long)want, (unsigned long)calc);
        s_page_ok = 0; s_page_len = len; s_page_crc = want;
        return false;
    }
    s_page_ok = 1; s_page_len = len; s_page_crc = want;
    return true;
}

const char *ota_web_page_version(void)
{
    static char ver[32];
    nvs_handle_t h = nvs_open_rw();
    if (h) {
        size_t need = 0;
        if (nvs_get_str(h, NVS_PAGE_VER, NULL, &need) == ESP_OK &&
            need > 0 && need <= sizeof(ver)) {
            nvs_get_str(h, NVS_PAGE_VER, ver, &need);
            nvs_close(h);
            return ver;
        }
        nvs_close(h);
    }
    return MOINK_VERSION;   /* 无上传页面 -> 内嵌页版本 */
}

esp_err_t ota_web_stream_page(httpd_req_t *req)
{
    const esp_partition_t *part = find_web();
    if (!part)
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no web partition");

    nvs_handle_t h = nvs_open_rw();
    uint32_t len = 0;
    if (!h || nvs_get_u32(h, NVS_WEB_LEN, &len) != ESP_OK || len == 0) {
        if (h) nvs_close(h);
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "no page");
    }
    nvs_close(h);

    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");

    char *buf = s_buf;
    uint32_t off = 0;
    while (off < len) {
        uint32_t chunk = len - off;
        if (chunk > WEB_CHUNK) chunk = WEB_CHUNK;
        if (esp_partition_read(part, off, buf, chunk) != ESP_OK)
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "read failed");
        if (httpd_resp_send_chunk(req, buf, chunk) != ESP_OK) return ESP_FAIL;
        off += chunk;
    }
    return httpd_resp_send_chunk(req, NULL, 0);
}
