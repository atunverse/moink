#include "frame.h"
#include "epd_drv.h"
#include "power.h"
#include "store.h"

#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <string.h>
#include <stdlib.h>
#include <stdbool.h>

static const char *TAG = "frame";

static uint8_t *s_fb = NULL;
static SemaphoreHandle_t s_fb_mutex = NULL;
static SemaphoreHandle_t s_frame_ready = NULL;

/* 最近一次被接受的帧几何（768x552 或 A1 原生 800x600），显示时交给驱动。 */
static uint16_t s_fw = EPD_A1_W, s_fh = EPD_A1_H;

/* CRC-16/CCITT-FALSE：poly 0x1021，init 0xFFFF，无反射、无终异或。 */
static uint16_t crc16_update(uint16_t crc, const uint8_t *d, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        crc ^= (uint16_t)d[i] << 8;
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021)
                                 : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

void frame_prealloc(void)
{
    if (s_fb) return;
    s_fb = malloc(EPD_MAX_BUF_LEN);
    if (!s_fb) {
        /* 诊断（R1.3.5）：OOM 时把三个数字打全——总量够不够 / 有没有连续块 /
           历史最低水位，一眼能分清「真不够」和「被切碎」。 */
        ESP_LOGE(TAG, "OOM %d bytes: free=%u largest=%u min=%u",
                 EPD_MAX_BUF_LEN,
                 (unsigned)esp_get_free_heap_size(),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
                 (unsigned)esp_get_minimum_free_heap_size());
        abort();
    }
}

void frame_init(void)
{
    frame_prealloc();          /* 正常已在 app_main 最前面抢好，这里是兜底 */
    s_fb_mutex = xSemaphoreCreateMutex();
    s_frame_ready = xSemaphoreCreateBinary();
    s_fw = epd_profile()->w;
    s_fh = epd_profile()->h;
    ESP_LOGI(TAG, "frame buffer %d bytes ready (profile %ux%u)",
             EPD_MAX_BUF_LEN, (unsigned)s_fw, (unsigned)s_fh);
}

void frame_wait(void)
{
    xSemaphoreTake(s_frame_ready, portMAX_DELAY);
}

int frame_display_now(void)
{
    if (xSemaphoreTake(s_fb_mutex, portMAX_DELAY) != pdTRUE) return -1;
    int r = epd_display_2bpp_wh(s_fb, s_fw, s_fh);
    xSemaphoreGive(s_fb_mutex);
    if (r == 0) epd_panel_deep_sleep();
    return r;
}

/* R1.0.8：残影清理与显示/传图共用同一 SPI 与 row 缓冲，必须持同一把锁，
   否则清理期间并发传图会命令交错、画面损坏。 */
int frame_clear_cycles(int cycles)
{
    if (xSemaphoreTake(s_fb_mutex, portMAX_DELAY) != pdTRUE) return -1;
    int r = epd_clear_cycles(cycles);
    xSemaphoreGive(s_fb_mutex);
    if (r == 0) power_activity();
    return r;
}

esp_err_t frame_upload_handler(httpd_req_t *req)
{
    power_activity();   /* R1.0.8：上传期间不许空闲休眠 */
    /* R1.1.0：先按最大合法载荷粗筛（A1 原生 800x600 = 120000），细筛在读头后
       按 hdr 里的宽高做——A1 允许 768x552 与 800x600 两种帧。 */
    if (req->content_len < (int)(FRAME_HDR_LEN + 1) ||
        req->content_len > (int)(FRAME_HDR_LEN + EPD_MAX_BUF_LEN +
                                 16 + STORE_THUMB_JPEG_MAX)) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "size mismatch");
    }

    uint8_t hdr[FRAME_HDR_LEN];
    /* httpd_req_recv 单次不保证收满（TCP 分段会短读），必须循环收满 16 字节 */
    size_t got = 0;
    while (got < FRAME_HDR_LEN) {
        int n = httpd_req_recv(req, (char *)(hdr + got), FRAME_HDR_LEN - got);
        if (n <= 0) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad header");
        }
        got += (size_t)n;
    }

    if (hdr[0] != FRAME_MAGIC0 || hdr[1] != FRAME_MAGIC1)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad magic");
    if (hdr[2] != FRAME_FMT_VERSION && hdr[2] != FRAME_FMT_VERSION_NATIVE)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad version");

    uint16_t width  = (uint16_t)((hdr[4] << 8) | hdr[5]);
    uint16_t height = (uint16_t)((hdr[6] << 8) | hdr[7]);
    uint32_t len    = ((uint32_t)hdr[8] << 24) | ((uint32_t)hdr[9] << 16) |
                      ((uint32_t)hdr[10] << 8) | hdr[11];
    uint16_t crc_hdr = (uint16_t)((hdr[12] << 8) | hdr[13]);

    /* 载荷长度必须与几何自洽（4 像素/字节），且被当前画像 / A1 模式接受。 */
    if ((width & 3) || len != (uint32_t)(width / 4) * (uint32_t)height)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "len mismatch");
    if (!epd_frame_geom_ok(width, height, len))
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "unsupported geometry");
    if (req->content_len != (int)(FRAME_HDR_LEN + len) &&
        (req->content_len <= (int)(FRAME_HDR_LEN + len) ||
         req->content_len > (int)(FRAME_HDR_LEN + len + 16 +
                                  STORE_THUMB_JPEG_MAX)))
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "size mismatch");

    /* 面板类型字段（hdr[3]）仅信息性；实际面板由设置决定，不随帧切换。 */

    if (xSemaphoreTake(s_fb_mutex, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "busy");
    }

    size_t off = 0;
    uint16_t crc = 0xFFFF;
    int err = 0;
    int f_waits = 0;
    while (off < len) {
        int n = httpd_req_recv(req, (char *)(s_fb + off), len - off);
        if (n > 0) {
            power_activity();   /* R1.0.8：传输中途不许空闲休眠 */
            crc = crc16_update(crc, s_fb + off, (size_t)n);
            off += (size_t)n;
            f_waits = 0;
            continue;
        }
        if (n == 0) {                    /* recv 超时：慢传等待重试 */
            if (++f_waits > 500) { err = -1; break; }
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        err = -1;
        break;
    }

    /* 校验失败也在此释放锁；校验通过则继续持锁完成「存槽 + 触发显示」，
       保证 store_save_frame 读取的 s_fb 不会被并发上传覆盖。 */
    if (err != 0 || crc != crc_hdr) {
        xSemaphoreGive(s_fb_mutex);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST,
                                   err ? "body truncated" : "CRC mismatch");
    }

    ESP_LOGI(TAG, "frame accepted: %ux%u (%lu bytes), CRC ok",
             width, height, (unsigned long)len);

    /* R1.3.0 轮播：query 参数
       save=1           存槽并显示
       save=1&noshow=1  只存不显示（批量上传前几张，避免逐张刷屏）
       无 save           只显示不存（原行为）
       tlen=<N>         R1.3.2 缩略载荷长（网页离线预生成，随帧上传，
                        body = 帧头+帧载荷+缩略头+缩略载荷） */
    bool want_save = false, want_show = true;
    uint32_t tlen = 0;
    int qlen = httpd_req_get_url_query_len(req);
    if (qlen > 0 && qlen < 64) {
        char qbuf[64], vbuf[8];
        if (httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf)) == ESP_OK) {
            if (httpd_query_key_value(qbuf, "save", vbuf, sizeof(vbuf)) == ESP_OK &&
                strcmp(vbuf, "1") == 0) {
                want_save = true;
                if (httpd_query_key_value(qbuf, "noshow", vbuf, sizeof(vbuf)) == ESP_OK &&
                    strcmp(vbuf, "1") == 0)
                    want_show = false;
            }
            if (httpd_query_key_value(qbuf, "tlen", vbuf, sizeof(vbuf)) == ESP_OK) {
                long tl = atol(vbuf);
                /* R1.3.4 修复：上限用 STORE_THUMB_JPEG_MAX（彩色 JPEG 可达 ~15KB），
                   旧值 STORE_THUMB_LEN(7500) 会把 >7.5KB 的 JPEG 缩略静默拒收
                   → 图库回退 2bit 色块（"部分图成功部分失败"根因）。 */
                if (tl > 0 && tl <= (long)STORE_THUMB_JPEG_MAX) tlen = (uint32_t)tl;
            }
        }
    }
    /* 精确校验：body 长度必须等于 帧头+帧载荷 [+缩略头+缩略载荷] */
    if (want_save && tlen) {
        uint32_t expect = (uint32_t)(FRAME_HDR_LEN + len) + 16u + tlen;
        if ((uint32_t)req->content_len != expect)
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "size mismatch");
    }
    if (want_save) {
        /* 收缩略数据：16B 缩略头（同构帧头，magic 0xA5 0x5A）+ tlen 载荷。
           CRC 字段前端填 0，固件不校验；几何按头内字段自洽。 */
        uint8_t *thumb = NULL;
        if (tlen) {
            uint8_t thdr[16];
            size_t tg = 0;
            int tg_waits = 0;
            while (tg < sizeof(thdr)) {
                int n = httpd_req_recv(req, (char *)(thdr + tg),
                                       sizeof(thdr) - tg);
                if (n > 0) { tg += (size_t)n; tg_waits = 0; continue; }
                if (n == 0) {            /* recv 超时：WiFi 慢传，短暂等待重试 */
                    if (++tg_waits > 100) break;
                    vTaskDelay(pdMS_TO_TICKS(10));
                    continue;
                }
                break;
            }
            uint32_t tw = ((uint32_t)thdr[4] << 8) | thdr[5];
            uint32_t th = ((uint32_t)thdr[6] << 8) | thdr[7];
            uint32_t tl = ((uint32_t)thdr[8] << 24) | ((uint32_t)thdr[9] << 16) |
                          ((uint32_t)thdr[10] << 8) | thdr[11];
            /* fmt=1 2bit 缩略：几何须 4 的倍数且载荷自洽；
               fmt=2 彩色 JPEG：仅校验长度（JPEG 无几何约束） */
            int geom_ok = (thdr[2] == 1) ?
                          (tw != 0 && !(tw & 3) && tl == (tw / 4u) * th) :
                          (thdr[2] == 2);
            if (tg != sizeof(thdr) || thdr[0] != 0xA5 || thdr[1] != 0x5A ||
                !geom_ok || tl != tlen ||
                tl > (uint32_t)((thdr[2] == 2) ? STORE_THUMB_JPEG_MAX
                                                : STORE_THUMB_LEN)) {
                ESP_LOGW(TAG, "bad thumb: got=%u magic=%02X%02X fmt=%u "
                         "w=%lu h=%lu tl=%lu tlen=%lu", (unsigned)tg,
                         thdr[0], thdr[1], thdr[2], (unsigned long)tw,
                         (unsigned long)th, (unsigned long)tl,
                         (unsigned long)tlen);
                return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST,
                                           "bad thumb");
            }
            thumb = malloc(16u + tlen);
            if (!thumb) {
                xSemaphoreGive(s_fb_mutex);
                return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR,
                                           "oom");
            }
            memcpy(thumb, thdr, 16);
            size_t to = 0;
            int to_waits = 0;
            while (to < tlen) {
                int n = httpd_req_recv(req, (char *)(thumb + 16 + to),
                                       tlen - to);
                if (n > 0) { to += (size_t)n; to_waits = 0; continue; }
                if (n == 0) {
                    if (++to_waits > 100) break;
                    vTaskDelay(pdMS_TO_TICKS(10));
                    continue;
                }
                break;
            }
            if (to != tlen) {
                ESP_LOGW(TAG, "thumb truncated: got=%u want=%lu",
                         (unsigned)to, (unsigned long)tlen);
                free(thumb);
                xSemaphoreGive(s_fb_mutex);
                return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST,
                                           "thumb truncated");
            }
        }
        int slot = store_save_frame(hdr, FRAME_HDR_LEN, s_fb, len,
                                    thumb, tlen);
        if (thumb) free(thumb);
        if (slot == STORE_ERR_FULL) {
            xSemaphoreGive(s_fb_mutex);
            return httpd_resp_send_err(req, 507,
                                       "carousel full: delete or clear first");
        }
        if (slot < 0)
            ESP_LOGW(TAG, "carousel save failed (store unavailable?)");
        else
            ESP_LOGI(TAG, "carousel: saved to slot %d%s", slot,
                     tlen ? " (with thumb)" : "");
    }
    if (want_show) {
        s_fw = width;                             /* 显示任务据此选写入路径 */
        s_fh = height;
    }
    xSemaphoreGive(s_fb_mutex);
    if (want_show) xSemaphoreGive(s_frame_ready); /* 唤醒显示任务 */

    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_sendstr(req, "OK");
}

/* R1.3.0 轮播切图：读 store 槽 -> 校验几何 -> 整屏显示。
   与传图 / 残影清理共用帧缓冲锁，显示后送面板深睡。 */
int frame_display_slot(int slot)
{
    if (xSemaphoreTake(s_fb_mutex, pdMS_TO_TICKS(5000)) != pdTRUE) return -1;

    int n = store_load_slot(slot, s_fb, EPD_MAX_BUF_LEN);
    if (n < 16) {
        xSemaphoreGive(s_fb_mutex);
        return -1;
    }
    uint16_t w = (uint16_t)((s_fb[4] << 8) | s_fb[5]);
    uint16_t h = (uint16_t)((s_fb[6] << 8) | s_fb[7]);
    if (!epd_frame_geom_ok(w, h, (uint32_t)(n - 16))) {
        xSemaphoreGive(s_fb_mutex);
        return -1;
    }
    s_fw = w;
    s_fh = h;
    int r = epd_display_2bpp_wh(s_fb + 16, w, h);
    xSemaphoreGive(s_fb_mutex);
    if (r == 0) epd_panel_deep_sleep();
    return r;
}
