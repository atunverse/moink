#include "captive.h"
#include "netif_ap.h"      /* netif_napt_active() / netif_upstream_dns() */

#include "esp_log.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <string.h>
#include <errno.h>
#include <stdbool.h>
#include <sys/time.h>

static const char *TAG = "captive";

#define DNS_PORT 53
#define DNS_BUF  1024              /* EDNS0 应答可达 1232，512 会截断 */
#define APPLE_SUCCESS_WINDOW_MS 60000

/* 门户窗口：客户端连上热点后，只有这段时间内才劫持系统探测域名。 */
#define PORTAL_WINDOW_MS        60000
/* 上游转发超时：正常 20~50 ms。超时就不回包，让客户端自己重试。 */
#define DNS_UPSTREAM_TIMEOUT_MS 600

static volatile bool s_apple_success_pending;
static TickType_t s_apple_success_deadline;

/* 门户窗口截止时刻（tick）；0 = 未开。多客户端取最晚的那个。 */
static TickType_t s_portal_deadline;

static void captive_arm_apple_success(void)
{
    s_apple_success_deadline = xTaskGetTickCount() + pdMS_TO_TICKS(APPLE_SUCCESS_WINDOW_MS);
    s_apple_success_pending = true;
}

static bool captive_apple_success_active(void)
{
    if (!s_apple_success_pending) return false;
    TickType_t now = xTaskGetTickCount();
    if ((int32_t)(s_apple_success_deadline - now) < 0) {
        s_apple_success_pending = false;
        return false;
    }
    return true;
}

void captive_apple_station_disconnected(void)
{
    /* Success 只服务于当前这次连接。用户主动断开后立即恢复门户，下一次连接
       无需等待超时或重启 ESP32；60 秒窗口只作为漏掉断开事件时的兜底。 */
    s_apple_success_pending = false;
}

/* ---------------- 门户窗口：有网也弹一次（R1.3.5） ----------------
 *
 * 为什么要自己转发 DNS：NAPT 生效后若把热点 DHCP 的 DNS 换成上游，
 * 客户端在租约内就一直用上游，设备再也插不上手 —— 时间窗关不住。
 * 所以 DHCP 一律下发 192.168.4.1，由本任务逐包决定「劫持还是转发」：
 *
 *   没在转发（未联网 / 用户关了 NAPT） -> 全劫持（本来就没外网，保住门户）
 *   窗口内                             -> 只劫持系统探测域名，其余照常转发
 *   窗口外                             -> 全部放行，手机判定「有网」自动关门户
 */
void captive_portal_arm(void)
{
    TickType_t end = xTaskGetTickCount() + pdMS_TO_TICKS(PORTAL_WINDOW_MS);
    if (s_portal_deadline == 0 || (int32_t)(end - s_portal_deadline) > 0)
        s_portal_deadline = end;
}

bool captive_portal_active(void)
{
    if (s_portal_deadline == 0) return false;
    if ((int32_t)(s_portal_deadline - xTaskGetTickCount()) <= 0) {
        s_portal_deadline = 0;
        return false;
    }
    return true;
}

/* 把 DNS 查询名（length-prefixed labels）转成小写点分字符串。 */
static bool qname_to_str(const uint8_t *p, int n, int off, char *out, size_t cap)
{
    size_t o = 0;
    out[0] = '\0';
    while (off < n) {
        uint8_t len = p[off];
        if (len == 0) return o > 0;
        if ((len & 0xC0) == 0xC0) return false;      /* 查询名不带压缩指针 */
        if (len > 63 || off + 1 + len > n) return false;
        if (o + len + 2 > cap) return false;
        if (o) out[o++] = '.';
        for (uint8_t i = 0; i < len; i++) {
            char ch = (char)p[off + 1 + i];
            if (ch >= 'A' && ch <= 'Z') ch = (char)(ch - 'A' + 'a');
            out[o++] = ch;
        }
        out[o] = '\0';
        off += 1 + len;
    }
    return false;
}

/* 各系统的「联网探测」主机名。命中才劫持，其余域名照常解析。 */
static const char *const kProbeHosts[] = {
    "captive.apple.com",
    "connectivitycheck.gstatic.com",
    "connectivitycheck.android.com",
    "connectivitycheck.platform.hicloud.com",
    "connectivitycheck.cbg-app.huawei.com",
    "www.msftconnecttest.com",
    "www.msftncsi.com",
    "detectportal.firefox.com",
    "nmcheck.gnome.org",
    "network-test.debian.org",
};

static bool is_probe_name(const char *name)
{
    size_t ln = strlen(name);
    for (size_t i = 0; i < sizeof(kProbeHosts) / sizeof(kProbeHosts[0]); i++) {
        const char *p = kProbeHosts[i];
        size_t lp = strlen(p);
        if (ln == lp && strcmp(name, p) == 0) return true;
        if (ln > lp && name[ln - lp - 1] == '.' && strcmp(name + (ln - lp), p) == 0)
            return true;
    }
    return false;
}

/* 本包是否需要劫持。规则见上面的注释。 */
static bool dns_should_hijack(const uint8_t *q, int n, const uint16_t *name_off,
                              const uint16_t *qtype, const uint16_t *qclass,
                              uint16_t qdcount)
{
    if (!netif_napt_active()) return true;
    if (!captive_portal_active()) return false;

    char name[128];
    for (uint16_t i = 0; i < qdcount; i++) {
        if (qtype[i] != 1 || qclass[i] != 1) continue;
        if (qname_to_str(q, n, name_off[i], name, sizeof(name)) && is_probe_name(name))
            return true;
    }
    return false;
}

/* 原样转发给上游 DNS 并回给客户端。
 * ★ 串行阻塞最多 DNS_UPSTREAM_TIMEOUT_MS：DNS 本来就是串行应答，
 *   上游正常时 20~50 ms，代价可接受；超时就不回包（客户端会重试）。 */
static int s_up_sock = -1;
static uint8_t s_fwd_buf[DNS_BUF];

static void forward_upstream(int cli_sock, const uint8_t *q, int n,
                             const struct sockaddr_in *from, socklen_t fl)
{
    uint32_t dns_ip = 0;
    if (!netif_upstream_dns(&dns_ip)) return;

    if (s_up_sock < 0) {
        s_up_sock = socket(AF_INET, SOCK_DGRAM, 0);
        if (s_up_sock < 0) return;
        struct timeval tv = { 0, DNS_UPSTREAM_TIMEOUT_MS * 1000 };
        setsockopt(s_up_sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    }

    struct sockaddr_in to = {
        .sin_family = AF_INET,
        .sin_port = htons(DNS_PORT),
        .sin_addr.s_addr = dns_ip,
    };
    if (sendto(s_up_sock, q, n, 0, (const struct sockaddr *)&to, sizeof(to)) < 0) {
        close(s_up_sock);
        s_up_sock = -1;
        return;
    }

    struct sockaddr_in src;
    socklen_t sl = sizeof(src);
    int m = recvfrom(s_up_sock, s_fwd_buf, sizeof(s_fwd_buf), 0,
                     (struct sockaddr *)&src, &sl);
    if (m > 0)
        sendto(cli_sock, s_fwd_buf, m, 0, (const struct sockaddr *)from, fl);
}

static esp_err_t captive_apple_success(httpd_req_t *req)
{
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Pragma", "no-cache");
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_sendstr(req,
        "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
}

static esp_err_t captive_apple_done_page(httpd_req_t *req)
{
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Pragma", "no-cache");
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_sendstr(req,
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
        "<title>地址已复制</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;"
        "display:flex;align-items:center;justify-content:center;padding:24px;background:#f5f5f7;"
        "color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",sans-serif}"
        ".card{width:100%;max-width:430px;padding:30px 24px;border-radius:20px;background:#fff;"
        "box-shadow:0 10px 36px #00000014;text-align:center}.ok{width:60px;height:60px;margin:0 auto 18px;"
        "display:grid;place-items:center;border-radius:50%;background:#e8f7ed;color:#16833d;"
        "font-size:32px;font-weight:700}h1{font-size:23px;margin:0 0 12px}p{font-size:16px;"
        "line-height:1.65;color:#555;margin:8px 0}.next{margin-top:18px;padding:14px;border-radius:12px;"
        "background:#fff7df;color:#684f18;font-size:15px}</style></head><body><main class=\"card\">"
        "<div class=\"ok\">&#10003;</div><h1>地址已复制</h1>"
        "<p>请点击右上角的“完成”关闭此页面。</p>"
        "<p class=\"next\">然后打开系统自带的 Safari，在地址栏粘贴并访问 <b>192.168.4.1</b></p>"
        "</main></body></html>");
}

static void dns_task(void *arg)
{
    (void)arg;
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        ESP_LOGE(TAG, "socket() failed");
        return;
    }

    struct sockaddr_in bind_addr = {
        .sin_family = AF_INET,
        .sin_port = htons(DNS_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(sock, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0) {
        ESP_LOGE(TAG, "bind :%d failed: %d", DNS_PORT, errno);
        close(sock);
        return;
    }
    ESP_LOGI(TAG, "DNS hijack on :%d -> 192.168.4.1", DNS_PORT);

    /* 1024×2 放静态区而不是 3 KB 的任务栈上（转发还要再用一份）。 */
    static uint8_t q[DNS_BUF], r[DNS_BUF];

    for (;;) {
        struct sockaddr_in from;
        socklen_t fl = sizeof(from);
        int n = recvfrom(sock, q, sizeof(q), 0, (struct sockaddr *)&from, &fl);
        if (n < 12) continue; /* 至少一个完整 DNS 头 */

        /* Apple 的解析器可能在一个 DNS 包里携带多个问题；旧实现仅接受 QDCOUNT=1，
           整包丢弃后 iPhone 就不会继续请求 /hotspot-detect.html。 */
        if ((q[2] & 0xF8) != 0) continue; /* QR=0 且 OPCODE=QUERY */
        uint16_t qdcount = ((uint16_t)q[4] << 8) | q[5];
        if (qdcount == 0 || qdcount > 8) continue;

        uint16_t name_off[8], qtype[8], qclass[8];
        int qend = 12;
        bool packet_valid = true;
        for (uint16_t qi = 0; qi < qdcount; qi++) {
            name_off[qi] = (uint16_t)qend;
            bool name_valid = false;
            while (qend < n) {
                uint8_t len = q[qend];
                if (len == 0) { qend++; name_valid = true; break; }
                if ((len & 0xC0) == 0xC0) {
                    if (qend + 1 >= n) break;
                    qend += 2;
                    name_valid = true;
                    break;
                }
                if (len > 63 || qend + 1 + len > n) break;
                qend += 1 + len;
            }
            if (!name_valid || qend + 4 > n) { packet_valid = false; break; }
            qtype[qi] = ((uint16_t)q[qend] << 8) | q[qend + 1];
            qclass[qi] = ((uint16_t)q[qend + 2] << 8) | q[qend + 3];
            qend += 4;
        }
        if (!packet_valid) continue;

        /* 窗口/域名决定这一包的去向：不劫持就原样转发给上游。 */
        if (!dns_should_hijack(q, n, name_off, qtype, qclass, qdcount)) {
            forward_upstream(sock, q, n, &from, fl);
            continue;
        }

        memset(r, 0, sizeof(r));
        r[0] = q[0]; r[1] = q[1];             /* 事务 ID 原样回 */
        r[2] = 0x84 | (q[2] & 0x01);          /* QR=1、AA=1，保留 RD */
        r[3] = 0x00;                          /* NOERROR */
        r[4] = (uint8_t)(qdcount >> 8);
        r[5] = (uint8_t)qdcount;
        memcpy(r + 12, q + 12, (size_t)(qend - 12));

        /* 每个 A/IN 问题返回 192.168.4.1；AAAA、HTTPS 等保留为 NOERROR 空答案，
           避免类型不匹配，同时不能用 NXDOMAIN（会连带否定同名 A 记录）。 */
        int a = qend;
        uint16_t ancount = 0;
        for (uint16_t qi = 0; qi < qdcount; qi++) {
            if (qtype[qi] != 1 || qclass[qi] != 1) continue;
            if (a + 16 > DNS_BUF) { packet_valid = false; break; }
            uint16_t ptr = (uint16_t)(0xC000u | name_off[qi]);
            r[a++] = (uint8_t)(ptr >> 8); r[a++] = (uint8_t)ptr;
            r[a++] = 0x00; r[a++] = 0x01;     /* TYPE  = A   */
            r[a++] = 0x00; r[a++] = 0x01;     /* CLASS = IN  */
            r[a++] = 0x00; r[a++] = 0x00; r[a++] = 0x00; r[a++] = 0x05; /* TTL 5 */
            r[a++] = 0x00; r[a++] = 0x04;     /* RDLEN = 4  */
            r[a++] = 192; r[a++] = 168; r[a++] = 4; r[a++] = 1;
            ancount++;
        }
        if (!packet_valid) continue;
        r[6] = (uint8_t)(ancount >> 8);
        r[7] = (uint8_t)ancount;

        sendto(sock, r, a, 0, (struct sockaddr *)&from, fl);
    }
}

void captive_dns_start(void)
{
    xTaskCreate(dns_task, "captive_dns", 3072, NULL, 5, NULL);
}

esp_err_t captive_redirect(httpd_req_t *req)
{
    /* 窗口过期后放行：给 OS 的探测请求它期待的结果，否则状态栏的
       「需登录」图标一直挂着、门户页也不会自动关。 */
    if (!captive_portal_active()) {
        if (strstr(req->uri, "generate_204") || strstr(req->uri, "gen_204")) {
            httpd_resp_set_status(req, "204 No Content");
            return httpd_resp_send(req, NULL, 0);
        }
        if (strstr(req->uri, "connecttest.txt")) {
            httpd_resp_set_type(req, "text/plain");
            return httpd_resp_sendstr(req, "Microsoft Connect Test");
        }
        if (strstr(req->uri, "ncsi.txt")) {
            httpd_resp_set_type(req, "text/plain");
            return httpd_resp_sendstr(req, "Microsoft NCSI");
        }
    }

    /* 303 + 非空正文可让 iOS Captive Network Assistant 识别。Location 必须
       使用绝对 URL；Vivo 的 captive WebView 会把相对地址解析成 file:///。 */
    httpd_resp_set_status(req, "303 See Other");
    httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/?moink_captive=1");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Pragma", "no-cache");
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_sendstr(req,
        "<!doctype html><a href=\"http://192.168.4.1/?moink_captive=1\">Open MoInk</a>");
}

esp_err_t captive_apple_landing(httpd_req_t *req)
{
    /* 用户复制地址后显示友好完成页；同时开启成功窗口，让 Apple 后台复探获得
       严格的标准 Success。热点保持连接，供 Safari 访问。 */
    char query[64], done[8];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK &&
        httpd_query_key_value(query, "moink_done", done, sizeof(done)) == ESP_OK &&
        strcmp(done, "1") == 0) {
        captive_arm_apple_success();
        return captive_apple_done_page(req);
    }

    if (captive_apple_success_active()) return captive_apple_success(req);

    /* 窗口过期：直接把标准 Success 给回去，手机据此判定有网并关闭门户页。 */
    if (!captive_portal_active()) return captive_apple_success(req);

    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Pragma", "no-cache");
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_sendstr(req,
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
        "<title>使用 Safari 打开 MoInk</title><style>"
        "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;"
        "justify-content:center;padding:24px;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,"
        "BlinkMacSystemFont,\"PingFang SC\",sans-serif}.card{width:100%;max-width:430px;background:#fff;"
        "border-radius:20px;padding:28px 22px;box-shadow:0 10px 36px #00000014;text-align:center}"
        ".logo{font-size:40px;margin-bottom:10px}h1{font-size:23px;margin:0 0 12px}p{font-size:15px;"
        "line-height:1.65;color:#555;margin:8px 0}.addr{display:block;margin:18px 0 12px;padding:13px;"
        "border-radius:12px;background:#f2f3f5;color:#1d1d1f;font:600 18px ui-monospace,monospace}"
        "button{width:100%;border:0;border-radius:12px;padding:14px;background:#1677ff;color:#fff;"
        "font-size:17px;font-weight:700}.steps{margin-top:18px;padding:14px;text-align:left;border-radius:12px;"
        "background:#fff7df;color:#684f18;font-size:14px;line-height:1.65}.ok{color:#16833d;font-weight:700}"
        "</style></head><body><main class=\"card\"><div class=\"logo\">&#128241;</div>"
        "<h1>请使用 Safari 打开配置页</h1><p>墨印 · MoInk</p>"
        "<span class=\"addr\" id=\"addr\">192.168.4.1</span>"
        "<button id=\"copy\" type=\"button\">复制地址并关闭此页</button>"
        "<p id=\"state\"></p><div class=\"steps\"><b>接下来：</b><br>"
        "1. 点击上方按钮复制地址<br>2. 打开系统自带的 Safari<br>3. 在地址栏粘贴并访问</div>"
        "</main><script>function finish(){document.getElementById('state').className='ok';"
        "document.getElementById('state').textContent='已复制，请打开 Safari 并粘贴访问';"
        "setTimeout(function(){location.replace('/hotspot-detect.html?moink_done=1');},700)}"
        "function fallback(){var t=document.createElement('textarea');t.value='192.168.4.1';"
        "t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.focus();t.select();"
        "t.setSelectionRange(0,t.value.length);var ok=false;try{ok=document.execCommand('copy')}catch(e){}"
        "document.body.removeChild(t);if(ok)finish();else{var a=document.getElementById('addr');"
        "document.getElementById('state').textContent='复制失败，请长按上方地址复制';window.getSelection().selectAllChildren(a)}}"
        "document.getElementById('copy').onclick=function(){if(navigator.clipboard&&window.isSecureContext)"
        "navigator.clipboard.writeText('192.168.4.1').then(finish,fallback);else fallback()};</script>"
        "</body></html>");
}
