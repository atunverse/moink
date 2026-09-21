#include "netif_ap.h"
#include "settings.h"

#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "esp_log.h"

#include <string.h>
#include <stdio.h>

static const char *TAG = "netif_ap";

#define AP_MAX_CONN 4
/* R1.0.10：信道 1→6。SuperMini 部分批次板载天线阻抗失配 + 40MHz 晶振
   60 次谐波落在 2400~2412MHz（信道 1 频段），信道 6 避开谐波密集区，
   对正常批次无副作用（FB-001）。 */
#define AP_CHANNEL  6

static esp_netif_t *s_ap = NULL;
static char s_ssid[SETT_SSID_MAX];

void netif_ap_apply_tx_power(void)
{
    /* esp_wifi_set_max_tx_power 单位 0.25dBm：高 18dBm=72 / 中 10dBm=40 /
       低 8.5dBm=34。低档针对天线阻抗失配批次——反射失真随功率升高而加重，
       社区实测降功率反而改善连接（FB-001）。phy 层上限已在 sdkconfig 收到 18。 */
    static const int PWR_QDBM[] = { 72, 40, 34 };
    const moink_settings_t *s = settings_get();
    uint8_t lvl = s->wifi_pwr;
    if (lvl > SETT_WIFI_PWR_LOW) lvl = SETT_WIFI_PWR_HIGH;

    esp_err_t err = esp_wifi_set_max_tx_power((int8_t)PWR_QDBM[lvl]);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "set_max_tx_power(%d) failed: %s", PWR_QDBM[lvl], esp_err_to_name(err));
        return;
    }
    int8_t actual = 0;
    if (esp_wifi_get_max_tx_power(&actual) == ESP_OK)
        ESP_LOGI(TAG, "wifi tx power level %u (%d qdBm, actual %d)", lvl, PWR_QDBM[lvl], (int)actual);
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
        wifi_event_ap_staconnected_t *e = (wifi_event_ap_staconnected_t *)data;
        ESP_LOGI(TAG, "station " MACSTR " joined", MAC2STR(e->mac));
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STADISCONNECTED) {
        wifi_event_ap_stadisconnected_t *e = (wifi_event_ap_stadisconnected_t *)data;
        ESP_LOGI(TAG, "station " MACSTR " left", MAC2STR(e->mac));
    }
}

static void build_ssid(char *out, size_t n)
{
    const moink_settings_t *s = settings_get();
    if (s->ap_ssid[0]) {
        strlcpy(out, s->ap_ssid, n);
        return;
    }
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(out, n, "MoInk-%02X%02X", mac[4], mac[5]);
}

void netif_ap_init(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_ap = esp_netif_create_default_wifi_ap();

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));

    netif_ap_apply();
}

void netif_ap_apply(void)
{
    const moink_settings_t *s = settings_get();
    build_ssid(s_ssid, sizeof(s_ssid));

    wifi_config_t ap = { 0 };
    strlcpy((char *)ap.ap.ssid, s_ssid, sizeof(ap.ap.ssid));
    ap.ap.ssid_len = (uint8_t)strlen(s_ssid);
    ap.ap.channel = AP_CHANNEL;
    ap.ap.max_connection = AP_MAX_CONN;

    if (s->ap_pass[0]) {
        ap.ap.authmode = WIFI_AUTH_WPA2_PSK;
        strlcpy((char *)ap.ap.password, s->ap_pass, sizeof(ap.ap.password));
    } else {
        ap.ap.authmode = WIFI_AUTH_OPEN;
    }

    /* R1.0.8：运行时改热点配置不再用 ESP_ERROR_CHECK（失败即 abort 重启），
       记录错误并让现有 AP 继续跑。 */
    esp_err_t e1 = esp_wifi_set_config(WIFI_IF_AP, &ap);
    if (e1 != ESP_OK) ESP_LOGE(TAG, "set_config failed: %s", esp_err_to_name(e1));
    esp_err_t e2 = esp_wifi_start();
    if (e2 != ESP_OK) ESP_LOGE(TAG, "wifi start failed: %s", esp_err_to_name(e2));

    netif_ap_apply_tx_power();

    /* DHCP 下发 DNS = 网关自身，captive portal 探测更快命中。 */
    uint32_t dns = esp_ip4addr_aton("192.168.4.1");
    esp_netif_dhcps_option(s_ap, ESP_NETIF_OP_SET,
                           ESP_NETIF_DOMAIN_NAME_SERVER, &dns, sizeof(dns));

    ESP_LOGI(TAG, "SoftAP '%s' up (open=%d, max %d)",
             s_ssid, s->ap_pass[0] == 0, AP_MAX_CONN);
}

int netif_ap_client_count(void)
{
    wifi_sta_list_t list;
    if (esp_wifi_ap_get_sta_list(&list) != ESP_OK) return 0;
    return list.num;
}

const char *netif_ap_ssid(void) { return s_ssid; }
