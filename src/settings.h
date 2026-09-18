#ifndef MOINK_SETTINGS_H
#define MOINK_SETTINGS_H

#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

/*
 * 持久化设置（NVS）。页面所有画面参数（风格 / 强度 / 文字 / 旋转…）都留在手机
 * localStorage，固件只存会影响「传输与电源」的这几项。
 */

#define SETT_SSID_MAX 33
#define SETT_PASS_MAX 65

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

typedef struct {
    uint8_t  panel;     /* EPD_PANEL_A0 / EPD_PANEL_A1 */
    uint8_t  hflip;     /* 0/1 水平翻转 */
    uint32_t sleep_s;   /* 空闲后深睡；0 = 不休眠 */
    uint32_t wake_s;    /* 定时自动唤醒间隔；0 = 关闭 */
    char     ap_ssid[SETT_SSID_MAX];  /* 空 = 用默认 MoInk-XXXX */
    char     ap_pass[SETT_PASS_MAX];  /* 空 = 热点开放 */
} moink_settings_t;

void settings_init(void);
const moink_settings_t *settings_get(void);

/* 各 setter 立即写 NVS；失败仅告警不影响 RAM 态。 */
esp_err_t settings_set_panel(uint8_t v);
esp_err_t settings_set_hflip(uint8_t v);
esp_err_t settings_set_sleep(uint32_t v);
esp_err_t settings_set_wake(uint32_t v);
esp_err_t settings_set_ap(const char *ssid, const char *pass);

/* 恢复出厂：擦除本命名空间并写回默认值。 */
void settings_factory_reset(void);

#endif /* MOINK_SETTINGS_H */
