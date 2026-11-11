#ifndef MOINK_SETTINGS_H
#define MOINK_SETTINGS_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "esp_err.h"

/*
 * 持久化设置（NVS 命名空间 "moink"）。页面所有画面参数（风格 / 强度 / 文字 /
 * 旋转…）都留在手机 localStorage，固件只存会影响「传输与电源」的这几项。
 *
 * ★ R1.2.2：升级**不再强制重置设置** —— 只清理本版已废弃的键
 * （settings_reset_for_upgrade()），屏型 / 功率 / GPIO 接法 / 休眠 / 唤醒 /
 * 热点凭据全部原样保留。读取时仍不做「历史值归一」，越界值一律回落默认档。
 *
 * ★ R1.2.2：引脚（SPI 六线 + 电池 ADC + 唤醒键）改为运行时可配，随 NVS 持久化；
 *   另有固定自锁脚 GPIO2（MOS 一键开机），不对外开放。
 */

#define SETT_SSID_MAX 33
#define SETT_PASS_MAX 65

/* ---------------- 多 WiFi 记忆（R1.3.5） ----------------
 *
 * 设备最多记住 SETT_WIFI_MAX 个上游 WiFi。唤醒/开机时按
 * 「上次连上的优先，其余按保存顺序」依次尝试，任一成功即停。
 * 整块以 blob 存 NVS（键 "wlist"，784 B）+ 一个 u8 计数（键 "wn"），
 * 避免 16 个键的读写循环；与既有逐键设置互不干扰。
 *
 * sett_wifi_t 必须是纯 char 数组（无 padding），才能整块 memcpy 进 blob。
 * 改字段请同步确认 sizeof(sett_wifi_t) == SETT_SSID_MAX + SETT_PASS_MAX。
 */
#define SETT_WIFI_MAX 8

typedef struct {
    char ssid[SETT_SSID_MAX];
    char pass[SETT_PASS_MAX];
} sett_wifi_t;


/* 休眠时长档位（秒）。0 = 不休眠。 */
#define SETT_SLEEP_OFF    0
#define SETT_SLEEP_1MIN   60
#define SETT_SLEEP_3MIN   180
#define SETT_SLEEP_5MIN   300

/* 定时自动唤醒档位（秒）。0 = 关闭。 */
#define SETT_WAKE_OFF     0
#define SETT_WAKE_1H      3600
#define SETT_WAKE_12H     43200
#define SETT_WAKE_1D      86400

/* 超时动作（R1.3.3）：空闲达到「超时」时长后执行什么。 */
#define SETT_ACTION_SLEEP 0   /* 进入深睡（可配自动唤醒） */
#define SETT_ACTION_OFF   1   /* 释放自锁断电（需硬件自锁电路，见 PIN_SELF_LOCK） */

/* 排线版本（R1.3.6）：只在 gpio_preset == GPIO_PRESET_LINE 时有意义。
 *
 *   老排线：电池经背靠背 AO3401 直接接 VSYS。自锁导通时插 USB，5 V 会经 MOS
 *           压在电芯上（3~4 A，无 CC/CV）⇒ 电池供电下不允许休眠（深睡中插线
 *           芯片无从发现），且运行期每 200 ms 查一次电压，超阈值即释放自锁。
 *   新排线：串联 CH213K 理想二极管做反向阻断，自锁也无倒灌风险；ADC 分压改接
 *           VSYS，任何时刻都能读到 5 V ⇒ 不轮询（轮询反而会误断电池）、允许休眠。
 *
 * ★ 默认老排线（安全侧）：误选成新排线会真倒灌，反向误选只是少睡一觉。 */
#define LINE_VER_OLD      0
#define LINE_VER_NEW      1

/* WiFi 发射功率档位。高 = 18dBm；中 = 10dBm；低 = 8.5dBm（R1.3.3 起为默认档）。 */
#define SETT_WIFI_PWR_HIGH  0
#define SETT_WIFI_PWR_MID   1
#define SETT_WIFI_PWR_LOW   2

/* ---------------- 引脚配置（R1.2.2） ----------------
 *
 * ESP32-C3 的硬边界（Espressif 官方 GPIO 表）：
 *   可用 GPIO        0..10、20、21（11..17 为片内 SPI flash，18/19 为 USB-JTAG，
 *                    本项目一律不使用）；为稳妥，白名单只放到 0..10。
 *   电池 ADC         只有 ADC1 可用（ADC2 与 WiFi 冲突且官方标注不稳定），
 *                    通道与引脚固定绑定：GPIO0..4 = ADC1_CH0..CH4。
 *   深睡唤醒         GPIO 深睡唤醒只有 RTC 域 GPIO0..5 支持（其余脚只能
 *                    light-sleep 唤醒）。
 *   Strapping 脚     GPIO2 / GPIO8 / GPIO9 在复位瞬间被采样决定启动模式，
 *                    本项目把 GPIO2 固定留给自锁，8/9 不开放给用户。
 */

/* 8 个功能的引脚索引；该顺序同时也是页面「自定义」菜单的排列顺序。 */
enum {
    PIN_IDX_ADC  = 0,   /* 电池 ADC   ：仅 GPIO0..4 */
    PIN_IDX_WAKE,       /* 深睡唤醒键 ：仅 GPIO0..5 */
    PIN_IDX_SCK,
    PIN_IDX_MOSI,
    PIN_IDX_CS,
    PIN_IDX_DC,
    PIN_IDX_RST,
    PIN_IDX_BUSY,
    PIN_IDX_COUNT
};

/*
 * MOS 自锁一键开机脚：固件固定 GPIO2，高 = 导通 = 电池供电。
 * R1.3.6 起不再「上电即拉高」—— 先定态为低，由供电来源判据决定是否导通
 * （见 power.h 与 docs/CONTRACT.md §5.4），深睡按当前状态锁存电平。
 * 不对外开放配置（自定义菜单里也会排除它）。
 */
#define PIN_SELF_LOCK  2

/* GPIO 预设（与页面下拉一一对应；取值即 gpio_preset）。 */
#define GPIO_PRESET_DEFAULT  0   /* 默认：现役接法 */
#define GPIO_PRESET_LINE     1   /* 排线 */
#define GPIO_PRESET_BOARD    2   /* 整合板 */
#define GPIO_PRESET_CUSTOM   3   /* 自定义 */
#define GPIO_PRESET_COUNT    4
#define GPIO_PRESET_NPRESET  3   /* 前 3 档为固定预设，第 4 档为用户自填 */

typedef struct { uint8_t v[PIN_IDX_COUNT]; } pin_cfg_t;

/* 固定预设表：[0] 默认 / [1] 排线 / [2] 整合板。 */
extern const pin_cfg_t PIN_PRESETS[GPIO_PRESET_NPRESET];

/* 引脚合法性（白名单 0..10，且不等于自锁脚）。 */
bool pin_io_allowed(uint8_t io);
/* ADC 脚合法集合：GPIO0..4。 */
bool pin_adc_allowed(uint8_t io);
/* 唤醒脚合法集合：GPIO0..5（RTC 域）。 */
bool pin_wake_allowed(uint8_t io);
/* 整表校验：每脚在各自合法域内、彼此不重复、避开自锁脚。合法返回 true。 */
bool pin_cfg_valid(const pin_cfg_t *c);
/* 取当前生效引脚表（永不为 NULL）。 */
const pin_cfg_t *settings_pins(void);

typedef struct {
    uint8_t  panel;      /* EPD_PANEL_A0 / EPD_PANEL_A1 */
    uint8_t  hflip;      /* 保留字段：800x600 对照档已删除，当前无生效档位 */
    uint8_t  wifi_pwr;   /* SETT_WIFI_PWR_HIGH / MID / LOW */
    uint8_t  gpio_preset;/* GPIO_PRESET_DEFAULT / LINE / BOARD / CUSTOM */
    pin_cfg_t pins;      /* 生效引脚表（CUSTOM 时即用户所填，否则等于对应预设） */
    uint32_t sleep_s;    /* 空闲超时时长；0 = 不超时（既不睡也不关） */
    uint8_t  timeout_action; /* SETT_ACTION_SLEEP / SETT_ACTION_OFF（R1.3.3） */
    uint8_t  line_ver;       /* LINE_VER_OLD / LINE_VER_NEW（R1.3.6，仅排线档有意义） */
    uint32_t wake_s;     /* 定时自动唤醒间隔；0 = 关闭 */
    uint8_t  wake_show;  /* 定时唤醒后自动切到下一张；1 = 是（默认，R1.3.3） */
    char     ap_ssid[SETT_SSID_MAX];  /* 空 = 用默认 MoInk-XXXX */
    char     ap_pass[SETT_PASS_MAX];  /* 空 = 热点开放 */

    /* R1.3.5：上游 WiFi 记忆与联网开关 */
    uint8_t     wifi_n;                       /* 已保存网络数 0..SETT_WIFI_MAX */
    sett_wifi_t wifi[SETT_WIFI_MAX];          /* [0..wifi_n-1] 有效 */
    uint8_t     wifi_last;                    /* 上次连上的下标；越界 = 无记录 */
    uint8_t     net_on;                       /* 1 = 允许连上游 WiFi */
    uint8_t     napt_on;                      /* 1 = 热点流量经 STA 转发（NAPT） */
} moink_settings_t;

void settings_init(void);
const moink_settings_t *settings_get(void);

/* 各 setter 立即写 NVS；失败仅告警不影响 RAM 态。 */
esp_err_t settings_set_panel(uint8_t v);
esp_err_t settings_set_hflip(uint8_t v);
esp_err_t settings_set_wifi_pwr(uint8_t v);
esp_err_t settings_set_sleep(uint32_t v);
esp_err_t settings_set_wake(uint32_t v);
/* R1.3.3：空闲超时后的动作（休眠 / 关机断电）。 */
esp_err_t settings_set_timeout_action(uint8_t v);
/* R1.3.6：排线版本（LINE_VER_OLD / LINE_VER_NEW）。老排线在电池供电下禁止休眠。 */
esp_err_t settings_set_line_ver(uint8_t v);
/* R1.3.3：定时唤醒后是否自动切图（默认 1）。 */
esp_err_t settings_set_wake_show(uint8_t v);
/*
 * 设置引脚。preset 取 GPIO_PRESET_*：
 *   0/1/2 从固定预设表取（custom 被忽略）；
 *   3     使用 custom，必须通过 pin_cfg_valid()，否则返回 ESP_ERR_INVALID_ARG。
 * 引脚改动需重启才生效（SPI 总线在启动时按引脚初始化），调用方负责提示。
 */
esp_err_t settings_set_gpio(uint8_t preset, const pin_cfg_t *custom);
/* FB-014①：ssid / pass 任一为 NULL = 保持当前值；pass 为空串 = 清除密码（热点开放）。 */
esp_err_t settings_set_ap(const char *ssid, const char *pass);

/* ---------------- 多 WiFi 记忆（R1.3.5） ---------------- */

/* 已保存网络数（0..SETT_WIFI_MAX）。 */
int settings_wifi_count(void);

/* 取第 i 个网络；越界返回 NULL。 */
const sett_wifi_t *settings_wifi_at(int i);

/*
 * 添加或更新一个网络：
 *   - 已存在同名 SSID → 只更新密码，并移到列表首位（下次优先尝试）；
 *   - 列表已满   → 挤掉最后一个；
 *   - ssid 为空或超长 → ESP_ERR_INVALID_ARG。
 * 返回 ESP_OK 后调用方需自行触发重连（netif_sta_reconnect）。
 */
esp_err_t settings_wifi_add(const char *ssid, const char *pass);

/* 删除第 i 个网络（后续元素前移）。越界返回 ESP_ERR_INVALID_ARG。 */
esp_err_t settings_wifi_remove(int i);

/* 清空全部已保存网络。 */
esp_err_t settings_wifi_clear(void);

/* 记录「第 i 个网络连接成功」，下次优先尝试它。 */
void settings_wifi_mark_ok(int i);

/* 联网总开关 / 热点转发开关。 */
esp_err_t settings_set_net(uint8_t on);
esp_err_t settings_set_napt(uint8_t on);

/* 恢复出厂：擦除整个 NVS 命名空间（含热点凭据与页面热更标记）；调用方负责重启。 */
void settings_factory_reset(void);

/*
 * 固件升级收尾：**只清理已废弃的键**，不再重置用户设置（R1.2.2）。
 *   - 清理：a1_mode（A1 档位已删除）、a11_var（A1.1 诊断变体已删除）等旧版遗留键。
 *   - 保留：panel / hflip / wifi_pwr / gpio_preset + 8 个引脚键 / sleep_s / wake_s /
 *     ap_ssid / ap_pass —— 它们描述硬件与用户偏好，重置会把人挡在门外。
 *   - 页面热更标记（web_len / web_crc / page_ver）由 ota_web_clear() 负责清除。
 * 调用方在固件校验通过、确定要切槽重启之后调用。
 */
void settings_reset_for_upgrade(void);

#endif /* MOINK_SETTINGS_H */
