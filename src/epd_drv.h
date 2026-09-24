#ifndef EPD_DRV_H
#define EPD_DRV_H

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

/*
 * JDY79668 协议四色电子墨水屏驱动（K/W/R/Y，2bpp，4 像素/字节）。
 * 从社区 InkSight 适配移植（epd_driver.cpp + 屏幕修改适配驱动/epd7in3g-A0.cpp）。
 *
 * 两种拆机屏运行时切换（无需重刷）：
 *   A0 - 768 x 552，隔行半屏 Y 映射（已在真机验证）
 *   A1 - 可见区 768 x 552（与 A0 外观一致）、TRES 768 x 600，完整 JD79665
 *        式初始化，单帧一次 0x83 布防。移植自 InkSight_adapt_HUAWEI_eink
 *        firmware/src/epd_driver.cpp (EPD_PANEL_38_JD79665_BWRY)，华为手机壳
 *        A1 版本；按 a1_mode 分两档驱动策略（见 epd_set_a1_mode()）——真机
 *        确认栅极为顺序寻址，768x552 帧顺序直写即 1:1 铺满可见区。
 *        编号同为 A1、但刷新分两半且有接缝的「A1.1 批次」也选 A1：
 *        R1.2.0 已删除 A1.1 专属画像与诊断变体（参数与 A1 完全相同，
 *        唯一差别是历史遗留的 TRES 高度，见下方 EPD_A1N_H 注释）。
 *
 * epd_display_2bpp() / epd_display_2bpp_wh() 期望的帧缓冲布局：
 *   行 r 存逻辑行 y = H-1-r（缓冲自下而上存储），
 *   每字节 4 像素、MSB 优先，像素 x 在位 (6 - 2*(x%4))，
 *   色码 0x00=黑 0x01=白 0x02=黄 0x03=红（A0 实测）。
 */

typedef enum {
    EPD_PANEL_A0 = 0,
    EPD_PANEL_A1 = 1,
    EPD_PANEL_COUNT
} epd_panel_t;

typedef struct {
    uint16_t w;
    uint16_t h;
    uint32_t buf_len;        /* w/4*h 字节的 2bpp 载荷 */
    int8_t   lower_y_base;   /* 下半屏 Y 映射偏移（A0: -1） */
    uint8_t  linear;         /* 1 = 整窗 + 单次线性 0x10 写入 */
} epd_profile_t;

extern const epd_profile_t EPD_PROFILES[EPD_PANEL_COUNT];

/* 静态帧缓冲按最大的合法载荷分配：A1 原生帧 800x600/4 = 120000 字节；
   A0 / A1 的 768x552 帧（105984）用同一块缓冲的前段。 */
#define EPD_MAX_W         800
#define EPD_MAX_H         600
#define EPD_MAX_BUF_LEN   (EPD_MAX_W / 4 * EPD_MAX_H)   /* 120000 */
#define EPD_A0_W          768
#define EPD_A0_H          552
#define EPD_A1_W          768       /* A1 可见区 / 768x552 帧 */
#define EPD_A1_H          552
#define EPD_A1N_W         800       /* A1 原生画像（a1_mode 2 对照档）：TRES 与帧 800x600 */
#define EPD_A1N_H         600

/*
 * 引脚映射（R 系列：RST 自旧项目 GPIO2 改到 GPIO3）
 *   SCK=4  MOSI=6  CS=7  DC=1  RST=3  BUSY=10
 *   唤醒键 : GPIO5 -> GND（C3 深睡唤醒域 GPIO0..5 内空闲脚；兼做长按恢复出厂）
 *   电池 ADC : GPIO0（ADC1_CH0——ADC2 与 WiFi 共用不可用）
 */
#define EPD_PIN_SCK      4
#define EPD_PIN_MOSI     6
#define EPD_PIN_CS       7
#define EPD_PIN_DC       1
#define EPD_PIN_RST      3
#define EPD_PIN_BUSY     10
#define EPD_PIN_WAKE_BTN 5
#define EPD_PIN_BAT_ADC  0

/* 初始化 SPI 总线 + GPIO。成功返回 0。 */
int epd_init(void);

/* 选择活动屏画像。成功返回 0。 */
int epd_set_panel(epd_panel_t panel);
epd_panel_t epd_get_panel(void);

/*
 * A1 屏驱动模式（仅 EPD_PANEL_A1 生效）。
 *
 * ★ FB-013 真机定案（2026-09-23，fw R1.1.2）：这块玻璃的**可见区恒为 768x552**
 *   （外观与 A0 一致），帧里多出来的行列**不显示**；且栅极是**顺序寻址**的
 *   ——「原生 800x600」档顺序写栅极 0..599 得到的是**连续完整**的画面
 *   （无上下穿插、无横向条纹），只是右 32 列 / 下 48 行被可见区裁掉。
 *   因此此前由卖家固件取证反推的「两 bank 交错栅极」模型作废，交错映射路径
 *   （旧 2 / 3 / 4 档）已整体删除。
 *
 *   1 SEQ552     ★默认·正解  帧 768x552，TRES/刷新窗 768x600，写入窗口
 *                            (0..767, 0..551) + 单次 0x10 连发 552 行 x 192 B，
 *                            栅极号 = 行号（顺序）。1:1 铺满可见区：不裁切、
 *                            不重采样、无白边。行内固定整行镜像（真机对照确认）。
 *   2 NATIVE800  对照        帧 800x600 原生，同一条写入路径写 600 行
 *                            （栅极 0..599）。已知会被可见区裁掉右 32 列 /
 *                            下 48 行，仅作对照诊断。
 *
 * 设置页「左右镜像」勾选框只对 2 NATIVE800 生效（1 SEQ552 行内固定正向）；
 * NVS 里越界的值在读入时回落到默认档。
 */
#define EPD_A1_MODE_SEQ552     1
#define EPD_A1_MODE_NATIVE800  2
#define EPD_A1_MODE_DEFAULT    EPD_A1_MODE_SEQ552

void epd_set_a1_mode(uint8_t v);
uint8_t epd_get_a1_mode(void);

/* 当前画像（永不为 NULL）。 */
const epd_profile_t *epd_profile(void);

/* 画像显示名（"A0" / "A1"）。 */
const char *epd_panel_name(epd_panel_t panel);

/*
 * 写帧时水平镜像。默认关（A0 已验证行为）。
 * 生效范围：A1 的 2 NATIVE800 对照档（勾上 = 整行镜像，真机正向）；
 * 1 SEQ552 默认档行内固定整行镜像，不读本开关。
 */
void epd_set_hflip(bool on);
bool epd_get_hflip(void);

/*
 * 完整显示周期，最多尝试 3 次：
 * reset -> PSR/TRES/上电 -> 写 2bpp 帧 -> 刷新 -> 断电。
 * `frame` 必须为 epd_profile()->buf_len 字节。成功返回 0。
 */
int epd_display_2bpp(const uint8_t *frame);

/* 同 epd_display_2bpp()，但显式给出本帧几何（页面可发 768x552 或 800x600）。 */
int epd_display_2bpp_wh(const uint8_t *frame, uint16_t w, uint16_t h);

/*
 * 校验帧几何是否被当前画像 / 模式接受。
 *   A0：只接受自身画像尺寸；
 *   A1：768x552（1 SEQ552 默认档）与 800x600（2 NATIVE800 对照档）都收，
 *       载荷长度必须与几何自洽。
 */
bool epd_frame_geom_ok(uint16_t w, uint16_t h, uint32_t len);

/*
 * 残影清理：整屏填单色并刷新 `cycles` 次（黑/白交替）。
 * 每次约一次全刷新（本屏约 15~25 秒）。
 */
int epd_clear_cycles(int cycles);

/* 发送面板深睡命令（0x07 0xA5）。用完可安全调用。 */
void epd_panel_deep_sleep(void);

#endif /* EPD_DRV_H */
