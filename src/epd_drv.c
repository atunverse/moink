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
 * A1 (768x552) 是第二套社区适配——InkSight_adapt_HUAWEI_eink
 *（华为手机壳 A1 版本，EPD_PANEL_38_JD79665_BWRY）。与 A0 同物理尺寸，
 * 但控制器握手不同：更长的初始化块（0xAA 解锁、0x01 驱动输出、0x65/0x84
 * 级联设置）以及线性帧写入（一个 0x83 整窗，然后整块 2bpp 缓冲走单次 0x10）。
 * 它还需要长得多的 BUSY 窗口（180 s），且 0x12 后 BUSY 在 250 ms 内又落下时
 * 补一个固定 14 s 等待——该屏已知会在 0x12 后假释 BUSY。
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
/* FB-009 诊断变体 V7/V8 的扫描宽度（控制器原生档位）。 */
#define DIAG_V78_W    800
#define DIAG_V78_H    600
#define MAX_ROW_BYTES (DIAG_V78_W / 4) /* 200（常规 552 行只需 192） */

const epd_profile_t EPD_PROFILES[EPD_PANEL_COUNT] = {
    [EPD_PANEL_A0]  = { EPD_A0_W, EPD_A0_H, EPD_A0_W / 4 * EPD_A0_H, -1, 0 },
    [EPD_PANEL_A1]  = { EPD_A1_W, EPD_A1_H, EPD_A1_W / 4 * EPD_A1_H,  0, 1 },
    [EPD_PANEL_A11] = { EPD_A1_W, EPD_A1_H, EPD_A1_W / 4 * EPD_A1_H,  0, 1 },
};

static const epd_profile_t *s_prof = &EPD_PROFILES[EPD_PANEL_A0];
static epd_panel_t s_panel = EPD_PANEL_A0;
static int8_t s_lower_y_base = -1;
static bool s_hflip = false;
static uint8_t s_a11_var = 1;    /* A1.1 诊断变体，见 epd_drv.h */
static spi_device_handle_t s_spi;

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

/* A1.1 变体 6 的降速时钟（300kHz，约等于参考位绷路径的信号条件）。 */
#define A11_V6_SPI_HZ  300000u

static uint32_t s_spi_hz = SPI_HZ;

/* 运行时重配 SPI 时钟（变体 6）。仅在本驱动独占总线的前提下安全。 */
static int spi_reconfigure_clock(uint32_t hz)
{
    if (hz == s_spi_hz) return 0;
    if (spi_bus_remove_device(s_spi) != ESP_OK) return -1;
    spi_device_interface_config_t dev = {
        .clock_speed_hz = (int)hz,
        .mode = 0,
        .spics_io_num = -1,          /* CS 手动驱动 */
        .queue_size = 1,
    };
    if (spi_bus_add_device(SPI2_HOST, &dev, &s_spi) != ESP_OK) {
        ESP_LOGE(TAG, "spi reconfig to %u Hz failed", (unsigned)hz);
        return -1;
    }
    s_spi_hz = hz;
    ESP_LOGI(TAG, "SPI clock -> %u Hz", (unsigned)hz);
    return 0;
}

/* ---- profile ---- */

int epd_set_panel(epd_panel_t panel)
{
    if (panel < 0 || panel >= EPD_PANEL_COUNT) return -1;
    s_panel = panel;
    s_prof = &EPD_PROFILES[panel];
    s_lower_y_base = s_prof->lower_y_base;
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
    case EPD_PANEL_A11: return "A1.1";
    default:            return "?";
    }
}

/* ---- A1.1 诊断变体 ---- */

void epd_set_a11_variant(uint8_t v)
{
    if (v < 1 || v > 8) v = 1;
    s_a11_var = v;
    ESP_LOGI(TAG, "A1.1 diagnostic variant = %u", (unsigned)v);
}

uint8_t epd_get_a11_variant(void) { return s_a11_var; }

/*
 * A1.1 变体 3 的有效扫描行数：TRES 多声明一行（553）。
 * 若 A1.1 批次在上下两半级联的接缝处多了一条栅极，声明 552 时
 * 这条栅极不会被任何数据行命中，刷新波形边界就在它身上留下深色线。
 */
/*
 * FB-009 诊断变体：A11 画像 V7/V8 把 TRES 改成控制器原生 800×600，
 * 让被 768×552 欠驱动禁用的 G552..G599 共 48 条栅极也得到驱动
 * （JD79665AA 规格书 p20/p44：非选择栅极保持 VGN = 初始白态）。
 */
static int a11_v78(void)
{
    return (s_panel == EPD_PANEL_A11 && (s_a11_var == 7 || s_a11_var == 8));
}

/*
 * R1.0.11（FB-009 定案）：A1 屏（非 A1.1）默认改控制器原生 800×600
 * 全栅极扫描——真机裁决证实 768×552 欠驱动 G552..G599 共 48 条栅极
 * 是中部白线根因。wide_res() = 需要 800×600 扫描宽度的场合。
 */
static int a1_full(void)
{
    return s_panel == EPD_PANEL_A1;
}

static int wide_res(void)
{
    return a1_full() || a11_v78();
}

static int a11_h_active(void)
{
    if (s_panel == EPD_PANEL_A11 && s_a11_var == 3) return s_prof->h + 1;
    if (wide_res()) return DIAG_V78_H;
    return s_prof->h;
}

epd_panel_t epd_get_panel(void) { return s_panel; }

const epd_profile_t *epd_profile(void) { return s_prof; }

void epd_set_hflip(bool on)
{
    /* 该覆盖只对线性 A1 控制器有意义。A0 必须保持关：缓冲契约已经镜像了画面，
     * 再翻一次会把每一帧都变回左右颠倒。 */
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

    int h_active = a11_h_active();
    int tres_w = wide_res() ? DIAG_V78_W : s_prof->w;
    uint8_t tres[4] = { (uint8_t)(tres_w >> 8), (uint8_t)(tres_w & 0xFF),
                        (uint8_t)(h_active >> 8), (uint8_t)(h_active & 0xFF) };
    epd_cmd(0x61, tres, 4);             /* TRES */

    EPD_C4(0x65, 0x10, 0x00, 0x20, 0x00);
    EPD_C1(0xE3, 0x2F);
    if (s_panel == EPD_PANEL_A11 && s_a11_var == 2) {
        EPD_C1(0x84, 0x00);             /* A1.1 变体 2：级联配置改写 */
    } else {
        EPD_C1(0x84, 0x01);
    }
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
 * A1：一个 0x83 整窗，然后整块缓冲走单次 0x10。
 * 行自顶向下；每行保持 180° 缓冲契约（物理行 j <- 逻辑行 j），
 * 与 A0 一样水平镜像，除非用户开了水平翻转覆盖。
 * A1.1 变体 3 多扫一行（h_active = H+1）：多出的最后一行复制前一行的数据，
 * 保证多声明的那条栅极也被显式驱动。变体 4 在整帧写完后把接缝行重叠重写。
 */
static int epd_write_frame_linear(const uint8_t *buf)
{
    static uint8_t row[MAX_ROW_BYTES];
    const int H = s_prof->h, row_bytes = s_prof->w / 4;
    const int h_active = a11_h_active();
    /* 变体 5：每行独立 CS 包络（0x10 数据相位保持打开，逐行重新同步控制器）。 */
    const bool per_row_cs = (s_panel == EPD_PANEL_A11 && s_a11_var == 5);

    epd_set_window(s_prof->w, 0, h_active - 1);
    epd_cmd(0x10, NULL, 0);                     /* 写 RAM */

    gpio_set_level(EPD_PIN_DC, 1);
    if (!per_row_cs) gpio_set_level(EPD_PIN_CS, 0);
    esp_err_t err = ESP_OK;
    for (int j = 0; j < h_active && err == ESP_OK; j++) {
        int src_row = H - 1 - j;
        if (src_row < 0) src_row = 0;           /* 变体 3 多出的行复制最底行 */
        row_mirror(row, buf + (size_t)src_row * row_bytes, row_bytes, s_hflip);
        if (per_row_cs) gpio_set_level(EPD_PIN_CS, 0);
        err = spi_tx(row, row_bytes);
        if (per_row_cs) gpio_set_level(EPD_PIN_CS, 1);
    }
    if (err == ESP_OK && s_panel == EPD_PANEL_A11 && s_a11_var == 4) {
        /* A1.1 变体 4：上下两半级联接缝（H/2 附近）重叠重写一遍。 */
        const int ys = H / 2 - 2, ye = H / 2 + 2;
        epd_set_window(s_prof->w, ys, ye);
        epd_cmd(0x10, NULL, 0);
        for (int y = ys; y <= ye && err == ESP_OK; y++) {
            row_mirror(row, buf + (size_t)(H - 1 - y) * row_bytes, row_bytes, s_hflip);
            err = spi_tx(row, row_bytes);
        }
    }
    gpio_set_level(EPD_PIN_CS, 1);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "SPI tx failed: %s", esp_err_to_name(err));
        return -1;
    }
    return 0;
}

/*
 * FB-009 诊断 V7/V8：TRES 800×600 全栅极扫描。
 * 帧缓冲仍 768×552（页面契约不变）；扫描 600 行、每行 200 字节
 * （192 字节内容 + 8 字节白填充，覆盖被禁用的 S768..S799）。
 *   V7（填白）：上 276 行 = 内容上半（与 552 扫描同位），
 *              中 48 行（276..323）填白（对应假设中被欠驱动的栅极位置），
 *              下 276 行 = 内容下半，整体下移 48 行；
 *   V8（拉伸）：552 行内容最近邻拉伸到 600 行，不依赖上述位置假设。
 * 两变体判据：白线消失 = 分辨率欠驱动假设成立；V7 图像上/下半错位 48 行
 * 而 V8 完整对位 = 「未驱动栅极在扫描中部」假设成立；V8 内容整体偏移
 * 则说明栅极编号方向与假设不同（记录现象即可）。
 */
static int epd_write_frame_v78(const uint8_t *buf)
{
    static uint8_t row[MAX_ROW_BYTES];
    static uint8_t pad[MAX_ROW_BYTES];
    const int H = s_prof->h, row_bytes = s_prof->w / 4;     /* 552 / 192 */
    const int H_ACTIVE = DIAG_V78_H, tx_bytes = DIAG_V78_W / 4;  /* 600 / 200 */
    const int stretch = (s_a11_var == 8);

    memset(pad, 0x55, sizeof(pad));              /* 全白 = 每像素 2bit 01 -> 0x55（0x01 是黑黑黑白条纹，b 版修正） */
    epd_set_window(DIAG_V78_W, 0, H_ACTIVE - 1);
    epd_cmd(0x10, NULL, 0);                     /* 写 RAM */

    gpio_set_level(EPD_PIN_DC, 1);
    gpio_set_level(EPD_PIN_CS, 0);
    esp_err_t err = ESP_OK;
    for (int j = 0; j < H_ACTIVE && err == ESP_OK; j++) {
        int fill_white = (!stretch && j >= H / 2 && j < H / 2 + 48);
        if (fill_white) {
            memcpy(row, pad, tx_bytes);
        } else {
            int src_row = stretch ? ((j * H) / H_ACTIVE)
                                  : (H - 1 - (j < H / 2 ? j : j - 48));
            if (src_row > H - 1) src_row = H - 1;
            row_mirror(row, buf + (size_t)src_row * row_bytes, row_bytes,
                       s_hflip);
            memcpy(row + row_bytes, pad, tx_bytes - row_bytes);
        }
        err = spi_tx(row, tx_bytes);
    }
    gpio_set_level(EPD_PIN_CS, 1);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "SPI tx failed: %s", esp_err_to_name(err));
        return -1;
    }
    return 0;
}

/*
 * 2bpp 行内最近邻水平拉伸：out 像素 k = in 像素 floor(k*in_w/out_w)。
 * R1.0.11 A1 全分辨率扫描用（768→800，800 像素恰为 200 字节，无填充列）。
 */
static void row_stretch_h(uint8_t *out, const uint8_t *in, int in_w, int out_w)
{
    for (int b = 0; b < out_w / 4; b++) {
        uint8_t v = 0;
        for (int p = 0; p < 4; p++) {
            int k = b * 4 + p;
            int s = (k * in_w) / out_w;
            uint8_t code = (in[s >> 2] >> (6 - (s & 3) * 2)) & 0x03;
            v = (uint8_t)(v | (code << (6 - p * 2)));
        }
        out[b] = v;
    }
}

/*
 * R1.0.11（FB-009 定案修复）：A1 屏默认 TRES 800×600 全栅极扫描。
 * 帧缓冲仍 768×552（页面契约不变），发送前双向最近邻拉伸：
 * 垂直 552→600、水平 768→800。A1.1 的 V8 变体保持诊断版行为
 * （垂直拉伸 + 8 字节白填充），本函数为其叠加水平拉伸的正式版。
 */
static int epd_write_frame_a1full(const uint8_t *buf)
{
    static uint8_t row[MAX_ROW_BYTES];
    static uint8_t tmp[MAX_ROW_BYTES];
    const int H = s_prof->h, row_bytes = s_prof->w / 4;          /* 552 / 192 */
    const int H_ACTIVE = DIAG_V78_H, tx_bytes = DIAG_V78_W / 4;  /* 600 / 200 */

    epd_set_window(DIAG_V78_W, 0, H_ACTIVE - 1);
    epd_cmd(0x10, NULL, 0);                     /* 写 RAM */

    gpio_set_level(EPD_PIN_DC, 1);
    gpio_set_level(EPD_PIN_CS, 0);
    esp_err_t err = ESP_OK;
    for (int j = 0; j < H_ACTIVE && err == ESP_OK; j++) {
        int src_row = (j * H) / H_ACTIVE;
        row_mirror(tmp, buf + (size_t)src_row * row_bytes, row_bytes, s_hflip);
        row_stretch_h(row, tmp, row_bytes * 4, tx_bytes * 4);
        err = spi_tx(row, tx_bytes);
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
        if (a11_v78()) return epd_write_frame_v78(buf);
        if (a1_full()) return epd_write_frame_a1full(buf);
        return epd_write_frame_linear(buf);
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
    /* 变体 6：低速 SPI（300kHz），隔离「时钟速率」假设；其他变体回到标准时钟。 */
    if (s_panel == EPD_PANEL_A11 && s_a11_var == 6) {
        if (spi_reconfigure_clock(A11_V6_SPI_HZ) != 0) return -1;
    } else if (s_spi_hz != SPI_HZ) {
        spi_reconfigure_clock(SPI_HZ);
    }

    for (int attempt = 0; attempt < 3; attempt++) {
        int64_t t0;
        ESP_LOGI(TAG, "display attempt %d/3 (BUSY=%d)", attempt + 1,
                 gpio_get_level(EPD_PIN_BUSY));

        if (epd_panel_init() != 0) continue;

        t0 = now_ms();
        if (epd_write_frame_2bpp(frame) != 0) continue;
        ESP_LOGI(TAG, "frame written in %lld ms", (long long)(now_ms() - t0));

        epd_set_window(wide_res() ? DIAG_V78_W : s_prof->w,
                       0, a11_h_active() - 1);

        t0 = now_ms();
        if (epd_refresh() != 0) continue;
        ESP_LOGI(TAG, "refresh done in %lld ms", (long long)(now_ms() - t0));

        epd_power_off();
        return 0;
    }
    ESP_LOGE(TAG, "display failed after 3 attempts");
    return -1;
}

int epd_display_2bpp(const uint8_t *frame)
{
    return epd_cycle(frame);
}

int epd_clear_cycles(int cycles)
{
    static uint8_t row[MAX_ROW_BYTES];
    const int H = s_prof->h, row_bytes = s_prof->w / 4;
    if (cycles < 1) cycles = 1;
    if (cycles > 4) cycles = 4;

    for (int c = 0; c < cycles; c++) {
        /* 黑/白交替，两种色素极端都得到锻炼 */
        uint8_t col = (c % 2 == 0) ? 0x00 : 0x01;      /* 0=黑 1=白 */
        uint8_t packed = (uint8_t)((col << 6) | (col << 4) | (col << 2) | col);
        for (int i = 0; i < MAX_ROW_BYTES; i++) row[i] = packed;

        ESP_LOGI(TAG, "ghost clear %d/%d with colour %d", c + 1, cycles, col);
        if (epd_panel_init() != 0) return -1;

        if (s_prof->linear) {
            int h_active = a11_h_active();
            int w = wide_res() ? DIAG_V78_W : s_prof->w;
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
