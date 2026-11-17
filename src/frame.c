#include "frame.h"
#include "diag.h"
#include "epd_drv.h"
#include "power.h"
#include "store.h"
#include "net_fetch.h"

#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_partition.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include <string.h>
#include <stdlib.h>
#include <stdbool.h>

static const char *TAG = "frame";

/* ★★★ 2026-11-16 流式改造：删掉 120 KB 静态帧缓冲 ★★★
 *
 * 原来 s_fb_store[EPD_MAX_BUF_LEN] 占 RAM 的 36.6%（52.5% 里的一大半），
 * WiFi 起来后堆只剩 44.9 KB，而 4 条 TCP 连接要 34.6 KB —— 浏览器刷几次
 * 必然把堆榨干、网页再也打不开。调窗口只是在这个小池子里挪腾，治不了本。
 *
 * 现在帧数据落在 flash 的 "scratch" 分区（partitions.csv，128 KB）：
 *   上传 / 远程下载 —— 边收边写 flash，RAM 只用 4 KB 搬运算存；
 *   显示           —— esp_partition_mmap() 把该分区映射进地址空间，
 *                     直接把只读指针交给 epd_display_2bpp_wh()。
 * epd_write_frame_2bpp() 本来就是「逐行读 src → 行缓冲 → SPI」，所以驱动
 * 一行没改。刷屏波形要过好几遍整帧，每遍都从 flash 重读 —— 105 KB 约 3~6 ms，
 * 而单次刷屏 437 ms 起步，可以忽略。
 */

static const esp_partition_t *s_scr = NULL;   /* scratch 分区（帧临时落点） */
static esp_partition_mmap_handle_t s_scr_h = 0;
static const void *s_scr_map = NULL;
static uint32_t s_wr;                         /* 已落盘字节数 */
static uint8_t  s_io[4096] __attribute__((aligned(4)));   /* 写暂存 */
static uint32_t s_io_n;

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

/* ---------------- scratch 落点 ---------------- */

void frame_prealloc(void)
{
    if (s_scr) return;
    s_scr = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
                                     ESP_PARTITION_SUBTYPE_ANY, "scratch");
    if (!s_scr) {
        ESP_LOGE(TAG, "scratch partition MISSING — 流式刷图不可用");
        return;
    }
    ESP_LOGE(TAG, "frame sink: flash scratch @0x%06lx %lu KB, free heap %u",
             (unsigned long)s_scr->address,
             (unsigned long)(s_scr->size / 1024),
             (unsigned)esp_get_free_heap_size());
}

static void scr_unmap(void)
{
    if (!s_scr_map) return;
    esp_partition_munmap(s_scr_h);
    s_scr_map = NULL;
}

/* 把暂存块落到 flash。s_wr 在满块写入时恒为 4 KB 倍数，满足 esp_partition_write
   的 offset 对齐要求；只有最后一次（不足 4 KB）会让 s_wr 不再对齐，之后不再写。 */
static int scr_flush(void)
{
    if (!s_io_n) return 0;
    esp_err_t e = esp_partition_write(s_scr, s_wr, s_io, s_io_n);
    if (e != ESP_OK) {
        ESP_LOGE(TAG, "scratch write @%lu failed: %s",
                 (unsigned long)s_wr, esp_err_to_name(e));
        return -1;
    }
    s_wr += s_io_n;
    s_io_n = 0;
    return 0;
}

/* 映射整个 scratch（128 KB，64 KB 对齐）。映射期间不能写 flash，调用方负责配对。 */
const uint8_t *frame_blob_map(void)
{
    if (s_scr_map) return (const uint8_t *)s_scr_map;
    if (!s_scr) return NULL;
    if (esp_partition_mmap(s_scr, 0, s_scr->size, ESP_PARTITION_MMAP_DATA,
                           &s_scr_map, &s_scr_h) != ESP_OK) {
        s_scr_map = NULL;
        ESP_LOGE(TAG, "scratch mmap failed");
        return NULL;
    }
    return (const uint8_t *)s_scr_map;
}

void frame_blob_unmap(void)
{
    scr_unmap();
}

int frame_blob_begin(void)
{
    if (!s_scr || !s_fb_mutex) return -1;
    if (xSemaphoreTake(s_fb_mutex, pdMS_TO_TICKS(8000)) != pdTRUE) return -1;

    scr_unmap();                       /* 写之前必须解除映射 */
    if (esp_partition_erase_range(s_scr, 0, s_scr->size) != ESP_OK) {
        ESP_LOGE(TAG, "scratch erase failed");
        xSemaphoreGive(s_fb_mutex);
        return -1;
    }
    s_wr = 0;
    s_io_n = 0;
    return 0;
}

int frame_blob_append(const void *d, int n)
{
    const uint8_t *p = (const uint8_t *)d;
    while (n > 0) {
        uint32_t room = (uint32_t)sizeof(s_io) - s_io_n;
        uint32_t k = ((uint32_t)n < room) ? (uint32_t)n : room;
        memcpy(s_io + s_io_n, p, k);
        s_io_n += k;
        p += k;
        n -= (int)k;
        if (s_io_n == sizeof(s_io) && scr_flush() != 0) return -1;
    }
    return 0;
}

void frame_blob_abort(void)
{
    s_io_n = 0;
    s_wr = 0;
    xSemaphoreGive(s_fb_mutex);
}

uint32_t frame_blob_bytes(void)
{
    return s_wr + s_io_n;
}

int frame_blob_commit_display(uint16_t w, uint16_t h)
{
    s_fw = w;
    s_fh = h;

    int r = -1;
    if (scr_flush() == 0) {
        const uint8_t *base = frame_blob_map();
        if (base) r = epd_display_2bpp_wh(base + FRAME_HDR_LEN, w, h);
    }
    scr_unmap();
    xSemaphoreGive(s_fb_mutex);
    if (r == 0) epd_panel_deep_sleep();
    return r;
}

/* ---------------- 生命周期 ---------------- */

void frame_init(void)
{
    frame_prealloc();          /* 正常情况下 app_main 已先调过，这里兜底 */
    s_fb_mutex = xSemaphoreCreateMutex();
    s_frame_ready = xSemaphoreCreateBinary();
    s_fw = epd_profile()->w;
    s_fh = epd_profile()->h;
    ESP_LOGI(TAG, "frame sink ready (profile %ux%u)",
             (unsigned)s_fw, (unsigned)s_fh);
}

void frame_wait(void)
{
    xSemaphoreTake(s_frame_ready, portMAX_DELAY);
}

int frame_display_now(void)
{
    if (xSemaphoreTake(s_fb_mutex, portMAX_DELAY) != pdTRUE) return -1;
    scr_unmap();
    int r = -1;
    if (scr_flush() == 0) {
        const uint8_t *base = frame_blob_map();
        if (base) r = epd_display_2bpp_wh(base + FRAME_HDR_LEN, s_fw, s_fh);
    }
    scr_unmap();
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

/* ---------------- 上传 ---------------- */

esp_err_t frame_upload_handler(httpd_req_t *req)
{
    diag_req("POST /api/frame");
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

    if (frame_blob_begin() != 0) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "busy");
    }

    /* 先把 16 字节帧头写进去，载荷紧随其后（frame_blob_map 的基址即带头）。 */
    if (frame_blob_append(hdr, FRAME_HDR_LEN) != 0) {
        frame_blob_abort();
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "flash");
    }

    size_t off = 0;
    uint16_t crc = 0xFFFF;
    int err = 0;
    int f_waits = 0;
    static uint8_t rx[2048] __attribute__((aligned(4)));

    while (off < len) {
        /* ★ 必须自己卡住 len 边界：httpd_req_recv 只受「整个请求剩余长度」约束，
           save=1 时 body 后面还跟着缩略数据，一次读满 rx 会把缩略开头也吞进来
           —— 既污染 CRC 又把缩略吃掉（2026-11-16 上机：图库路径必报 CRC mismatch）。 */
        int want = (int)sizeof(rx);
        if ((size_t)want > len - off) want = (int)(len - off);
        int n = httpd_req_recv(req, (char *)rx, want);
        if (n > 0) {
            power_activity();   /* R1.0.8：传输中途不许空闲休眠 */
            crc = crc16_update(crc, rx, (size_t)n);
            if (frame_blob_append(rx, n) != 0) { err = -2; break; }
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

    if (err != 0 || crc != crc_hdr) {
        frame_blob_abort();
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST,
                                   err == -2 ? "flash write failed"
                                             : (err ? "body truncated" : "CRC mismatch"));
    }
    /* 数据落盘后立刻 flush：显示任务随后只负责 map，不再碰写指针。 */
    if (scr_flush() != 0) {
        frame_blob_abort();
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "flash");
    }

    ESP_LOGI(TAG, "frame accepted: %ux%u (%lu bytes), CRC ok",
             width, height, (unsigned long)len);

    /* R1.3.0 轮播：query 参数
       save=1           存槽并显示
       save=1&noshow=1  只存不显示（批量上传前几张，避免逐张刷屏）
       无 save           只显示不存（原行为）
       tlen=<N>         R1.3.2 缩略载荷长（网页离线预生成，随帧上传，
                        body = 帧头+帧载荷+缩略头+缩略载荷） */
    bool want_save = false, want_show = true, want_remote = false;
    uint32_t tlen = 0;
    int qlen = httpd_req_get_url_query_len(req);
    if (qlen > 0 && qlen < 64) {
        char qbuf[64], vbuf[8];
        if (httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf)) == ESP_OK) {
            if (httpd_query_key_value(qbuf, "save", vbuf, sizeof(vbuf)) == ESP_OK) {
                if (strcmp(vbuf, "1") == 0) {
                    want_save = true;
                    if (httpd_query_key_value(qbuf, "noshow", vbuf, sizeof(vbuf)) == ESP_OK &&
                        strcmp(vbuf, "1") == 0)
                        want_show = false;
                } else if (strcmp(vbuf, "remote") == 0) {
                    /* R1.4.0：存到远程（WebDAV PUT + 追加清单），不占本地槽 */
                    want_remote = true;
                    want_save = false;
                    want_show = false;
                }
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
        if ((uint32_t)req->content_len != expect) {
            frame_blob_abort();
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "size mismatch");
        }
    }

    /* 缩略先收到 RAM（最大 20 KB，仍走 malloc），随后和帧一起写 store。
       帧本身已在 flash，不再需要它驻留内存。 */
    uint8_t *thumb = NULL;
    if (want_save && tlen) {
        thumb = malloc(16u + tlen);
        if (!thumb) {
            frame_blob_abort();
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "oom");
        }
        size_t tg = 0;
        int tg_waits = 0;
        while (tg < 16u + tlen) {
            int n = httpd_req_recv(req, (char *)(thumb + tg), 16u + tlen - tg);
            if (n > 0) { tg += (size_t)n; tg_waits = 0; continue; }
            if (n == 0) {                    /* recv 超时：WiFi 慢传，短暂等待重试 */
                if (++tg_waits > 100) break;
                vTaskDelay(pdMS_TO_TICKS(10));
                continue;
            }
            break;
        }
        uint32_t tw = ((uint32_t)thumb[4] << 8) | thumb[5];
        uint32_t th = ((uint32_t)thumb[6] << 8) | thumb[7];
        uint32_t tl = ((uint32_t)thumb[8] << 24) | ((uint32_t)thumb[9] << 16) |
                      ((uint32_t)thumb[10] << 8) | thumb[11];
        /* fmt=1 2bit 缩略：几何须 4 的倍数且载荷自洽；
           fmt=2 彩色 JPEG：仅校验长度（JPEG 无几何约束） */
        int geom_ok = (thumb[2] == 1) ?
                      (tw != 0 && !(tw & 3) && tl == (tw / 4u) * th) :
                      (thumb[2] == 2);
        if (tg != 16u + tlen || thumb[0] != 0xA5 || thumb[1] != 0x5A ||
            !geom_ok || tl != tlen ||
            tl > (uint32_t)((thumb[2] == 2) ? STORE_THUMB_JPEG_MAX
                                            : STORE_THUMB_LEN)) {
            ESP_LOGW(TAG, "bad thumb: got=%u magic=%02X%02X fmt=%u "
                     "w=%lu h=%lu tl=%lu tlen=%lu", (unsigned)tg,
                     thumb[0], thumb[1], thumb[2], (unsigned long)tw,
                     (unsigned long)th, (unsigned long)tl,
                     (unsigned long)tlen);
            free(thumb);
            frame_blob_abort();
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad thumb");
        }
    }

    if (want_remote) {
        /* scratch 已映射，基址 + 16 就是载荷；net_upload_remote 直接发送。 */
        const uint8_t *base = frame_blob_map();
        int ur = base ? net_upload_remote(hdr, base + FRAME_HDR_LEN, len)
                      : NF_ERR_MEM;
        frame_blob_unmap();
        frame_blob_abort();               /* 远程路径不显示 */
        if (ur != 0) {
            ESP_LOGW(TAG, "remote upload failed: %d", ur);
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR,
                                       ur == NF_ERR_OFF ? "remote disabled"
                                                        : "remote upload failed");
        }
        httpd_resp_set_type(req, "text/plain");
        return httpd_resp_sendstr(req, "OK REMOTE");
    }

    if (want_save) {
        const uint8_t *base = frame_blob_map();
        int slot = base ? store_save_frame_from_flash(hdr, FRAME_HDR_LEN,
                                                      base + FRAME_HDR_LEN, len,
                                                      thumb, tlen)
                        : -1;
        frame_blob_unmap();
        if (thumb) free(thumb);
        if (slot == STORE_ERR_FULL) {
            frame_blob_abort();
            /* IDF 6.1 的 send_err 只认枚举，传 507 会落到 default 变成 500；
               页面 40-upload.js 靠 status===507 提示「轮播已满 8 张」。 */
            httpd_resp_set_status(req, "507 Insufficient Storage");
            httpd_resp_set_type(req, HTTPD_TYPE_TEXT);
            return httpd_resp_send(req, "carousel full: delete or clear first",
                                   HTTPD_RESP_USE_STRLEN);
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
   直接 mmap 该槽，不再经 RAM 中转。显示后送面板深睡。 */
int frame_display_slot(int slot)
{
    if (xSemaphoreTake(s_fb_mutex, pdMS_TO_TICKS(5000)) != pdTRUE) return -1;

    const esp_partition_t *sp = store_part();
    int phys = store_slot_phys(slot);
    if (!sp || phys < 0) {
        xSemaphoreGive(s_fb_mutex);
        return -1;
    }
    uint32_t off = (uint32_t)phys * STORE_SLOT_SZ;

    uint8_t hdr[16];
    if (esp_partition_read(sp, off, hdr, 16) != ESP_OK) {
        xSemaphoreGive(s_fb_mutex);
        return -1;
    }
    uint32_t len = ((uint32_t)hdr[8] << 24) | ((uint32_t)hdr[9] << 16) |
                   ((uint32_t)hdr[10] << 8) | hdr[11];
    uint16_t w = (uint16_t)((hdr[4] << 8) | hdr[5]);
    uint16_t h = (uint16_t)((hdr[6] << 8) | hdr[7]);
    if (hdr[0] != STORE_MAGIC0 || hdr[1] != STORE_MAGIC1 ||
        !epd_frame_geom_ok(w, h, len)) {
        xSemaphoreGive(s_fb_mutex);
        return -1;
    }

    const void *p = NULL;
    esp_partition_mmap_handle_t hh;
    if (esp_partition_mmap(sp, off, STORE_SLOT_SZ, ESP_PARTITION_MMAP_DATA,
                           &p, &hh) != ESP_OK) {
        ESP_LOGE(TAG, "slot %d mmap failed", slot);
        xSemaphoreGive(s_fb_mutex);
        return -1;
    }

    s_fw = w;
    s_fh = h;
    int r = epd_display_2bpp_wh((const uint8_t *)p + 16, w, h);
    esp_partition_munmap(hh);
    xSemaphoreGive(s_fb_mutex);
    if (r == 0) epd_panel_deep_sleep();
    return r;
}
