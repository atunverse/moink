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
 *   A1 - 768 x 552，整窗线性写入 + 完整 JD79665 式初始化
 *        （原 eink-frame 项目称 A1L，重构后统一改名为 A1）。
 *        移植自 InkSight_adapt_HUAWEI_eink firmware/src/epd_driver.cpp
 *        (EPD_PANEL_38_JD79665_BWRY)，华为手机壳 A1 版本。
 *
 * 800 x 600 的社区 A1 画像已在旧项目 M6 移除，本重构不再引入。
 *
 * epd_display_2bpp() 期望的帧缓冲布局：
 *   行 r 存逻辑行 y = H-1-r（缓冲自下而上存储），
 *   每字节 4 像素、MSB 优先，像素 x 在位 (6 - 2*(x%4))，
 *   色码 0x00=黑 0x01=白 0x02=黄 0x03=红（A0 实测）。
 */

typedef enum {
    EPD_PANEL_A0 = 0,
    EPD_PANEL_A1 = 1,      /* 原 A1L：线性整窗写入，未上机验证 */
    EPD_PANEL_A11 = 2,     /* A1.1 测试画像：A1 线性写入 + 可切换诊断变体 */
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

/* 两种画像都是 768x552，静态帧缓冲精确按此尺寸分配。 */
#define EPD_MAX_W         768
#define EPD_MAX_H         552
#define EPD_MAX_BUF_LEN   (EPD_MAX_W / 4 * EPD_MAX_H)   /* 105984 */
#define EPD_A0_W          768
#define EPD_A0_H          552
#define EPD_A1_W          768
#define EPD_A1_H          552

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
 * A1.1 测试画像的诊断变体（1..8）：
 *   1 = 对照（与 A1 序列完全一致）
 *   2 = 级联配置变体：0x84 0x01 -> 0x00
 *   3 = 多扫一行：TRES 高度 +1（553），整窗与写入行数同步扩展
 *   4 = 接缝重写：整帧写完后，把中间接缝行（H/2-2..H/2+2）重叠重写一遍
 *   5 = 分块写：每行独立 CS 包络（4MHz 不变，逐行重新同步控制器，
 *       验证「单次长事务失步」假设——猫猫山/InkSight 位绷路径即逐字节 CS）
 *   6 = 低速：SPI 降到 300kHz（整帧单次 CS 不变，验证「时钟速率」假设）
 *   7 = FB-009 分辨率诊断：TRES 改控制器原生 800×600，全部 600 条栅极被驱动；
 *       内容仍 552 行（上半 276 行原位，中部 276..323 共 48 行填白，下半 276 行
 *       整体下移 48 行），每行 200 字节（192 内容 + 8 字节白填充覆盖 S768..S799）
 *   8 = FB-009 分辨率诊断：TRES 800×600，552 行内容最近邻拉伸到 600 行，
 *       与 V7 互补——不依赖「未驱动栅极恰为扫描中部 48 行」的假设
 * R1.0.11 起：A1 屏（非 A1.1）默认采用 V8 同款 800×600 全栅极扫描，
 * 并叠加水平 768→800 拉伸（双向铺满、无填充白列）——FB-009 定案修复；
 * V7/V8 变体仅保留给 A1.1 批次自查，行为与诊断版完全一致。
 * 每帧显示周期本就完整重初始化面板（epd_cycle），与参考实现一致，
 * 故不再设「每帧重初始化」变体。非法值回落到 1。变体只影响 A1.1 画像。
 */
void epd_set_a11_variant(uint8_t v);
uint8_t epd_get_a11_variant(void);

/* 当前画像（永不为 NULL）。 */
const epd_profile_t *epd_profile(void);

/* 画像显示名（"A0" / "A1"）。 */
const char *epd_panel_name(epd_panel_t panel);

/*
 * 写帧时水平镜像。默认关（A0 已验证行为）。线性 A1 画像未上机验证，
 * 若出图为左右镜像，从设置页翻转即可，无需重刷。
 */
void epd_set_hflip(bool on);
bool epd_get_hflip(void);

/*
 * 完整显示周期，最多尝试 3 次：
 * reset -> PSR/TRES/上电 -> 写 2bpp 帧 -> 刷新 -> 断电。
 * `frame` 必须为 epd_profile()->buf_len 字节。成功返回 0。
 */
int epd_display_2bpp(const uint8_t *frame);

/*
 * 残影清理：整屏填单色并刷新 `cycles` 次（黑/白交替）。
 * 每次约一次全刷新（本屏约 15~25 秒）。
 */
int epd_clear_cycles(int cycles);

/* 发送面板深睡命令（0x07 0xA5）。用完可安全调用。 */
void epd_panel_deep_sleep(void);

#endif /* EPD_DRV_H */
