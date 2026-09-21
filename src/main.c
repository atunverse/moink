/*
 * 墨印 · MoInk — 固件主装配（R 系列，重构版）
 *
 * 职责一句话：固件只做「热点 / 接收 / 刷图 / 休眠 / 唤醒 / OTA」，画面全部由页面
 * 在浏览器里合成。没有任何 STA 配网、没有拉图、没有固件端图像处理。
 *
 * 模块分工：
 *   epd_drv   锁定屏驱动（A0/A1，RST=GPIO3），不改
 *   settings  持久化：面板 / 翻转 / 休眠时长 / 自动唤醒 / 热点凭据
 *   netif_ap  纯 SoftAP（默认开放，SSID 默认 MoInk-XXXX）
 *   captive   DNS 劫持 + OS 探测劫持（连上即弹控制页）
 *   frame     帧接收（16B 头 + CRC16 校验）+ 显示触发
 *   power     电池 ADC / 深睡 / 唤醒源 / 空闲休眠
 *   ota_web   OTA 双槽 + 页面热更（web 分区）
 *
 * 路由：
 *   GET  /                控制页（web 分区优先，否则内嵌页）
 *   GET  /api/info        状态（版本 / 面板 / 堆 / 电量 / 客户端数）
 *   GET/POST /api/settings 读写设置
 *   POST /api/frame       传图
 *   POST /api/ota         固件升级
 *   POST /api/web         页面热更
 *   POST /api/clear       残影清理
 *   POST /api/factory     恢复出厂
 */
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <inttypes.h>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_sleep.h"
#include "nvs_flash.h"
#include "esp_http_server.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "version.h"
#include "epd_drv.h"
#include "settings.h"
#include "netif_ap.h"
#include "captive.h"
#include "frame.h"
#include "power.h"
#include "ota_web.h"

#if MOINK_EMBED_PAGE
#include "index_html.h"
#endif

static const char *TAG = "main";

#define HOLD_RESET_S    5          /* 长按恢复出厂 */
#define HTTPD_STACK     4096
#define HTTPD_MAX_URI   16

/* MOINK_EMBED_PAGE=OFF 时的占位页（提示上传完整页面）。 */
#if !MOINK_EMBED_PAGE
static const char FALLBACK_HTML[] =
    "<!doctype html><html><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>墨印 MoInk</title></head>"
    "<body style=\"font-family:system-ui;padding:2rem;max-width:30rem;margin:auto\">"
    "<h2>墨印 · MoInk</h2>"
    "<p>当前固件未内嵌控制页。请把完整页面通过 <code>POST /api/web</code> 上传到设备。</p>"
    "</body></html>";
#endif

/* ---------------- 请求小工具 ---------------- */

static void url_decode(char *s)
{
    char *r = s, *w = s;
    while (*r) {
        if (*r == '+') { *w++ = ' '; r++; }
        else if (*r == '%' && r[1] && r[2]) {
            int hi = 0, lo = 0;
            char h = r[1], l = r[2];
            hi = (h <= '9') ? h - '0' : ((h | 0x20) - 'a' + 10);
            lo = (l <= '9') ? l - '0' : ((l | 0x20) - 'a' + 10);
            *w++ = (char)((hi << 4) | lo);
            r += 3;
        } else { *w++ = *r++; }
    }
    *w = '\0';
}

/* 从 key=value&... 串里取值，命中返回 1，值经 URL 解码写入 out。 */
static int kv_get(const char *qs, const char *key, char *out, size_t outlen)
{
    size_t klen = strlen(key);
    const char *p = qs;
    while (p && *p) {
        const char *amp = strchr(p, '&');
        size_t seg = amp ? (size_t)(amp - p) : strlen(p);
        if (seg > klen && strncmp(p, key, klen) == 0 && p[klen] == '=') {
            size_t vlen = seg - klen - 1;
            if (vlen >= outlen) vlen = outlen - 1;
            memcpy(out, p + klen + 1, vlen);
            out[vlen] = '\0';
            url_decode(out);
            return 1;
        }
        p = amp ? amp + 1 : NULL;
    }
    return 0;
}

/* 读请求体到栈缓冲（限长），成功返回长度。
   R1.0.8：httpd_req_recv 单次可能短读（TCP 分段），必须循环收满；
   超出缓冲的部分读走丢弃，避免残体污染 keep-alive 的下一个请求。 */
static int read_body(httpd_req_t *req, char *buf, size_t n)
{
    size_t len = req->content_len;
    if (len == 0) return 0;
    size_t cap = (len > n - 1) ? n - 1 : len;
    size_t got = 0;
    while (got < len) {
        if (got < cap) {
            int k = httpd_req_recv(req, buf + got, cap - got);
            if (k <= 0) break;
            got += (size_t)k;
        } else {
            char sink[64];                    /* 溢出部分丢弃 */
            int k = httpd_req_recv(req, sink, sizeof(sink));
            if (k <= 0) break;
            got += (size_t)k;
        }
    }
    if (got == 0) return 0;
    size_t kept = (got < cap) ? got : cap;
    buf[kept] = '\0';
    return (int)kept;
}

/* ---------------- 控制页 ---------------- */

static esp_err_t page_handler(httpd_req_t *req)
{
    power_activity();

    if (captive_probe_redirect(req)) return ESP_OK;

    if (ota_web_has_page()) return ota_web_stream_page(req);

#if MOINK_EMBED_PAGE
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_send(req, (const char *)index_html, index_html_len);
#else
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_send(req, FALLBACK_HTML, sizeof(FALLBACK_HTML) - 1);
#endif
}

/* ---------------- /api/info ---------------- */

static esp_err_t info_handler(httpd_req_t *req)
{
    power_activity();
    const moink_settings_t *s = settings_get();
    char buf[512];

    int n = snprintf(buf, sizeof(buf),
        "{\"fw\":\"%s\",\"page\":\"%s\",\"api\":%d,"
        "\"panel\":\"%s\",\"heap\":%lu,\"bat_mv\":%d,"
        "\"sleep_s\":%lu,\"wake_s\":%lu,\"clients\":%d,"
        "\"ssid\":\"%s\",\"uptime\":%lld}",
        MOINK_FW_VERSION, ota_web_page_version(), MOINK_API_VERSION,
        epd_panel_name((epd_panel_t)s->panel),
        (unsigned long)esp_get_free_heap_size(), power_battery_mv(),
        (unsigned long)s->sleep_s, (unsigned long)s->wake_s,
        netif_ap_client_count(), netif_ap_ssid(),
        (long long)(esp_timer_get_time() / 1000000));
    if (n < 0 || n >= (int)sizeof(buf)) buf[sizeof(buf) - 1] = '\0';

    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, buf, strlen(buf));
}

/* ---------------- /api/settings ---------------- */

static esp_err_t settings_get_handler(httpd_req_t *req)
{
    power_activity();
    const moink_settings_t *s = settings_get();
    char buf[256];

    snprintf(buf, sizeof(buf),
        "{\"panel\":%u,\"hflip\":%u,\"a11_var\":%u,\"sleep_s\":%lu,\"wake_s\":%lu,"
        "\"ssid\":\"%s\",\"pass_set\":%s}",
        s->panel, s->hflip, s->a11_var,
        (unsigned long)s->sleep_s, (unsigned long)s->wake_s,
        s->ap_ssid, s->ap_pass[0] ? "true" : "false");

    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, buf, strlen(buf));
}

static esp_err_t settings_post_handler(httpd_req_t *req)
{
    power_activity();
    char body[512];
    read_body(req, body, sizeof(body));

    char v[SETT_PASS_MAX];
    bool ap_changed = false;
    bool panel_changed = false, hflip_changed = false;

    if (kv_get(body, "panel", v, sizeof(v))) {
        settings_set_panel((uint8_t)atoi(v));
        panel_changed = true;
    }
    if (kv_get(body, "hflip", v, sizeof(v))) {
        settings_set_hflip((uint8_t)atoi(v));
        hflip_changed = true;
    }
    if (kv_get(body, "a11_var", v, sizeof(v))) {
        settings_set_a11_var((uint8_t)atoi(v));
        epd_set_a11_variant(settings_get()->a11_var);
    }
    if (kv_get(body, "sleep_s", v, sizeof(v))) {
        settings_set_sleep((uint32_t)atoi(v));
    }
    if (kv_get(body, "wake_s", v, sizeof(v))) {
        settings_set_wake((uint32_t)atoi(v));
    }

    /* 热点凭据：ssid / pass 两个字段一起出现才改，避免半改。 */
    char ssid[SETT_SSID_MAX], pass[SETT_PASS_MAX];
    bool have_ssid = kv_get(body, "ssid", ssid, sizeof(ssid));
    bool have_pass = kv_get(body, "pass", pass, sizeof(pass));
    if (have_ssid && have_pass) {
        settings_set_ap(ssid, pass);
        ap_changed = true;
    }

    /* 应用到运行时。 */
    if (panel_changed) epd_set_panel((epd_panel_t)settings_get()->panel);
    if (hflip_changed) epd_set_hflip(settings_get()->hflip != 0);
    if (ap_changed) netif_ap_apply();

    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_sendstr(req, "OK");
}

/* ---------------- /api/clear / /api/factory ---------------- */

static esp_err_t clear_handler(httpd_req_t *req)
{
    power_activity();
    int cycles = 2;
    char v[16];
    if (kv_get(req->uri, "cycles", v, sizeof(v))) cycles = atoi(v);
    if (cycles < 1) cycles = 1;
    if (cycles > 4) cycles = 4;

    ESP_LOGI(TAG, "ghost clear x%d", cycles);
    int r = frame_clear_cycles(cycles);   /* R1.0.8：持帧锁，防与传图并发互踩 */
    if (r != 0) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "clear failed");
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_sendstr(req, "OK");
}

static esp_err_t factory_handler(httpd_req_t *req)
{
    settings_factory_reset();
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_sendstr(req, "OK");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK;
}

/* ---------------- CORS 预检（离线客户端走 file://） ---------------- */

static esp_err_t options_handler(httpd_req_t *req)
{
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type");
    httpd_resp_send(req, NULL, 0);
    return ESP_OK;
}

/* ---------------- HTTP 服务器 ---------------- */

static httpd_handle_t start_server(void)
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    /* 默认是精确匹配，OPTIONS * 通配路由永远不触发 → 跨源预检 404 →
       离线/本地页面的上传被浏览器拦截。启用通配匹配后预检正常。 */
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    cfg.stack_size = HTTPD_STACK;
    cfg.max_uri_handlers = HTTPD_MAX_URI;
    cfg.max_open_sockets = 4;
    cfg.lru_purge_enable = true;
    cfg.recv_wait_timeout = 10;
    cfg.send_wait_timeout = 10;

    httpd_handle_t server = NULL;
    if (httpd_start(&server, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        return NULL;
    }

    httpd_uri_t routes[] = {
        { .uri = "/",               .method = HTTP_GET,    .handler = page_handler,         .user_ctx = NULL },
        { .uri = "/api/info",       .method = HTTP_GET,    .handler = info_handler,         .user_ctx = NULL },
        { .uri = "/api/settings",   .method = HTTP_GET,    .handler = settings_get_handler, .user_ctx = NULL },
        { .uri = "/api/settings",   .method = HTTP_POST,   .handler = settings_post_handler,.user_ctx = NULL },
        { .uri = "/api/frame",      .method = HTTP_POST,   .handler = frame_upload_handler, .user_ctx = NULL },
        { .uri = "/api/clear",      .method = HTTP_POST,   .handler = clear_handler,        .user_ctx = NULL },
        { .uri = "/api/factory",    .method = HTTP_POST,   .handler = factory_handler,      .user_ctx = NULL },
        { .uri = "*",               .method = HTTP_OPTIONS,.handler = options_handler,      .user_ctx = NULL },
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        if (httpd_register_uri_handler(server, &routes[i]) != ESP_OK) {
            ESP_LOGE(TAG, "register %s %d failed", routes[i].uri, routes[i].method);
        }
    }

    ota_web_register(server);
    return server;
}

/* ---------------- 任务 ---------------- */

static void frame_task(void *arg)
{
    (void)arg;
    for (;;) {
        frame_wait();
        if (frame_display_now() == 0) {
            power_activity();
        }
    }
}

static void idle_monitor_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (power_should_sleep()) {
            power_enter_deep_sleep();   /* 不返回 */
        }
    }
}

static void button_task(void *arg)
{
    (void)arg;
    int held = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(50));
        bool down = (gpio_get_level((gpio_num_t)EPD_PIN_WAKE_BTN) == 0);
        if (down) {
            held++;
            if (held == HOLD_RESET_S * 20) {
                ESP_LOGW(TAG, "wake button held, keep holding %ds to factory reset", HOLD_RESET_S);
            }
            if (held >= HOLD_RESET_S * 20 + 5) {
                ESP_LOGW(TAG, "long press: factory reset + reboot");
                settings_factory_reset();
                vTaskDelay(pdMS_TO_TICKS(300));
                esp_restart();
            }
        } else {
            held = 0;
        }
    }
}

/* ---------------- 主入口 ---------------- */

void app_main(void)
{
    ESP_LOGI(TAG, "=== MoInk %s | 4-color | ap + OTA ===", MOINK_FW_VERSION);

    /* 唤醒原因：GPIO = 按键，TIMER = 定时自动唤醒。 */
    uint32_t wake = power_wakeup_causes();
    bool auto_wake = (wake & (1u << ESP_SLEEP_WAKEUP_TIMER)) != 0;
    power_set_auto_wake(auto_wake);
    if (wake & (1u << ESP_SLEEP_WAKEUP_GPIO)) {
        ESP_LOGI(TAG, "woken by GPIO%d button", EPD_PIN_WAKE_BTN);
    } else if (auto_wake) {
        ESP_LOGI(TAG, "woken by RTC timer (auto wake)");
    } else if (wake) {
        ESP_LOGI(TAG, "wakeup bitmap 0x%lx", (unsigned long)wake);
    }

    /* NVS */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    settings_init();
    power_init();

    if (epd_init() != 0) {
        ESP_LOGE(TAG, "EPD init failed");
    }
    epd_set_panel((epd_panel_t)settings_get()->panel);
    epd_set_a11_variant(settings_get()->a11_var);
    epd_set_hflip(settings_get()->hflip != 0);

    frame_init();
    netif_ap_init();
    captive_dns_start();

    if (start_server() == NULL) {
        ESP_LOGE(TAG, "HTTP server failed to start");
    }

    xTaskCreate(frame_task, "frame", 4096, NULL, 5, NULL);
    xTaskCreate(idle_monitor_task, "idle_mon", 3072, NULL, 4, NULL);
    xTaskCreate(button_task, "button", 3072, NULL, 4, NULL);

    ota_web_confirm();

    ESP_LOGI(TAG, "ready: %s @ http://192.168.4.1 (heap %lu)",
             netif_ap_ssid(), (unsigned long)esp_get_free_heap_size());
}
