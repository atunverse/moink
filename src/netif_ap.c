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
#define AP_CHANNEL  1

static esp_netif_t *s_ap = NULL;
static char s_ssid[SETT_SSID_MAX];

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
