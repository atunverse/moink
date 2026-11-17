#include "settings.h"
#include "epd_drv.h"

#include "nvs.h"
#include "nvs_flash.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "settings";

#define NVS_NS "moink"

/* ---------------- 引脚预设与校验（R1.2.2） ----------------
   GPIO 白名单只放 0..10：11..17 是片内 SPI flash，18/19 是 USB-JTAG，
   本项目不使用。自锁脚 GPIO2 单独排除。 */
const pin_cfg_t PIN_PRESETS[GPIO_PRESET_NPRESET] = {
    /* [0] 默认：SCK=4 MOSI=6 CS=7 DC=1 RST=3 BUSY=10，唤醒=5，ADC=0 */
    [GPIO_PRESET_DEFAULT] = { { 0, 5, 4, 6, 7, 1, 3, 10 } },
    /* [1] 排线（R1.3.1 改版）：ADC=0 唤醒=1 BUSY=3 RST=4 DC=5 CS=6 SCK=7 DIN=10，自锁固定 2 */
    [GPIO_PRESET_LINE]    = { { 0, 1, 7, 10, 6, 5, 4, 3 } },
    /* [2] 整合板：SCK=4 MOSI=3 CS=5 DC=6 RST=7 BUSY=10，唤醒=1，ADC=0 */
    [GPIO_PRESET_BOARD]   = { { 0, 1, 4, 3, 5, 6, 7, 10 } },
};

bool pin_io_allowed(uint8_t io)
{
    if (io > 10) return false;          /* 11..17 flash、18/19 USB、20/21 UART0 全排除 */
    if (io == PIN_SELF_LOCK) return false;  /* GPIO2 已被自锁占用 */
    return true;
}

bool pin_adc_allowed(uint8_t io)  { return io <= 4; }   /* ADC1_CH0..CH4 = GPIO0..4 */
bool pin_wake_allowed(uint8_t io) { return io <= 5; }   /* RTC 域 GPIO0..5 */

bool pin_cfg_valid(const pin_cfg_t *c)
{
    if (!c) return false;
    for (int i = 0; i < PIN_IDX_COUNT; i++) {
        uint8_t io = c->v[i];
        if (i == PIN_IDX_ADC) {
            if (!pin_adc_allowed(io)) return false;
        } else if (i == PIN_IDX_WAKE) {
            if (!pin_wake_allowed(io)) return false;
        } else {
            if (!pin_io_allowed(io)) return false;
        }
        /* 互不重复。 */
        for (int j = 0; j < i; j++)
            if (c->v[j] == io) return false;
    }
    return true;
}

/* ---------------- 设置本体 ---------------- */

static const moink_settings_t DEFAULTS = {
    .panel       = EPD_PANEL_A0,
    .hflip       = 0,
    .wifi_pwr    = SETT_WIFI_PWR_LOW,   /* R1.3.3：默认改为低功率（8.5dBm） */
    .gpio_preset = GPIO_PRESET_DEFAULT,
    .pins        = { { 0, 5, 4, 6, 7, 1, 3, 10 } },   /* 与 PIN_PRESETS[0] 一致 */
    .sleep_s     = SETT_SLEEP_3MIN,          /* R1.4.0-3：默认 3 分钟 */
    .timeout_action = SETT_ACTION_OFF,       /* R1.4.0-3：默认关机（释放自锁断电） */
    .line_ver    = LINE_VER_OLD,   /* R1.3.6：默认老排线（安全侧） */
    .wake_s      = SETT_WAKE_OFF,
    .wake_show   = 1,        /* R1.3.3：定时唤醒后自动切图，默认开启 */
    .ap_ssid     = "",
    .ap_pass     = "",
    /* R1.3.5：默认不联网、不开转发 —— 升级后行为与旧固件完全一致 */
    .wifi_n      = 0,
    .wifi_last   = 0xFF,     /* 0xFF = 尚无成功记录 */
    .net_on      = 0,
    .napt_on     = 0,
    /* R1.4.0：实验项与远程图槽默认全部关闭 —— 升级后行为与旧固件一致 */
    .remote_mode = SETT_REMOTE_OFF,
    .remote_slot = 0xFF,     /* 0xFF = 还没有成功显示过任何一张 */
    .remote_crc  = 0,
    .remote_url  = "",
    .remote_user = "",
    .remote_pass = "",
};

/* 引脚 NVS 键名（逐个 u8 存；顺序与 PIN_IDX_* 一致）。 */
static const char *PIN_KEY[PIN_IDX_COUNT] = {
    "p_adc", "p_wake", "p_sck", "p_mosi", "p_cs", "p_dc", "p_rst", "p_busy"
};

static moink_settings_t s_cfg;
static nvs_handle_t s_nvs;
static bool s_ok = false;

static void read_u8(const char *key, uint8_t *out)
{
    uint8_t v;
    if (s_ok && nvs_get_u8(s_nvs, key, &v) == ESP_OK) *out = v;
}

static void read_u32(const char *key, uint32_t *out)
{
    uint32_t v;
    if (s_ok && nvs_get_u32(s_nvs, key, &v) == ESP_OK) *out = v;
}

static void read_str(const char *key, char *out, size_t n)
{
    if (!s_ok) return;
    size_t need = 0;
    if (nvs_get_str(s_nvs, key, NULL, &need) != ESP_OK) return;
    if (need == 0 || need > n) return;
    /* 直接读进目标缓冲：R1.4.0 的 remote_url 有 193 字节，
       用固定的 SETT_PASS_MAX 中转会截断。need ≤ n 已校验，安全。 */
    nvs_get_str(s_nvs, key, out, &need);
}

void settings_init(void)
{
    s_cfg = DEFAULTS;

    /* 命名空间小、字段少，逐键读取；读不到就落在默认值上。 */
    s_ok = (nvs_open(NVS_NS, NVS_READWRITE, &s_nvs) == ESP_OK);
    if (!s_ok) {
        ESP_LOGW(TAG, "nvs_open failed, using defaults");
        return;
    }

    read_u8("panel",   &s_cfg.panel);
    read_u8("hflip",   &s_cfg.hflip);
    read_u8("wifi_pwr", &s_cfg.wifi_pwr);
    read_u8("gpio_preset", &s_cfg.gpio_preset);
    for (int i = 0; i < PIN_IDX_COUNT; i++)
        read_u8(PIN_KEY[i], &s_cfg.pins.v[i]);
    read_u32("sleep_s", &s_cfg.sleep_s);
    read_u32("wake_s",  &s_cfg.wake_s);
    read_u8("to_act",   &s_cfg.timeout_action);   /* R1.3.3；无此键 = DEFAULTS */
    read_u8("line_v",   &s_cfg.line_ver);         /* R1.3.6：无此键 = 老排线 */
    read_u8("wake_show", &s_cfg.wake_show);       /* R1.3.3：无此键 = 默认开 */
    read_str("ap_ssid", s_cfg.ap_ssid, SETT_SSID_MAX);
    read_str("ap_pass", s_cfg.ap_pass, SETT_PASS_MAX);

    /* R1.3.5：多 WiFi 记忆。计数与整块分别在两个键里：
       "wn" = 有效个数，"wlist" = 8 项定长数组（784 B）。
       旧固件没有这两个键 → wifi_n 保持 0，联网功能自然处于关闭态。 */
    read_u8("wn", &s_cfg.wifi_n);
    read_u8("wifi_last", &s_cfg.wifi_last);
    read_u8("net_on", &s_cfg.net_on);
    read_u8("napt_on", &s_cfg.napt_on);
    if (s_ok) {
        size_t need = 0;
        if (nvs_get_blob(s_nvs, "wlist", NULL, &need) == ESP_OK &&
            need == sizeof(s_cfg.wifi))
            nvs_get_blob(s_nvs, "wlist", s_cfg.wifi, &need);
    }

    /* R1.4.0：实验项与远程图槽（旧固件没有这些键 ⇒ 保持默认 = 关闭）。
       ★ 120Hz 不读 NVS：它是「本次运行」的实验档，重启必回动态档 ——
         否则一旦 120Hz 把 WiFi 拖垮、页面开不了，用户就再也关不掉它。 */
    read_u8("r_mode",  &s_cfg.remote_mode);
    read_u8("r_slot",  &s_cfg.remote_slot);
    read_u32("r_crc",  &s_cfg.remote_crc);
    read_str("r_url",  s_cfg.remote_url,  SETT_URL_MAX);
    read_str("r_user", s_cfg.remote_user, SETT_USER_MAX);
    read_str("r_pass", s_cfg.remote_pass, SETT_RPASS_MAX);

    /* ★ R1.4.0-3：默认值改为「关机 + 3 分钟」。老设备 NVS 里存的是旧默认
       （休眠 + 5 分钟），这里只在首次升级到本版时改一次；之后用户在页面上的
       选择照常生效（def2 = 已迁移标记，不会被再次覆盖）。 */
    uint8_t def2 = 0;
    read_u8("def2", &def2);
    if (!def2) {
        s_cfg.sleep_s        = SETT_SLEEP_3MIN;
        s_cfg.timeout_action = SETT_ACTION_OFF;
        if (s_ok) {
            nvs_set_u32(s_nvs, "sleep_s", (uint32_t)s_cfg.sleep_s);
            nvs_set_u8(s_nvs, "to_act", s_cfg.timeout_action);
            nvs_set_u8(s_nvs, "def2", 1);
            nvs_commit(s_nvs);
        }
        ESP_LOGW(TAG, "defaults migrated: timeout=180s, action=off");
    }

    /* R1.2.0：旧值不再做兼容归一；越界一律回落到默认档。 */
    if (s_cfg.panel >= EPD_PANEL_COUNT) s_cfg.panel = DEFAULTS.panel;
    /* R1.4.0-3：「左右镜像」已从页面移除（对当前两档屏都无意义），
       存量的 hflip=1 一律清掉，否则旧设备会保持一个改不回来的错误镜像。 */
    s_cfg.hflip = 0;
    if (s_cfg.timeout_action > SETT_ACTION_OFF)
        s_cfg.timeout_action = DEFAULTS.timeout_action;
    if (s_cfg.line_ver > LINE_VER_NEW) s_cfg.line_ver = LINE_VER_OLD;
    if (s_cfg.wake_show) s_cfg.wake_show = 1;

    /* R1.3.5：WiFi 列表校正。计数越界即视为空；字符串强制收尾；
       遇到空 SSID 就在该处截断，避免「中间空一格」让后续下标对不上。 */
    if (s_cfg.wifi_n > SETT_WIFI_MAX) s_cfg.wifi_n = 0;
    for (int i = 0; i < (int)s_cfg.wifi_n; i++) {
        s_cfg.wifi[i].ssid[SETT_SSID_MAX - 1] = '\0';
        s_cfg.wifi[i].pass[SETT_PASS_MAX - 1] = '\0';
        if (s_cfg.wifi[i].ssid[0] == '\0') { s_cfg.wifi_n = (uint8_t)i; break; }
    }
    if (s_cfg.wifi_last >= SETT_WIFI_MAX) s_cfg.wifi_last = 0xFF;
    s_cfg.net_on  = s_cfg.net_on  ? 1 : 0;
    s_cfg.napt_on = s_cfg.napt_on ? 1 : 0;

    /* R1.4.0：越界一律回落默认（远程模式非法 = 关闭） */
    if (s_cfg.remote_mode > SETT_REMOTE_MF) s_cfg.remote_mode = SETT_REMOTE_OFF;
    if (s_cfg.remote_slot >= 0xFE) s_cfg.remote_slot = 0xFF;
    s_cfg.remote_url[SETT_URL_MAX - 1]   = '\0';
    s_cfg.remote_user[SETT_USER_MAX - 1] = '\0';
    s_cfg.remote_pass[SETT_RPASS_MAX - 1] = '\0';

    /* 引脚：预设档直接用预设表；自定义档校验失败则整体回落默认（避免半套引脚
       启动，把设备带进「屏不亮」的不可诊断状态）。 */
    if (s_cfg.gpio_preset >= GPIO_PRESET_COUNT) s_cfg.gpio_preset = GPIO_PRESET_DEFAULT;
    if (s_cfg.gpio_preset == GPIO_PRESET_CUSTOM) {
        if (!pin_cfg_valid(&s_cfg.pins)) {
            ESP_LOGW(TAG, "custom pin map invalid, fallback to default preset");
            s_cfg.gpio_preset = GPIO_PRESET_DEFAULT;
            s_cfg.pins = PIN_PRESETS[GPIO_PRESET_DEFAULT];
        }
    } else {
        s_cfg.pins = PIN_PRESETS[s_cfg.gpio_preset];
    }

    ESP_LOGI(TAG, "panel=%u hflip=%u timeout=%lus action=%s wake=%lus wake_show=%u ssid='%s' open=%d",
             s_cfg.panel, s_cfg.hflip,
             (unsigned long)s_cfg.sleep_s,
             s_cfg.timeout_action == SETT_ACTION_OFF ? "off" : "sleep",
             (unsigned long)s_cfg.wake_s, s_cfg.wake_show,
             s_cfg.ap_ssid[0] ? s_cfg.ap_ssid : "(default)",
             s_cfg.ap_pass[0] == 0);
    ESP_LOGI(TAG, "gpio preset=%u ADC=%u WAKE=%u SCK=%u MOSI=%u CS=%u DC=%u RST=%u BUSY=%u",
             s_cfg.gpio_preset, s_cfg.pins.v[0], s_cfg.pins.v[1], s_cfg.pins.v[2],
             s_cfg.pins.v[3], s_cfg.pins.v[4], s_cfg.pins.v[5],
             s_cfg.pins.v[6], s_cfg.pins.v[7]);
    ESP_LOGI(TAG, "net: on=%u napt=%u saved=%u last=%d",
             s_cfg.net_on, s_cfg.napt_on, s_cfg.wifi_n,
             s_cfg.wifi_last == 0xFF ? -1 : (int)s_cfg.wifi_last);
    for (int i = 0; i < (int)s_cfg.wifi_n; i++)
        ESP_LOGI(TAG, "  wifi[%d] '%s'%s", i, s_cfg.wifi[i].ssid,
                 s_cfg.wifi[i].pass[0] ? "" : " (open)");
    ESP_LOGI(TAG, "remote mode=%u url='%s' slot=%d",
             s_cfg.remote_url[0] ? s_cfg.remote_url : "(none)",
             s_cfg.remote_slot == 0xFF ? -1 : (int)s_cfg.remote_slot);
}

const moink_settings_t *settings_get(void) { return &s_cfg; }
const pin_cfg_t *settings_pins(void) { return &s_cfg.pins; }

static void store_u8(const char *key, uint8_t v)
{
    if (s_ok && nvs_set_u8(s_nvs, key, v) != ESP_OK) ESP_LOGW(TAG, "set %s failed", key);
}

static void store_u32(const char *key, uint32_t v)
{
    if (s_ok && nvs_set_u32(s_nvs, key, v) != ESP_OK) ESP_LOGW(TAG, "set %s failed", key);
}

static void store_str(const char *key, const char *v)
{
    if (s_ok && nvs_set_str(s_nvs, key, v) != ESP_OK) ESP_LOGW(TAG, "set %s failed", key);
}

/* R1.0.8：commit 收敛到 setter 末尾，一次保存一次落盘（NVS 擦写均衡友好）。 */
static void settings_commit(void)
{
    if (s_ok) nvs_commit(s_nvs);
}

esp_err_t settings_set_panel(uint8_t v)
{
    if (v >= EPD_PANEL_COUNT) return ESP_ERR_INVALID_ARG;
    s_cfg.panel = v;
    store_u8("panel", v);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_hflip(uint8_t v)
{
    s_cfg.hflip = v ? 1 : 0;
    store_u8("hflip", s_cfg.hflip);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_wifi_pwr(uint8_t v)
{
    if (v > SETT_WIFI_PWR_LOW) return ESP_ERR_INVALID_ARG;
    s_cfg.wifi_pwr = v;
    store_u8("wifi_pwr", v);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_gpio(uint8_t preset, const pin_cfg_t *custom)
{
    pin_cfg_t applied;

    if (preset >= GPIO_PRESET_NPRESET) {
        /* 自定义档：必须整体合法才接受。 */
        if (preset != GPIO_PRESET_CUSTOM || !pin_cfg_valid(custom))
            return ESP_ERR_INVALID_ARG;
        applied = *custom;
    } else {
        applied = PIN_PRESETS[preset];
    }

    s_cfg.gpio_preset = preset;
    s_cfg.pins = applied;
    store_u8("gpio_preset", preset);
    for (int i = 0; i < PIN_IDX_COUNT; i++)
        store_u8(PIN_KEY[i], applied.v[i]);
    settings_commit();

    ESP_LOGI(TAG, "gpio set: preset=%u ADC=%u WAKE=%u SCK=%u MOSI=%u CS=%u DC=%u RST=%u BUSY=%u",
             preset, applied.v[0], applied.v[1], applied.v[2], applied.v[3],
             applied.v[4], applied.v[5], applied.v[6], applied.v[7]);
    return ESP_OK;
}

esp_err_t settings_set_sleep(uint32_t v)
{
    /* 仅接受档位值（或任意 >0 秒，上限 86400）。 */
    if (v > SETT_WAKE_1D) return ESP_ERR_INVALID_ARG;
    s_cfg.sleep_s = v;
    store_u32("sleep_s", v);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_wake(uint32_t v)
{
    if (v > SETT_WAKE_1D) return ESP_ERR_INVALID_ARG;
    s_cfg.wake_s = v;
    store_u32("wake_s", v);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_timeout_action(uint8_t v)
{
    if (v > SETT_ACTION_OFF) return ESP_ERR_INVALID_ARG;
    s_cfg.timeout_action = v;
    store_u8("to_act", v);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_line_ver(uint8_t v)
{
    if (v > LINE_VER_NEW) return ESP_ERR_INVALID_ARG;
    s_cfg.line_ver = v;
    store_u8("line_v", v);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_wake_show(uint8_t v)
{
    s_cfg.wake_show = v ? 1 : 0;
    store_u8("wake_show", s_cfg.wake_show);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_ap(const char *ssid, const char *pass)
{
    /* FB-014①：单字段更新 —— 任一参数为 NULL 表示「保持当前值」；
       pass 为空串表示清除密码（热点转开放）。两个都给则整体替换。 */
    if (!ssid && !pass) return ESP_ERR_INVALID_ARG;

    if (ssid) {
        if (!pass) pass = s_cfg.ap_pass;      /* 只改名字：密码保持不变 */
        if (strlen(ssid) >= SETT_SSID_MAX || strlen(pass) >= SETT_PASS_MAX)
            return ESP_ERR_INVALID_ARG;
        strlcpy(s_cfg.ap_ssid, ssid, SETT_SSID_MAX);
        strlcpy(s_cfg.ap_pass, pass, SETT_PASS_MAX);
        store_str("ap_ssid", s_cfg.ap_ssid);
        store_str("ap_pass", s_cfg.ap_pass);
    } else {
        /* 只改密码：热点名保持不变。 */
        if (strlen(pass) >= SETT_PASS_MAX) return ESP_ERR_INVALID_ARG;
        strlcpy(s_cfg.ap_pass, pass, SETT_PASS_MAX);
        store_str("ap_pass", s_cfg.ap_pass);
    }
    settings_commit();
    return ESP_OK;
}

/* ---------------- 多 WiFi 记忆（R1.3.5） ----------------
 *
 * 存储布局：u8 计数（键 "wn"）+ 定长数组（键 "wlist"，784 B）。
 * 用 blob 而非 16 个逐键记录：增删改都要整体重排，「一次读、一次写」比逐键循环
 * 更不容易出现「计数与内容不同步」。数组为空时删掉 blob，避免残留旧数据。
 */

static void store_wifi_list(void)
{
    if (!s_ok) return;
    nvs_set_u8(s_nvs, "wn", s_cfg.wifi_n);
    if (s_cfg.wifi_n > 0)
        nvs_set_blob(s_nvs, "wlist", s_cfg.wifi, sizeof(s_cfg.wifi));
    else
        nvs_erase_key(s_nvs, "wlist");   /* 键不存在返回 NOT_FOUND，忽略 */
    settings_commit();
}

int settings_wifi_count(void) { return (int)s_cfg.wifi_n; }

const sett_wifi_t *settings_wifi_at(int i)
{
    if (i < 0 || i >= (int)s_cfg.wifi_n) return NULL;
    return &s_cfg.wifi[i];
}

esp_err_t settings_wifi_add(const char *ssid, const char *pass)
{
    if (!ssid || !ssid[0]) return ESP_ERR_INVALID_ARG;
    if (strlen(ssid) >= SETT_SSID_MAX) return ESP_ERR_INVALID_ARG;
    if (pass && strlen(pass) >= SETT_PASS_MAX) return ESP_ERR_INVALID_ARG;

    /* 已存在同名 SSID：只更新密码，并挪到首位（下次优先试它）。 */
    int idx = -1;
    for (int i = 0; i < (int)s_cfg.wifi_n; i++) {
        if (strcmp(s_cfg.wifi[i].ssid, ssid) == 0) { idx = i; break; }
    }

    if (idx >= 0) {
        strlcpy(s_cfg.wifi[idx].pass, pass ? pass : "", SETT_PASS_MAX);
        if (idx != 0) {
            sett_wifi_t tmp = s_cfg.wifi[idx];
            memmove(&s_cfg.wifi[1], &s_cfg.wifi[0], sizeof(sett_wifi_t) * (size_t)idx);
            s_cfg.wifi[0] = tmp;
        }
    } else {
        /* 满了就挤掉最后一个，给新网络腾位置。 */
        if (s_cfg.wifi_n >= SETT_WIFI_MAX) s_cfg.wifi_n = SETT_WIFI_MAX - 1;
        memmove(&s_cfg.wifi[1], &s_cfg.wifi[0],
                sizeof(sett_wifi_t) * (size_t)s_cfg.wifi_n);
        strlcpy(s_cfg.wifi[0].ssid, ssid, SETT_SSID_MAX);
        strlcpy(s_cfg.wifi[0].pass, pass ? pass : "", SETT_PASS_MAX);
        s_cfg.wifi_n++;
    }

    s_cfg.wifi_last = 0;
    store_wifi_list();
    ESP_LOGI(TAG, "wifi add '%s': now %u saved", ssid, s_cfg.wifi_n);
    return ESP_OK;
}

esp_err_t settings_wifi_remove(int i)
{
    if (i < 0 || i >= (int)s_cfg.wifi_n) return ESP_ERR_INVALID_ARG;

    memmove(&s_cfg.wifi[i], &s_cfg.wifi[i + 1],
            sizeof(sett_wifi_t) * (size_t)(s_cfg.wifi_n - i - 1));
    s_cfg.wifi_n--;
    memset(&s_cfg.wifi[s_cfg.wifi_n], 0, sizeof(sett_wifi_t));

    /* 同步修正「上次成功」指针 */
    if (s_cfg.wifi_last == i)                 s_cfg.wifi_last = 0xFF;
    else if (s_cfg.wifi_last != 0xFF && s_cfg.wifi_last > i) s_cfg.wifi_last--;

    store_wifi_list();
    ESP_LOGI(TAG, "wifi remove #%d: now %u saved", i, s_cfg.wifi_n);
    return ESP_OK;
}

esp_err_t settings_wifi_clear(void)
{
    s_cfg.wifi_n = 0;
    s_cfg.wifi_last = 0xFF;
    memset(s_cfg.wifi, 0, sizeof(s_cfg.wifi));
    store_wifi_list();
    ESP_LOGI(TAG, "wifi list cleared");
    return ESP_OK;
}

void settings_wifi_mark_ok(int i)
{
    if (i < 0 || i >= (int)s_cfg.wifi_n) return;
    if (s_cfg.wifi_last == (uint8_t)i) return;   /* 没变就不写 NVS，省擦写 */
    s_cfg.wifi_last = (uint8_t)i;
    store_u8("wifi_last", s_cfg.wifi_last);
    settings_commit();
}

esp_err_t settings_set_net(uint8_t on)
{
    s_cfg.net_on = on ? 1 : 0;
    store_u8("net_on", s_cfg.net_on);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_napt(uint8_t on)
{
    s_cfg.napt_on = on ? 1 : 0;
    store_u8("napt_on", s_cfg.napt_on);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_remote_mode(uint8_t v)
{
    if (v > SETT_REMOTE_MF) return ESP_ERR_INVALID_ARG;
    s_cfg.remote_mode = v;
    store_u8("r_mode", v);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_remote_url(const char *url)
{
    if (!url) return ESP_OK;                 /* NULL = 保持当前值 */
    if (strlen(url) >= SETT_URL_MAX) return ESP_ERR_INVALID_ARG;
    strlcpy(s_cfg.remote_url, url, SETT_URL_MAX);
    store_str("r_url", s_cfg.remote_url);
    settings_commit();
    return ESP_OK;
}

esp_err_t settings_set_remote_auth(const char *user, const char *pass)
{
    if (!user && !pass) return ESP_OK;
    if (user) {
        if (strlen(user) >= SETT_USER_MAX) return ESP_ERR_INVALID_ARG;
        strlcpy(s_cfg.remote_user, user, SETT_USER_MAX);
        store_str("r_user", s_cfg.remote_user);
    }
    if (pass) {
        if (strlen(pass) >= SETT_RPASS_MAX) return ESP_ERR_INVALID_ARG;
        strlcpy(s_cfg.remote_pass, pass, SETT_RPASS_MAX);
        store_str("r_pass", s_cfg.remote_pass);
    }
    settings_commit();
    return ESP_OK;
}

void settings_remote_mark(uint8_t slot, uint32_t crc)
{
    s_cfg.remote_slot = slot;
    s_cfg.remote_crc  = crc;
    store_u8("r_slot", slot);
    store_u32("r_crc", crc);
    settings_commit();
}

void settings_factory_reset(void)
{
    /* R1.2.0（FB-015）：整个命名空间一起擦 —— 「恢复出厂」就该回到出厂状态。
       R1.4.0（FB-027）起没有页面热更，web_len / web_crc / page_ver 这些旧键
       出现在老设备上也只是被 nvs_erase_all 一并清掉，不影响流程。 */
    if (s_ok) {
        nvs_erase_all(s_nvs);
        nvs_commit(s_nvs);
    }
    s_cfg = DEFAULTS;
    ESP_LOGW(TAG, "factory reset: nvs namespace erased");
}

void settings_reset_for_upgrade(void)
{
    /* R1.2.2：升级**不再强制重置设置**，只清理「本版已经不存在、留着会让旧值被
       误读」的废弃键；其余用户设置（屏型 / 翻转 / 功率 / GPIO 接法 / 休眠 / 唤醒 /
       热点凭据）一律原样保留。
       回退到全量重置会误伤真正描述硬件的项：R1.2.0 的重置会让 A1 设备升级后按 A0
       驱动、让排线 / 整合板接线按默认引脚启动，用户升级完得重新配一遍，甚至先看到
       「屏不亮」。 */
    static const char *DROP_KEYS[] = {
        "a1_mode",   /* R1.2.2：A1 只剩 768x552 顺序一档，旧档位值 1..4 已无对应含义 */
        "a11_var",   /* R1.2.0：A1.1 诊断变体整体删除 */
        "exp_pll",   /* 120Hz 实验项已整体移除（2026-11-16），旧键顺手清掉 */
    };

    if (s_ok) {
        for (size_t i = 0; i < sizeof(DROP_KEYS) / sizeof(DROP_KEYS[0]); i++)
            nvs_erase_key(s_nvs, DROP_KEYS[i]);   /* 键不存在时返回 NOT_FOUND，忽略即可 */
        nvs_commit(s_nvs);
    }

    ESP_LOGW(TAG, "upgrade: dropped %u obsolete key(s), settings kept (panel=%u preset=%u)",
             (unsigned)(sizeof(DROP_KEYS) / sizeof(DROP_KEYS[0])),
             (unsigned)s_cfg.panel, (unsigned)s_cfg.gpio_preset);
}
