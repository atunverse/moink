#ifndef MOINK_NETIF_AP_H
#define MOINK_NETIF_AP_H

#include "esp_err.h"

/*
 * 纯 SoftAP 网络层：没有任何 STA / 配网代码。固件只当热点给手机传图。
 * 热点默认开放（无密码），SSID 默认 MoInk-XXXX（XXXX = MAC 末 4 位）；
 * 用户可在设置页改 SSID / 密码，改后调用 netif_ap_apply() 即时生效。
 */

/* 初始化 netif + 事件循环 + 仅 AP 的 WiFi，并按当前设置启动热点。 */
void netif_ap_init(void);

/* 重新应用设置（SSID / 密码变更后调用），幂等。 */
void netif_ap_apply(void);

/* 按当前设置的功率档位调整发射功率（高 18dBm / 中 10dBm / 低 8.5dBm）。
 * 启动时与页面改档后调用，幂等。 */
void netif_ap_apply_tx_power(void);

/* 当前已连接 STA 数（供 /api/info 展示）。 */
int netif_ap_client_count(void);

/* 生效中的热点 SSID（默认或用户设置）。 */
const char *netif_ap_ssid(void);

#endif /* MOINK_NETIF_AP_H */
