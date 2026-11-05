#include "netif_ap.h"
#include "settings.h"
#include "captive.h"

#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

#include <string.h>
#include <stdio.h>

static const char *TAG = "netif_ap";

#define AP_MAX_CONN 4
/* R1.0.10：信道 1→6。SuperMini 部分批次板载天线阻抗失配 + 40MHz 晶振
   60 次谐波落在 2400~2412MHz（信道 1 频段），信道 6 避开谐波密集区，
   对正常批次无副作用（FB-001）。
   ★ R1.3.5：仅在「STA 未连接」时生效 —— APSTA 共用一个射频，STA 连上后
   信道必须跟随 STA，否则连不通。 */
#define AP_CHANNEL  6

/* STA 单个网络的等待上限。路由器重启/弱信号时留足余量，但也不能太久，
   否则列表里 3 个网络要等 36 s。 */
#define STA_CONNECT_TIMEOUT_MS 12000
/* 全部网络都失败后的退避重试间隔。 */
#define STA_RETRY_BACKOFF_MS   15000

static esp_netif_t *s_ap  = NULL;
static esp_netif_t *s_sta = NULL;
static char s_ssid[SETT_SSID_MAX];

/* ---- STA 运行态 ----
   s_sta_up / s_sta_result 由事件回调写、连接任务与 HTTP 读；
   bool/int 的读写在本平台是原子的，最坏情况读到上一拍的值，不影响正确性。 */
static volatile bool s_sta_up   = false;
static volatile int  s_sta_result = 0;      /* 1 = 已拿到 IP，0 = 失败 */
static volatile int  s_try_idx  = -1;       /* 正在尝试的列表下标，-1 = 空闲 */
static char s_sta_ssid[SETT_SSID_MAX];
static char s_sta_ip[16];
static bool s_napt = false;
static bool s_task_started = false;
static TaskHandle_t s_sta_task = NULL;      /* 连接任务句柄，用于提前唤醒 */
static SemaphoreHandle_t s_sta_done = NULL; /* 二值信号量：事件 → 连接任务 */

/* 上一次写给 DHCP 的 DNS，避免每次 GOT_IP 都重启 DHCP 服务（会打断已连客户端续租）。 */
static uint32_t s_dns_last = 0;

/* ---------------- DHCP / 门户 ---------------- */

static void configure_dhcp_portal(void)
{
    /* DHCP 选项只能在服务停止时修改。此前把 IP 地址本身传给
       ESP_NETIF_DOMAIN_NAME_SERVER（该选项实际只接收 1 字节开关），调用会失败。 */
    esp_err_t err = esp_netif_dhcps_stop(s_ap);
    if (err != ESP_OK && err != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED) {
        ESP_LOGW(TAG, "stop DHCP server failed: %s", esp_err_to_name(err));
    }

    esp_netif_dns_info_t dns = { 0 };
    dns.ip.type = ESP_IPADDR_TYPE_V4;
    dns.ip.u_addr.ip4.addr = esp_ip4addr_aton("192.168.4.1");
    err = esp_netif_set_dns_info(s_ap, ESP_NETIF_DNS_MAIN, &dns);
    if (err != ESP_OK) ESP_LOGW(TAG, "set DHCP DNS failed: %s", esp_err_to_name(err));
    s_dns_last = dns.ip.u_addr.ip4.addr;   /* 与 dns_apply() 的缓存保持一致 */

    uint8_t dns_offer = 1;
    err = esp_netif_dhcps_option(s_ap, ESP_NETIF_OP_SET,
                                 ESP_NETIF_DOMAIN_NAME_SERVER,
                                 &dns_offer, sizeof(dns_offer));
    if (err != ESP_OK) ESP_LOGW(TAG, "enable DHCP DNS offer failed: %s", esp_err_to_name(err));

    /* 不下发 DHCP Option 114。该选项必须指向带可信 TLS 证书的 RFC 8908 JSON API，
       不能直接填写本机 HTTP 页面；错误下发会让 iOS 识别到无网络却不打开门户。
       纯离线 ESP32 热点继续使用兼容性更广的 DNS 劫持 + HTTP 探测重定向。 */

    err = esp_netif_dhcps_start(s_ap);
    if (err != ESP_OK && err != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED) {
        ESP_LOGW(TAG, "start DHCP server failed: %s", esp_err_to_name(err));
    }
}

/* 改写 DHCP 下发的 DNS。仅在值与上次不同时才重启 DHCP 服务。 */
static void dns_apply(esp_ip4_addr_t dns)
{
    if (!s_ap) return;
    if (dns.addr == s_dns_last) return;

    esp_netif_dhcps_stop(s_ap);
    esp_netif_dns_info_t info = { 0 };
    info.ip.type = ESP_IPADDR_TYPE_V4;
    info.ip.u_addr.ip4 = dns;
    esp_err_t e = esp_netif_set_dns_info(s_ap, ESP_NETIF_DNS_MAIN, &info);
    esp_netif_dhcps_start(s_ap);
    if (e == ESP_OK) {
        s_dns_last = dns.addr;
        ESP_LOGI(TAG, "DHCP DNS -> " IPSTR, IP2STR(&dns));
    } else {
        ESP_LOGW(TAG, "set upstream DNS failed: %s", esp_err_to_name(e));
    }
}

/*
 * NAPT 生效时，把热点 DHCP 下发的 DNS 换成上游 DNS。
 *
 * 为什么必须换：ESP-IDF 的 NAPT 只做 IP 转发，**不带 DNS relay**。
 * 若仍下发 192.168.4.1，手机能 ping 通 IP 却解析不了域名（表现为「连上了但没网」）。
 * NAPT 关闭时回落到本机地址，保留原有的门户劫持行为。
 */
static void dns_follow_upstream(bool use_upstream)
{
    if (!s_ap) return;

    esp_ip4_addr_t dns;
    bool got = false;

    if (use_upstream && s_napt && s_sta) {
        esp_netif_dns_info_t up = { 0 };
        if (esp_netif_get_dns_info(s_sta, ESP_NETIF_DNS_MAIN, &up) == ESP_OK &&
            up.ip.type == ESP_IPADDR_TYPE_V4 && up.ip.u_addr.ip4.addr != 0) {
            dns = up.ip.u_addr.ip4;
            got = true;
        }
    }
    if (!got) dns.addr = esp_ip4addr_aton("192.168.4.1");

    dns_apply(dns);
}

/* ---------------- NAPT ---------------- */

static void napt_apply(bool on)
{
    if (!s_sta) return;

    bool want = on && settings_get()->napt_on;
    if (want == s_napt) return;

    esp_err_t e = want ? esp_netif_napt_enable(s_sta) : esp_netif_napt_disable(s_sta);
    if (e == ESP_OK) {
        s_napt = want;
        ESP_LOGI(TAG, "napt %s", want ? "enabled (热点可上网)" : "disabled");
    } else {
        ESP_LOGW(TAG, "napt %s failed: %s", want ? "enable" : "disable",
                 esp_err_to_name(e));
    }
}

/* ---------------- 事件 ---------------- */

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;

    if (base == WIFI_EVENT) {
        if (id == WIFI_EVENT_AP_STACONNECTED) {
            wifi_event_ap_staconnected_t *e = (wifi_event_ap_staconnected_t *)data;
            ESP_LOGI(TAG, "station " MACSTR " joined", MAC2STR(e->mac));
            return;
        }
        if (id == WIFI_EVENT_AP_STADISCONNECTED) {
            wifi_event_ap_stadisconnected_t *e = (wifi_event_ap_stadisconnected_t *)data;
            ESP_LOGI(TAG, "station " MACSTR " left", MAC2STR(e->mac));
            captive_apple_station_disconnected();
            return;
        }
        if (id == WIFI_EVENT_STA_DISCONNECTED) {
            wifi_event_sta_disconnected_t *e = (wifi_event_sta_disconnected_t *)data;
            ESP_LOGW(TAG, "sta: disconnected (reason %d)", e->reason);
            s_sta_up = false;
            s_sta_ip[0] = '\0';
            /* 链路断了就把转发与上游 DNS 一起撤掉，回到「纯热点」状态。 */
            napt_apply(false);
            dns_follow_upstream(false);
            s_sta_result = 0;
            if (s_sta_done) xSemaphoreGive(s_sta_done);
            return;
        }
        return;
    }

    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        snprintf(s_sta_ip, sizeof(s_sta_ip), IPSTR, IP2STR(&e->ip_info.ip));

        wifi_ap_record_t ap;
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK)
            strlcpy(s_sta_ssid, (const char *)ap.ssid, sizeof(s_sta_ssid));

        s_sta_up = true;
        s_sta_result = 1;

        uint8_t primary = 0;
        wifi_second_chan_t second = WIFI_SECOND_CHAN_NONE;
        esp_wifi_get_channel(&primary, &second);
        ESP_LOGI(TAG, "sta: got ip %s on '%s' (ch %u)", s_sta_ip, s_sta_ssid, primary);

        napt_apply(true);
        dns_follow_upstream(true);

        if (s_sta_done) xSemaphoreGive(s_sta_done);
        return;
    }
}

/* ---------------- STA 连接任务 ---------------- */

static bool sta_try_all(void)
{
    int n = settings_wifi_count();
    if (n <= 0) return false;

    /* 上次成功的优先试：唤醒场景下大概率第一个就命中。 */
    int start = settings_get()->wifi_last;
    if (start < 0 || start >= n) start = 0;

    for (int k = 0; k < n; k++) {
        if (s_sta_up) return true;

        int idx = (start + k) % n;
        const sett_wifi_t *w = settings_wifi_at(idx);
        if (!w || !w->ssid[0]) continue;

        wifi_config_t sc = { 0 };
        strlcpy((char *)sc.sta.ssid, w->ssid, sizeof(sc.sta.ssid));
        strlcpy((char *)sc.sta.password, w->pass, sizeof(sc.sta.password));
        /* threshold = OPEN：允许连接开放网络与 WEP/WPA 老加密。
           安全性由上游决定，这里放宽以提高兼容性（NAS/老旧路由器场景）。 */
        sc.sta.threshold.authmode = WIFI_AUTH_OPEN;
        sc.sta.pmf_cfg.capable  = true;
        sc.sta.pmf_cfg.required = false;

        esp_err_t e = esp_wifi_set_config(WIFI_IF_STA, &sc);
        if (e != ESP_OK) {
            ESP_LOGW(TAG, "sta: set_config failed: %s", esp_err_to_name(e));
            continue;
        }

        s_try_idx = idx;
        s_sta_result = 0;
        xSemaphoreTake(s_sta_done, 0);      /* 清掉上一轮残留的信号 */

        ESP_LOGI(TAG, "sta: trying '%s' (%d/%d)", w->ssid, k + 1, n);
        e = esp_wifi_connect();
        if (e != ESP_OK) {
            ESP_LOGW(TAG, "sta: connect() failed: %s", esp_err_to_name(e));
            continue;
        }

        if (xSemaphoreTake(s_sta_done, pdMS_TO_TICKS(STA_CONNECT_TIMEOUT_MS)) == pdTRUE &&
            s_sta_result) {
            settings_wifi_mark_ok(idx);
            s_try_idx = -1;
            ESP_LOGI(TAG, "sta: connected to '%s' (%s)", w->ssid, s_sta_ip);
            return true;
        }

        ESP_LOGW(TAG, "sta: '%s' failed or timeout, trying next", w->ssid);
        esp_wifi_disconnect();
        vTaskDelay(pdMS_TO_TICKS(300));
    }

    s_try_idx = -1;
    return false;
}

static void sta_task(void *arg)
{
    (void)arg;
    s_sta_task = xTaskGetCurrentTaskHandle();

    for (;;) {
        const moink_settings_t *s = settings_get();

        if (!s->net_on || settings_wifi_count() == 0) {
            /* 用通知等待而不是死等：页面改设置后 netif_sta_reconnect() 能立刻叫醒。 */
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(2000));
            continue;
        }
        if (s_sta_up) {
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
            continue;
        }

        if (!sta_try_all()) {
            ESP_LOGW(TAG, "sta: all %d network(s) failed, retry in %d s",
                     settings_wifi_count(), STA_RETRY_BACKOFF_MS / 1000);
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(STA_RETRY_BACKOFF_MS));
        }
    }
}

/* ---------------- 对外 API ---------------- */

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

    /* 两个 netif 都必须在 esp_wifi_init() 之前创建（IDF 约定）。 */
    s_ap  = esp_netif_create_default_wifi_ap();
    s_sta = esp_netif_create_default_wifi_sta();

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    s_sta_done = xSemaphoreCreateBinary();
    configASSERT(s_sta_done);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));

    netif_ap_apply();
}

void netif_ap_apply(void)
{
    const moink_settings_t *s = settings_get();
    build_ssid(s_ssid, sizeof(s_ssid));

    wifi_config_t ap = { 0 };
    strlcpy((char *)ap.ap.ssid, s_ssid, sizeof(ap.ap.ssid));
    ap.ap.ssid_len = (uint8_t)strlen(s_ssid);

    /* ★ APSTA 共用一个射频：STA 已连接时 AP 必须停在 STA 的信道，
       此处若硬写 6 会把 STA 踢下线（或直接被驱动拒绝）。 */
    uint8_t ch = AP_CHANNEL;
    if (s_sta_up) {
        uint8_t primary = 0;
        wifi_second_chan_t second = WIFI_SECOND_CHAN_NONE;
        if (esp_wifi_get_channel(&primary, &second) == ESP_OK && primary) ch = primary;
    }
    ap.ap.channel = ch;
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
    if (e2 != ESP_OK && e2 != ESP_ERR_WIFI_STATE)
        ESP_LOGE(TAG, "wifi start failed: %s", esp_err_to_name(e2));

    netif_ap_apply_tx_power();

    configure_dhcp_portal();
    /* 热点配置重建会把 DNS 打回 192.168.4.1；若 NAPT 正在工作要立刻恢复上游 DNS，
       否则已连客户端会突然解析不了域名。 */
    dns_follow_upstream(s_sta_up);

    ESP_LOGI(TAG, "SoftAP '%s' up (open=%d, max %d, ch %u)",
             s_ssid, s->ap_pass[0] == 0, AP_MAX_CONN, ch);
}

int netif_ap_client_count(void)
{
    wifi_sta_list_t list;
    if (esp_wifi_ap_get_sta_list(&list) != ESP_OK) return 0;
    return list.num;
}

const char *netif_ap_ssid(void) { return s_ssid; }

/* ---------------- STA 对外 API ---------------- */

void netif_sta_start(void)
{
    if (s_task_started) return;
    s_task_started = true;
    /* 栈 3.5 KB：里面只有 esp_wifi_* 调用与日志，不解析协议。 */
    if (xTaskCreate(sta_task, "sta_conn", 3584, NULL, 4, NULL) != pdPASS) {
        s_task_started = false;
        ESP_LOGE(TAG, "create sta task failed");
    }
}

void netif_sta_reconnect(void)
{
    ESP_LOGI(TAG, "sta: reconnect requested");
    if (s_sta_up) esp_wifi_disconnect();   /* 触发 DISCONNECTED → 任务重新尝试 */
    if (s_sta_task) xTaskNotifyGive(s_sta_task);   /* 从退避等待里立刻醒来 */
}

bool netif_sta_connected(void) { return s_sta_up; }

const char *netif_sta_ssid(void) { return s_sta_up ? s_sta_ssid : ""; }
const char *netif_sta_ip(void)   { return s_sta_up ? s_sta_ip   : ""; }
int netif_sta_trying(void)       { return s_try_idx; }
bool netif_napt_active(void)     { return s_napt; }

int netif_sta_rssi(void)
{
    if (!s_sta_up) return 0;
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) return ap.rssi;
    return 0;
}

void netif_napt_refresh(void)
{
    napt_apply(s_sta_up);
    dns_follow_upstream(s_sta_up);
}
