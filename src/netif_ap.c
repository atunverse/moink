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
#include <stdlib.h>     /* calloc / free / qsort（扫描结果临时缓冲） */

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
 * 热点 DHCP 一律下发门户地址 192.168.4.1（R1.3.5，2026-11-06 修订）。
 *
 * 沿革：早先 NAPT 生效时把 DHCP DNS 换成上游，是因为 IDF 的 NAPT 不带 DNS relay，
 * 不换手机就解析不了域名。代价是客户端在租约内一直用上游，设备插不上手。
 *
 * 现在改由 captive 任务自己做 DNS 转发（前 60 秒只劫持系统探测域名，之后全部
 * 放行），所以这里保持固定值 —— 一旦在 NAPT 时换掉，客户端就绕过设备了，
 * 「有网也弹一次」的时间窗根本不成立。
 */
static void dns_set_portal(void)
{
    if (!s_ap) return;

    esp_ip4_addr_t dns;
    dns.addr = esp_ip4addr_aton("192.168.4.1");
    dns_apply(dns);
}

/* ---------------- NAPT ---------------- */

static void napt_apply(bool on)
{
    if (!s_ap || !s_sta) return;

    bool want = on && settings_get()->napt_on;
    if (want == s_napt) return;

    /* ★ 必须传 AP 网卡（内网侧），不能传 STA。
       lwIP 的 ip4_napt_enable() 是「按 IP 找网卡」来决定哪一侧算内网：
       传 STA（192.168.1.26）会让手机来的 192.168.4.x 完全不匹配，包一个都不转发，
       表现为 esp_netif_napt_enable() 返回 OK、状态显示已启用，但实际不通。 */
    esp_err_t e = want ? esp_netif_napt_enable(s_ap) : esp_netif_napt_disable(s_ap);
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
            /* 开一次 60 秒门户窗口：这段时间里只劫持系统探测域名，
               让手机必定弹一次登录页，同时网络本身仍可用。 */
            captive_portal_arm();
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
            /* 链路断了就撤掉转发，回到「纯热点」状态（DNS 始终是门户地址，不用动）。 */
            napt_apply(false);
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
    /* 热点配置重建会把 DNS 打回默认值，这里显式重设一次（幂等，值没变就不重启 DHCP）。 */
    dns_set_portal();

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
}

bool netif_upstream_dns(uint32_t *ip_be)
{
    if (!ip_be || !s_sta || !s_sta_up) return false;

    esp_netif_dns_info_t up = { 0 };
    if (esp_netif_get_dns_info(s_sta, ESP_NETIF_DNS_MAIN, &up) != ESP_OK) return false;
    if (up.ip.type != ESP_IPADDR_TYPE_V4) return false;
    if (up.ip.u_addr.ip4.addr == 0) return false;

    *ip_be = up.ip.u_addr.ip4.addr;
    return true;
}

void netif_shutdown_before_sleep(void)
{
    /* 深睡会 esp_wifi_stop()，先把 NAPT 撤掉，别让 lwIP 带着转发状态被硬停。 */
    if (s_napt && s_ap) {
        esp_netif_napt_disable(s_ap);
        s_napt = false;
    }
}

/* ---------------- 扫描附近 AP（配网用） ----------------
 *
 * 只在用户点「扫描」时调用一次。为什么不做定时扫描：扫描要逐信道跳，
 * 射频一离开 AP 信道，热点内客户端就收不到包（1~2 s），已连的 STA 甚至可能瞬断。
 *
 * 内存：wifi_ap_record_t 约 112 B/条，最多取 32 条 ⇒ 3.6 KB 临时堆，
 * 扫完立刻释放；不占静态 RAM，也不放在 httpd 的 4 KB 栈上。
 */
#define SCAN_MAX_REC 32

static int cmp_rssi_desc(const void *a, const void *b)
{
    const netif_scan_t *x = (const netif_scan_t *)a;
    const netif_scan_t *y = (const netif_scan_t *)b;
    return (int)y->rssi - (int)x->rssi;      /* 强信号在前 */
}

int netif_sta_scan(netif_scan_t *out, int max)
{
    if (!out || max <= 0) return -1;

    wifi_scan_config_t cfg = { 0 };
    cfg.ssid        = NULL;
    cfg.bssid       = NULL;
    cfg.channel     = 0;                     /* 0 = 全信道 */
    cfg.show_hidden = false;                 /* 隐藏 SSID 无法选中，不列 */
    cfg.scan_type   = WIFI_SCAN_TYPE_ACTIVE;
    cfg.scan_time.active.min = 80;           /* ms/信道：13 信道约 1.0~1.6 s */
    cfg.scan_time.active.max = 120;

    esp_err_t e = esp_wifi_scan_start(&cfg, true);   /* true = 阻塞到扫完 */
    if (e != ESP_OK) {
        ESP_LOGW(TAG, "scan start failed: %s", esp_err_to_name(e));
        return -2;
    }

    uint16_t n = 0;
    if (esp_wifi_scan_get_ap_num(&n) != ESP_OK || n == 0) {
        esp_wifi_clear_ap_list();
        return 0;
    }
    if (n > SCAN_MAX_REC) n = SCAN_MAX_REC;

    wifi_ap_record_t *rec = calloc(n, sizeof(wifi_ap_record_t));
    if (!rec) {
        esp_wifi_clear_ap_list();
        return -3;
    }

    uint16_t got = n;
    e = esp_wifi_scan_get_ap_records(&got, rec);
    esp_wifi_clear_ap_list();                /* 释放驱动内部列表 */
    if (e != ESP_OK) {
        free(rec);
        return -3;
    }

    int cnt = 0;
    for (int i = 0; i < (int)got && cnt < max; i++) {
        const char *ssid = (const char *)rec[i].ssid;
        if (!ssid[0]) continue;                       /* 空 SSID（隐藏网络） */
        if (strcmp(ssid, s_ssid) == 0) continue;      /* 跳过自己的热点 */

        /* 同一 SSID 可能有多个 AP（mesh / 双频同名），只留最强的那条。 */
        int dup = -1;
        for (int k = 0; k < cnt; k++) {
            if (strcmp(out[k].ssid, ssid) == 0) { dup = k; break; }
        }
        if (dup >= 0) {
            if (rec[i].rssi > out[dup].rssi) out[dup].rssi = rec[i].rssi;
            continue;
        }

        strlcpy(out[cnt].ssid, ssid, sizeof(out[cnt].ssid));
        out[cnt].rssi = rec[i].rssi;
        out[cnt].lock = (rec[i].authmode != WIFI_AUTH_OPEN) ? 1 : 0;
        cnt++;
    }

    free(rec);
    qsort(out, (size_t)cnt, sizeof(netif_scan_t), cmp_rssi_desc);

    ESP_LOGI(TAG, "scan: %u ap(s), %d listed", (unsigned)got, cnt);
    return cnt;
}
