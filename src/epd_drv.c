/*
 * JDY79668 四色电子墨水屏驱动（华为 nova14 拆机屏）。
 * 从社区 InkSight 适配移植：epd_driver.cpp (EPD_PANEL_75_JDY79668)
 * 与 屏幕修改适配驱动/epd7in3g-A0.cpp。序列保持 1:1：
 *   init:  RST 脉冲 -> 等 BUSY -> PSR(0x00 0x0B) -> TRES(w x h)
 *          -> PWR_ON(0x04) -> 等 BUSY
 *   frame: 逐行 0x83 部分窗（隔行半屏 Y 映射）+ 0x10 数据，
 *          行自下而上、列倒序、字节内 2bit 组亦倒
 *   refresh: 0x12 0x00 -> 等 BUSY（最长 45 s）
 *   power off: 0x02 0x00 -> 等 BUSY
 *   deep sleep: 0x07 0xA5
 * BUSY 低有效。
 *
 * A0 (768x552) 已在真机验证。800x600 社区 A1 画像旧项目 M6 已移除。
 *
 * A1 (a1_mode 决定 768x552 或 800x600) 是第二套社区适配——InkSight_adapt_HUAWEI_eink
 *（华为手机壳 A1 版本，EPD_PANEL_38_JD79665_BWRY）。与 A0 同物理玻璃、同可见区
 *（768x552），但控制器握手不同：更长的初始化块（0xAA 解锁、0x01 驱动输出、
 * 0x65/0x84 级联设置）。它还需要长得多的 BUSY 窗口（180 s），且 0x12 后 BUSY
 * 在 250 ms 内又落下时补一个固定 14 s 等待——该屏已知会在 0x12 后假释 BUSY。
 *
 * R1.1.0（FB-010）：A1 弃用「整窗 + 顺序线性写」（R1.0.8–R1.0.11 的做法，真机
 * 表现为纵向条纹 + 左右镜像）。
 * R1.1.2（FB-013）：真机定案可见区恒 768x552、栅极顺序寻址 ⇒ 默认档改为
 * 「768x552 顺序直写」；旧的「两 bank 交错」模型与交错映射路径整体删除。
 * R1.2.0（FB-015）：删除 A1.1 诊断变体与专属画像，A1.1 批次屏直接选 A1。
 */
#include "epd_drv.h"

#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "epd";

#define SPI_HZ        4000000   /* 保守值；整帧写入约 0.25 s */
#define BUSY_TIMEOUT_REFRESH_MS 45000
#define BUSY_TIMEOUT_INIT_MS    10000
#define BUSY_TIMEOUT_LONG_MS    180000  /* A1：这块屏很慢 */
/* 行缓冲按最宽的合法帧分配：A1 原生 800 宽 -> 200 字节；768 宽的行只需 192。 */
#define MAX_ROW_BYTES (EPD_A1N_W / 4)  /* 200 */

const epd_profile_t EPD_PROFILES[EPD_PANEL_COUNT] = {
    [EPD_PANEL_A0] = { EPD_A0_W, EPD_A0_H, EPD_A0_W / 4 * EPD_A0_H, -1, 0 },
    [EPD_PANEL_A1] = { EPD_A1_W, EPD_A1_H, EPD_A1_W / 4 * EPD_A1_H,  0, 1 },
};

/* A1 原生画像：a1_mode 2（对照档）时帧与 TRES 都是 800x600（120000 字节）。 */
static const epd_profile_t A1_NATIVE_PROF =
    { EPD_A1N_W, EPD_A1N_H, EPD_A1N_W / 4 * EPD_A1N_H, 0, 1 };

static const epd_profile_t *s_prof = &EPD_PROFILES[EPD_PANEL_A0];
static epd_panel_t s_panel = EPD_PANEL_A0;
static int8_t s_lower_y_base = -1;
static bool s_hflip = false;
static uint8_t s_a1_mode = EPD_A1_MODE_DEFAULT;   /* A1 驱动模式 1..2，见 epd_drv.h */
static spi_device_handle_t s_spi;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/* ---- profile ---- */

/* 依「画像 + A1 模式」选活动画像：A1 的 800x600 对照档换成 A1_NATIVE_PROF。 */
static void profile_apply(void)
{
    if (s_panel == EPD_PANEL_A1 && s_a1_mode == EPD_A1_MODE_NATIVE800) {
        s_prof = &A1_NATIVE_PROF;
    } else {
        s_prof = &EPD_PROFILES[s_panel];
    }
    s_lower_y_base = s_prof->lower_y_base;
}

int epd_set_panel(epd_panel_t panel)
{
    if (panel < 0 || panel >= EPD_PANEL_COUNT) return -1;
    s_panel = panel;
    profile_apply();
    ESP_LOGI(TAG, "panel profile: %s %ux%u, %lu bytes/frame, %s",
             epd_panel_name(panel),
             (unsigned)s_prof->w, (unsigned)s_prof->h,
             (unsigned long)s_prof->buf_len,
             s_prof->linear ? "linear write" : "interleaved write");
    return 0;
}

const char *epd_panel_name(epd_panel_t panel)
{
    switch (panel) {
    case EPD_PANEL_A0:  return "A0";
    case EPD_PANEL_A1:  return "A1";
    default:            return "?";
    }
}

/*
 * 本帧的面板侧几何（TRES / 整窗 / 刷新区间都用它）。由「画像 + A1 模式 +
 * 本帧几何」共同决定，每次显示前由 prepare_geom() 算好——同一份固件因此
 * 既能收 768x552 帧，也能收 A1 原生 800x600 帧。
 */
static int s_out_w = EPD_MAX_W;
static int s_out_h = EPD_MAX_H;

static void prepare_geom(uint16_t fw, uint16_t fh)
{
    (void)fh;
    if (s_panel == EPD_PANEL_A1) {
        /* FB-013 真机定案：可见区恒 768x552，TRES / 刷新窗口恒 768x600
           （多扫的 48 条栅极落在不可见边框区）。768x552 帧 1:1 落在栅极
           0..551（默认档）；800x600 帧多出的 32 列 / 48 行落进备用源线与
           备用栅极（= 被裁切，对照档）。 */
        s_out_w = (fw >= EPD_A1N_W) ? EPD_A1N_W : EPD_A1_W;
        s_out_h = EPD_A1N_H;
    } else {
        s_out_w = EPD_PROFILES[EPD_PANEL_A0].w;
        s_out_h = EPD_PROFILES[EPD_PANEL_A0].h;
    }
    ESP_LOGD(TAG, "geom: frame %ux%u -> panel %dx%d", (unsigned)fw, (unsigned)fh,
             s_out_w, s_out_h);
}

/* A1 驱动模式的显示名（日志用）。 */
static const char *a1_mode_name(uint8_t v)
{
    switch (v) {
    case EPD_A1_MODE_SEQ552:    return "seq 768x552 (default, 1:1 filled)";
    case EPD_A1_MODE_NATIVE800: return "native 800x600 (cropped)";
    default:                     return "?";
    }
}

void epd_set_a1_mode(uint8_t v)
{
    /* 越界值回落到默认档。 */
    if (v < EPD_A1_MODE_SEQ552 || v > EPD_A1_MODE_NATIVE800) v = EPD_A1_MODE_DEFAULT;
    if (v == s_a1_mode) return;
    s_a1_mode = v;
    if (s_panel == EPD_PANEL_A1) profile_apply();
    ESP_LOGI(TAG, "A1 drive mode = %u (%s)", (unsigned)v, a1_mode_name(v));
}

uint8_t epd_get_a1_mode(void) { return s_a1_mode; }

epd_panel_t epd_get_panel(void) { return s_panel; }

const epd_profile_t *epd_profile(void) { return s_prof; }

void epd_set_hflip(bool on)
{
    /* 该覆盖只对线性 A1 控制器有意义（A0 的 180° 缓冲契约已含镜像，再翻即颠倒）。
     * 生效范围：2 NATIVE800 对照档（勾上 = 整行镜像，真机正向）。
     * 1 SEQ552 默认档行内固定整行镜像，不读本开关。 */
    if (!s_prof->linear) on = false;
    s_hflip = on;
    ESP_LOGI(TAG, "horizontal flip = %d", (int)on);
}

bool epd_get_hflip(void) { return s_hflip; }

/* ---- low level ---- */

static esp_err_t spi_tx(const uint8_t *data, size_t len)
{
    spi_transaction_t t = {
        .length = len * 8,
        .tx_buffer = data,
    };
    return spi_device_polling_transmit(s_spi, &t);
}

/* 命令字节（DC 低），可选数据字节（DC 高），CS 手动。 */
static esp_err_t epd_cmd(uint8_t cmd, const uint8_t *data, size_t len)
{
    esp_err_t err;
    gpio_set_level(EPD_PIN_DC, 0);
    gpio_set_level(EPD_PIN_CS, 0);
    err = spi_tx(&cmd, 1);
    if (err == ESP_OK && len > 0) {
        gpio_set_level(EPD_PIN_DC, 1);
        err = spi_tx(data, len);
    }
    gpio_set_level(EPD_PIN_CS, 1);
    return err;
}

static void epd_reset(void)
{
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(EPD_PIN_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(40));
    gpio_set_level(EPD_PIN_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(50));
}

static int epd_wait_busy(uint32_t timeout_ms)
{
    int64_t t0 = now_ms();
    while (gpio_get_level(EPD_PIN_BUSY) == 0) {   /* LOW = 忙 */
        vTaskDelay(pdMS_TO_TICKS(10));
        if (now_ms() - t0 > (int64_t)timeout_ms) {
            ESP_LOGE(TAG, "BUSY timeout (%lu ms), BUSY=%d",
                     (unsigned long)timeout_ms, gpio_get_level(EPD_PIN_BUSY));
            return -1;
        }
    }
    return 0;
}

/* ---- panel commands ---- */

/* 部分窗设置，与参考驱动完全一致。 */
static void epd_set_window(int width, int ys, int ye)
{
    uint8_t d[9] = {
        0x00, 0x00,
        (uint8_t)(((width - 1) >> 8) & 0xFF), (uint8_t)((width - 1) & 0xFF),
        (uint8_t)((ys >> 8) & 0xFF), (uint8_t)(ys & 0xFF),
        (uint8_t)((ye >> 8) & 0xFF), (uint8_t)(ye & 0xFF),
        0x01,
    };
    epd_cmd(0x83, d, sizeof(d));
}

/* 长 A1 初始化块辅助宏（命令 + N 数据字节）。 */
#define EPD_C1(c, a)      do { uint8_t d[1] = { (a) }; epd_cmd((c), d, 1); } while (0)
#define EPD_C2(c, a, b)   do { uint8_t d[2] = { (a), (b) }; epd_cmd((c), d, 2); } while (0)
#define EPD_C3(c, a, b, e) do { uint8_t d[3] = { (a), (b), (e) }; epd_cmd((c), d, 3); } while (0)
#define EPD_C4(c, a, b, e, f) do { uint8_t d[4] = { (a), (b), (e), (f) }; \
                                   epd_cmd((c), d, 4); } while (0)
#define EPD_C6(c, a, b, e, f, g, i) do { uint8_t d[6] = { (a),(b),(e),(f),(g),(i) }; \
                                         epd_cmd((c), d, 6); } while (0)

/*
 * A1 初始化，1:1 移植自 InkSight 华为 A1 适配（EPD_PANEL_38_JD79665_BWRY）。
 * 顺序不可乱：0xAA 解锁扩展寄存器，0x65/0x84 配置级联，0x83 必须在 0x04 上电前布防。
 */
static void epd_panel_init_a1(void)
{
    epd_reset();
    epd_wait_busy(BUSY_TIMEOUT_LONG_MS);
    vTaskDelay(pdMS_TO_TICKS(30));

    EPD_C6(0xAA, 0x49, 0x55, 0x20, 0x08, 0x09, 0x18);
    EPD_C1(0x01, 0x3F);                 /* 驱动输出控制 */
    EPD_C2(0x00, 0x4B, 0x69);           /* PSR */
    EPD_C4(0x05, 0x40, 0x1F, 0x1F, 0x2C);
    EPD_C4(0x08, 0x6F, 0x1F, 0x1F, 0x22);
    EPD_C4(0x06, 0x6F, 0x1F, 0x14, 0x14);
    EPD_C4(0x03, 0x00, 0x54, 0x00, 0x44);
    EPD_C2(0x60, 0x02, 0x00);           /* TCON */
    EPD_C1(0x30, 0x08);                 /* PLL */
    EPD_C1(0x50, 0x3F);                 /* VCOM */

    int h_active = s_out_h;             /* prepare_geom() 定：A1 恒 600 条栅极 */
    int tres_w = s_out_w;               /* 768（交错帧）或 800（原生帧） */
    uint8_t tres[4] = { (uint8_t)(tres_w >> 8), (uint8_t)(tres_w & 0xFF),
                        (uint8_t)(h_active >> 8), (uint8_t)(h_active & 0xFF) };
    epd_cmd(0x61, tres, 4);             /* TRES */

    EPD_C4(0x65, 0x10, 0x00, 0x20, 0x00);
    EPD_C1(0xE3, 0x2F);
    EPD_C1(0x84, 0x01);                 /* 级联配置 */
    epd_set_window(tres_w, 0, h_active - 1);
    epd_cmd(0x04, NULL, 0);             /* 上电 */
    epd_wait_busy(BUSY_TIMEOUT_LONG_MS);
}

static int epd_panel_init(void)
{
    uint8_t psr[1]  = { 0x0B };
    uint8_t tres[4] = { (uint8_t)(s_prof->w >> 8), (uint8_t)(s_prof->w & 0xFF),
                        (uint8_t)(s_prof->h >> 8), (uint8_t)(s_prof->h & 0xFF) };
    uint8_t z = 0x00;

    epd_reset();
    if (epd_wait_busy(BUSY_TIMEOUT_INIT_MS) != 0) return -1;
    vTaskDelay(pdMS_TO_TICKS(30));

    if (s_prof->linear) {
        epd_panel_init_a1();
        return 0;
    }

    epd_cmd(0x00, psr, 1);        /* PSR */
    epd_cmd(0x61, tres, 4);       /* TRES w x h */
    epd_cmd(0x04, &z, 0);         /* 上电 */
    if (epd_wait_busy(BUSY_TIMEOUT_REFRESH_MS) != 0) return -1;
    return 0;
}

/*
 * 写入一帧 2bpp。1:1 移植自 epdWriteMapped2bpp()：
 *  - 行 j = H-1 .. 0，源行 = H-1-j（缓冲自下而上存储）
 *  - 窗 Y：上半 j*2，下半 2*(H-j) + lower_y_base
 *    （A0 用 base -1 -> 2*(H-j)-1 已验证）
 *  - 列倒序发送，字节内 2bit 组倒序
 * 越界窗 Y 值被夹进 0..H-1，A1 标定错时也优雅降级而非写越界。
 */
/* 字节倒序 + 字节内 4 个 2bit 组倒序（180° 翻转）。 */
static void row_mirror(uint8_t *dst, const uint8_t *src, int row_bytes, bool flip)
{
    for (int i = 0; i < row_bytes; i++) {
        uint8_t s = src[row_bytes - 1 - i];
        dst[i] = flip ? s
                      : (((s & 0x03) << 6) | ((s & 0x0C) << 2) |
                         ((s & 0x30) >> 2) | ((s & 0xC0) >> 6));
    }
}

/*
 * A1 批次的行内变换（只给 2 NATIVE800 对照档用）：FB-013 真机对照确认，
 * 勾「左右镜像」走整行镜像才正向 —— 即 A1 源线顺序与 A0 **同向**，
 * 行内需要整行镜像（FB-010 的"不作变换才正向"结论已被真机推翻）。
 * 1 SEQ552 默认档不走这里：它在自己的写入函数里固定整行镜像。
 */
static void row_a1(uint8_t *dst, const uint8_t *src, int row_bytes)
{
    if (s_hflip) {
        row_mirror(dst, src, row_bytes, false);
        return;
    }
    memcpy(dst, src, row_bytes);
}

/*
 * A1 顺序直写 · 原生 800x600（a1_mode 2 = 对照档）：一个整窗，逐行自上而下
 * 1:1 直写，栅极号 = 行号。帧行自下而上存储（180° 契约），故面板第 j 行取
 * 缓冲第 fh-1-j 行。本屏可见区恒 768x552（FB-013 真机定案），此档多出的
 * 右 32 列 / 下 48 行落进备用源线与备用栅极 = 被裁掉，仅作对照。
 */
static int epd_write_frame_a1_seq(const uint8_t *buf, int fw, int fh)
{
    static uint8_t row[MAX_ROW_BYTES];
    const int RB = fw / 4;
    uint8_t z = 0x00;

    epd_cmd(0x04, &z, 0);                       /* 上电（同参考驱动顺序） */
    if (epd_wait_busy(BUSY_TIMEOUT_REFRESH_MS) != 0) return -1;

    epd_set_window(fw, 0, fh - 1);
    epd_cmd(0x10, NULL, 0);                     /* 写 RAM */

    gpio_set_level(EPD_PIN_DC, 1);
    gpio_set_level(EPD_PIN_CS, 0);
    esp_err_t err = ESP_OK;
    for (int j = 0; j < fh && err == ESP_OK; j++) {
        row_a1(row, buf + (size_t)(fh - 1 - j) * RB, RB);
        err = spi_tx(row, RB);
    }
    gpio_set_level(EPD_PIN_CS, 1);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "SPI tx failed: %s", esp_err_to_name(err));
        return -1;
    }
    return 0;
}

/*
 * A1 顺序直写 · 552（a1_mode 1 = ★默认正解，FB-013）：
 * 帧 768x552 -> 写入窗口 (0..767, 0..551) -> 单次 0x10 连发 552 行 x 192 B，
 * 栅极号 = 行号（顺序 0..551）。与 2 NATIVE800 共用同一套已被真机验证可用的
 * 写入路径（整窗 + 单次 0x10 + 整帧 CS 包络），只把几何换成可见区尺寸，
 * 因此 1:1 落在 552 条可见栅极上：不裁切、不重采样、无白边。
 *
 * 行内固定整行镜像：真机对照确认这块屏只有镜像后才正向（与 A0 同向）。
 * 本档不读 s_hflip ——「左右镜像」勾选框只保留给 2 NATIVE800 对照档。
 */
static int epd_write_frame_a1_seq552(const uint8_t *buf)
{
    static uint8_t row[MAX_ROW_BYTES];
    const int W = EPD_A1_W, H = EPD_A1_H, RB = EPD_A1_W / 4;   /* 768 / 552 / 192 */
    uint8_t z = 0x00;

    epd_cmd(0x04, &z, 0);                       /* 上电（同参考驱动顺序） */
    if (epd_wait_busy(BUSY_TIMEOUT_REFRESH_MS) != 0) return -1;

    epd_set_window(W, 0, H - 1);                /* 窗口 (0..767, 0..551) */
    epd_cmd(0x10, NULL, 0);                     /* 写 RAM */

    gpio_set_level(EPD_PIN_DC, 1);
    gpio_set_level(EPD_PIN_CS, 0);
    esp_err_t err = ESP_OK;
    for (int j = 0; j < H && err == ESP_OK; j++) {
        /* 缓冲自下而上存储（180° 契约）：面板第 j 行取缓冲第 H-1-j 行。 */
        row_mirror(row, buf + (size_t)(H - 1 - j) * RB, RB, false);
        err = spi_tx(row, RB);
    }
    gpio_set_level(EPD_PIN_CS, 1);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "SPI tx failed: %s", esp_err_to_name(err));
        return -1;
    }
    return 0;
}

/*
 * 整帧写入面板 RAM。
 *
 * 必须每次都写整帧：只写变化行会让其余 RAM 保持控制器上电时的内容，
 * 下次刷新就在整块玻璃上变成随机噪点。4 MHz 下整帧约 0.25 s，不值得裁剪。
 */
static int epd_write_frame_2bpp(const uint8_t *buf)
{
    static uint8_t row[MAX_ROW_BYTES];
    const int W = s_prof->w, H = s_prof->h, row_bytes = s_prof->w / 4;
    uint8_t z = 0x00;

    epd_cmd(0x04, &z, 0);                       /* 上电（同参考） */
    if (epd_wait_busy(BUSY_TIMEOUT_REFRESH_MS) != 0) return -1;

    if (s_prof->linear) {
        /* 按「本帧几何」而非模式选路径：
           800x600 帧走对照档，768x552 帧走默认正解档。 */
        if (s_out_w >= EPD_A1N_W)
            return epd_write_frame_a1_seq(buf, EPD_A1N_W, EPD_A1N_H);
        return epd_write_frame_a1_seq552(buf);
    }

    for (int j = 0; j < H; j++) {
        int flippedY = H - 1 - j;
        const uint8_t *src = buf + (size_t)flippedY * row_bytes;
        int ys = (j < H / 2) ? (j * 2)
                             : (2 * (H - j) + s_lower_y_base);
        if (ys < 0) ys = 0;
        if (ys > H - 1) ys = H - 1;

        epd_set_window(W, ys, ys);
        epd_cmd(0x10, &z, 0);                   /* 写 RAM */

        row_mirror(row, src, row_bytes, s_hflip);
        gpio_set_level(EPD_PIN_DC, 1);
        gpio_set_level(EPD_PIN_CS, 0);
        esp_err_t err = spi_tx(row, row_bytes);
        gpio_set_level(EPD_PIN_CS, 1);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "SPI tx failed: %s", esp_err_to_name(err));
            return -1;
        }
    }

    /* epd_cycle() 紧随其后把 0x12 窗开到整屏。 */
    return 0;
}

static int epd_refresh(void)
{
    uint8_t z = 0x00;

    if (s_prof->linear) {
        /* A1 屏已知会在 0x12 后几百 ms 内再次释放 BUSY；参考驱动退回固定 14 s 等待。 */
        epd_cmd(0x12, &z, 1);
        int64_t t0 = now_ms();
        int ok = epd_wait_busy(BUSY_TIMEOUT_LONG_MS);
        int64_t elapsed = now_ms() - t0;
        if (ok != 0) {
            ESP_LOGE(TAG, "A1 refresh BUSY timeout after %lld ms", (long long)elapsed);
            return -1;
        }
        if (elapsed < 250) {
            ESP_LOGW(TAG, "A1 BUSY released after only %lld ms, fallback wait",
                     (long long)elapsed);
            vTaskDelay(pdMS_TO_TICKS(14000));
        } else {
            vTaskDelay(pdMS_TO_TICKS(500));
        }
        return 0;
    }

    epd_cmd(0x12, &z, 1);
    return epd_wait_busy(BUSY_TIMEOUT_REFRESH_MS);
}

static int epd_power_off(void)
{
    uint8_t z = 0x00;
    epd_cmd(0x02, &z, 1);
    return epd_wait_busy(BUSY_TIMEOUT_REFRESH_MS);
}

void epd_panel_deep_sleep(void)
{
    uint8_t z = 0xA5;
    epd_cmd(0x07, &z, 1);
    vTaskDelay(pdMS_TO_TICKS(200));
}

/* ---- public API ---- */

int epd_init(void)
{
    gpio_config_t out = {
        .pin_bit_mask = (1ULL << EPD_PIN_CS) | (1ULL << EPD_PIN_DC) |
                        (1ULL << EPD_PIN_RST),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&out));
    gpio_set_level(EPD_PIN_RST, 1);
    gpio_set_level(EPD_PIN_CS, 1);
    gpio_set_level(EPD_PIN_DC, 0);

    gpio_config_t in = {
        .pin_bit_mask = (1ULL << EPD_PIN_BUSY),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&in));

    spi_bus_config_t bus = {
        .mosi_io_num = EPD_PIN_MOSI,
        .miso_io_num = -1,
        .sclk_io_num = EPD_PIN_SCK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 4096,
    };
    esp_err_t err = spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi_bus_initialize: %s", esp_err_to_name(err));
        return -1;
    }

    spi_device_interface_config_t dev = {
        .clock_speed_hz = SPI_HZ,
        .mode = 0,
        .spics_io_num = -1,          /* CS 手动驱动 */
        .queue_size = 1,
    };
    err = spi_bus_add_device(SPI2_HOST, &dev, &s_spi);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi_bus_add_device: %s", esp_err_to_name(err));
        return -1;
    }

    ESP_LOGI(TAG, "EPD ready: SPI2 %d Hz, SCK=%d MOSI=%d CS=%d DC=%d RST=%d BUSY=%d",
             SPI_HZ, EPD_PIN_SCK, EPD_PIN_MOSI, EPD_PIN_CS,
             EPD_PIN_DC, EPD_PIN_RST, EPD_PIN_BUSY);
    return 0;
}

/*
 * 一次显示周期：面板初始化 -> 整 RAM 写入 -> 0x12 -> 断电。
 * 无部分刷新路径。本屏两半隔行，逻辑行区间会散到零散的面板行上，
 * 控制器最终还是整块玻璃刷新；每次整 RAM 写入也保证玻璃内容正好等于所持帧。
 */
static int epd_cycle(const uint8_t *frame)
{
    for (int attempt = 0; attempt < 3; attempt++) {
        int64_t t0;
        ESP_LOGI(TAG, "display attempt %d/3 (BUSY=%d)", attempt + 1,
                 gpio_get_level(EPD_PIN_BUSY));

        if (epd_panel_init() != 0) continue;

        t0 = now_ms();
        if (epd_write_frame_2bpp(frame) != 0) continue;
        ESP_LOGI(TAG, "frame written in %lld ms", (long long)(now_ms() - t0));

        epd_set_window(s_out_w, 0, s_out_h - 1);

        t0 = now_ms();
        if (epd_refresh() != 0) continue;
        ESP_LOGI(TAG, "refresh done in %lld ms", (long long)(now_ms() - t0));

        epd_power_off();
        return 0;
    }
    ESP_LOGE(TAG, "display failed after 3 attempts");
    return -1;
}

int epd_display_2bpp_wh(const uint8_t *frame, uint16_t w, uint16_t h)
{
    prepare_geom(w, h);
    ESP_LOGI(TAG, "display %ux%u -> panel %dx%d, A1 mode %u",
             (unsigned)w, (unsigned)h, s_out_w, s_out_h, (unsigned)s_a1_mode);
    return epd_cycle(frame);
}

int epd_display_2bpp(const uint8_t *frame)
{
    return epd_display_2bpp_wh(frame, s_prof->w, s_prof->h);
}

/*
 * 帧几何校验：A0 只认自身画像尺寸；A1 两种几何都收
 * （768x552 = 默认档 SEQ552，800x600 = 对照档 NATIVE800）。
 */
bool epd_frame_geom_ok(uint16_t w, uint16_t h, uint32_t len)
{
    if (w == s_prof->w && h == s_prof->h && len == s_prof->buf_len) return true;
    if (s_panel != EPD_PANEL_A1) return false;
    if (w == EPD_A1_W && h == EPD_A1_H &&
        len == (uint32_t)(EPD_A1_W / 4) * EPD_A1_H) return true;
    if (w == EPD_A1N_W && h == EPD_A1N_H &&
        len == (uint32_t)(EPD_A1N_W / 4) * EPD_A1N_H) return true;
    return false;
}

int epd_clear_cycles(int cycles)
{
    static uint8_t row[MAX_ROW_BYTES];
    const int H = s_prof->h, row_bytes = s_prof->w / 4;
    if (cycles < 1) cycles = 1;
    if (cycles > 4) cycles = 4;

    /* 清理没有帧几何可参考：A1 按控制器原生 800x600 清整屏（覆盖全部栅极），
       其余画像按自身尺寸。 */
    prepare_geom((s_panel == EPD_PANEL_A1) ? EPD_A1N_W : s_prof->w, s_prof->h);

    for (int c = 0; c < cycles; c++) {
        /* 黑/白交替，两种色素极端都得到锻炼 */
        uint8_t col = (c % 2 == 0) ? 0x00 : 0x01;      /* 0=黑 1=白 */
        uint8_t packed = (uint8_t)((col << 6) | (col << 4) | (col << 2) | col);
        for (int i = 0; i < MAX_ROW_BYTES; i++) row[i] = packed;

        ESP_LOGI(TAG, "ghost clear %d/%d with colour %d", c + 1, cycles, col);
        if (epd_panel_init() != 0) return -1;

        if (s_prof->linear) {
            int h_active = s_out_h;
            int w = s_out_w;
            int tx_bytes = w / 4;
            epd_set_window(w, 0, h_active - 1);
            epd_cmd(0x10, NULL, 0);
            gpio_set_level(EPD_PIN_DC, 1);
            gpio_set_level(EPD_PIN_CS, 0);
            for (int j = 0; j < h_active; j++) spi_tx(row, tx_bytes);
            gpio_set_level(EPD_PIN_CS, 1);
        } else {
            uint8_t z = 0x00;
            for (int j = 0; j < H; j++) {
                int ys = (j < H / 2) ? (j * 2) : (2 * (H - j) + s_lower_y_base);
                if (ys < 0) ys = 0;
                if (ys > H - 1) ys = H - 1;
                epd_set_window(s_prof->w, ys, ys);
                epd_cmd(0x10, &z, 0);
                gpio_set_level(EPD_PIN_DC, 1);
                gpio_set_level(EPD_PIN_CS, 0);
                spi_tx(row, row_bytes);
                gpio_set_level(EPD_PIN_CS, 1);
            }
            epd_set_window(s_prof->w, 0, H - 1);
        }
        if (epd_refresh() != 0) return -1;
        epd_power_off();
    }
    return 0;
}
