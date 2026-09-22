#include "settings.h"
#include "epd_drv.h"

#include "nvs.h"
#include "nvs_flash.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "settings";

#define NVS_NS "moink"

static const moink_settings_t DEFAULTS = {
    .panel    = EPD_PANEL_A0,
    .hflip    = 0,
    .a11_var  = 1,
    .wifi_pwr = SETT_WIFI_PWR_HIGH,
    .sleep_s  = SETT_SLEEP_3MIN,
    .wake_s   = SETT_WAKE_OFF,
    .ap_ssid  = "",
    .ap_pass  = "",
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
    char tmp[SETT_PASS_MAX];
    if (nvs_get_str(s_nvs, key, tmp, &need) == ESP_OK) strlcpy(out, tmp, n);
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
    read_u8("a11_var", &s_cfg.a11_var);
    read_u8("wifi_pwr", &s_cfg.wifi_pwr);
    read_u32("sleep_s", &s_cfg.sleep_s);
    read_u32("wake_s",  &s_cfg.wake_s);
    read_str("ap_ssid", s_cfg.ap_ssid, SETT_SSID_MAX);
    read_str("ap_pass", s_cfg.ap_pass, SETT_PASS_MAX);

    ESP_LOGI(TAG, "panel=%u hflip=%u sleep=%lus wake=%lus ssid='%s' open=%d",
             s_cfg.panel, s_cfg.hflip,
             (unsigned long)s_cfg.sleep_s, (unsigned long)s_cfg.wake_s,
             s_cfg.ap_ssid[0] ? s_cfg.ap_ssid : "(default)",
             s_cfg.ap_pass[0] == 0);
}

const moink_settings_t *settings_get(void) { return &s_cfg; }

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

esp_err_t settings_set_a11_var(uint8_t v)
{
    if (v < 1 || v > 8) v = 1;
    s_cfg.a11_var = v;
    store_u8("a11_var", v);
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

esp_err_t settings_set_ap(const char *ssid, const char *pass)
{
    if (!ssid || !pass) return ESP_ERR_INVALID_ARG;
    if (strlen(ssid) >= SETT_SSID_MAX || strlen(pass) >= SETT_PASS_MAX)
        return ESP_ERR_INVALID_ARG;

    strlcpy(s_cfg.ap_ssid, ssid, SETT_SSID_MAX);
    strlcpy(s_cfg.ap_pass, pass, SETT_PASS_MAX);
    store_str("ap_ssid", s_cfg.ap_ssid);
    store_str("ap_pass", s_cfg.ap_pass);
    settings_commit();
    return ESP_OK;
}

void settings_factory_reset(void)
{
    /* 只清「设置类」键；web_len/web_crc/page_ver（页面热更标记）保留——
       页面热更是系统资产而非用户数据，恢复出厂后无需重新上传页面
       （旧实现 nvs_erase_all 连页面标记一起擦，导致回退内嵌页）。 */
    static const char *KEYS[] = { "panel", "hflip", "a11_var", "wifi_pwr", "sleep_s", "wake_s", "ap_ssid", "ap_pass" };
    if (s_ok) {
        for (int i = 0; i < (int)(sizeof(KEYS) / sizeof(KEYS[0])); i++)
            nvs_erase_key(s_nvs, KEYS[i]);
        nvs_commit(s_nvs);
    }
    s_cfg = DEFAULTS;
    ESP_LOGW(TAG, "factory reset: settings cleared (web page kept)");
}
