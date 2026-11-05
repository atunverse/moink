#ifndef MOINK_NETIF_AP_H
#define MOINK_NETIF_AP_H

#include <stdbool.h>
#include "esp_err.h"

/*
 * 网络层：SoftAP（手机连设备传图）+ 可选 STA（设备连上游 WiFi）。
 *
 * AP 侧行为与 R1.3.4 完全一致：热点默认开放、SSID 默认 MoInk-XXXX、
 * 用户可改 SSID/密码，改后调 netif_ap_apply() 即时生效。
 *
 * STA 侧（R1.3.5 新增）：
 *   - 设备记住最多 SETT_WIFI_MAX 个上游 WiFi，唤醒/开机后按
 *     「上次成功的优先，其余按保存顺序」依次尝试，任一成功即停；
 *   - 全部失败则静默退避重试，不影响热点与本地功能；
 *   - 连上后若 napt_on 打开，则让热点内的设备经 STA 上网（NAPT）。
 *
 * ★ 关键约束：STA 连接与 AP 使用同一射频，AP 信道会自动跟随 STA。
 *   因此原来固定的 AP_CHANNEL (=6，为避开晶振谐波) 只在未连 STA 时生效。
 */

/* 初始化 netif + 事件循环 + WiFi（APSTA 模式），并按当前设置启动热点。
 * STA 不会自动开始，需再调 netif_sta_start()。 */
void netif_ap_init(void);

/* 重新应用热点设置（SSID / 密码变更后调用），幂等。 */
void netif_ap_apply(void);

/* 按当前设置的功率档位调整发射功率（高 18dBm / 中 10dBm / 低 8.5dBm）。
 * 启动时与页面改档后调用，幂等。 */
void netif_ap_apply_tx_power(void);

/* 当前已连接 STA 数（供 /api/info 展示）。 */
int netif_ap_client_count(void);

/* 生效中的热点 SSID（默认或用户设置）。 */
const char *netif_ap_ssid(void);

/* ---------------- STA（R1.3.5） ---------------- */

/* 启动 STA 连接任务。幂等：重复调用只保证任务存在。 */
void netif_sta_start(void);

/* 设置变更后重新尝试连接（会先断开当前连接）。 */
void netif_sta_reconnect(void);

/* 已连上且拿到 IP。 */
bool netif_sta_connected(void);

/* 当前连接的 SSID；未连上返回空串。 */
const char *netif_sta_ssid(void);

/* 点分十进制 IP；未连上返回空串。 */
const char *netif_sta_ip(void);

/* 信号强度 dBm；未连上返回 0。 */
int netif_sta_rssi(void);

/* 当前正尝试的第几个网络（-1 = 未在尝试），供页面显示进度。 */
int netif_sta_trying(void);

/* NAPT 是否已启用（热点转发实际生效中）。 */
bool netif_napt_active(void);

/* 设置里的 napt_on 改变后调用：立即按新开关重估转发与上游 DNS，不打断 STA 连接。 */
void netif_napt_refresh(void);

#endif /* MOINK_NETIF_AP_H */
