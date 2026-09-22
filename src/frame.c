#include "frame.h"
#include "epd_drv.h"
#include "power.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include <string.h>
#include <stdlib.h>

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

void frame_init(void)
{
    s_fb = malloc(EPD_MAX_BUF_LEN);
    if (!s_fb) {
        ESP_LOGE(TAG, "OOM allocating %d-byte frame buffer", EPD_MAX_BUF_LEN);
        abort();
    }
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
        req->content_len > (int)(FRAME_HDR_LEN + EPD_MAX_BUF_LEN)) {
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
    if (req->content_len != (int)(FRAME_HDR_LEN + len))
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "size mismatch");

    /* 面板类型字段（hdr[3]）仅信息性；实际面板由设置决定，不随帧切换。 */

    if (xSemaphoreTake(s_fb_mutex, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "busy");
    }

    size_t off = 0;
    uint16_t crc = 0xFFFF;
    int err = 0;
    while (off < len) {
        int n = httpd_req_recv(req, (char *)(s_fb + off), len - off);
        if (n <= 0) { err = -1; break; }
        power_activity();   /* R1.0.8：传输中途不许空闲休眠 */
        crc = crc16_update(crc, s_fb + off, (size_t)n);
        off += (size_t)n;
    }
    xSemaphoreGive(s_fb_mutex);

    if (err != 0)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "body truncated");
    if (crc != crc_hdr)
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "CRC mismatch");

    ESP_LOGI(TAG, "frame accepted: %ux%u (%lu bytes), CRC ok",
             width, height, (unsigned long)len);

    s_fw = width;                             /* 显示任务据此选写入路径 */
    s_fh = height;
    xSemaphoreGive(s_frame_ready);            /* 唤醒显示任务 */
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_sendstr(req, "OK");
}
