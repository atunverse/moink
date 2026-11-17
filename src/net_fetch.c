#include "net_fetch.h"

#include "epd_drv.h"
#include "frame.h"
#include "netif_ap.h"
#include "power.h"
#include "settings.h"

#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

static const char *TAG = "netfetch";

#define MF_MAX       4096          /* 清单上限：超过就判错，不动态扩容 */
#define MF_NAME_MAX  72
#define GET_TIMEOUT  30000
#define PUT_TIMEOUT  60000
#define ONLINE_WAIT  15000

static char s_mf[MF_MAX];          /* 清单原文（读-改-写全靠这一块） */
static int  s_count;               /* 最近一次清单条目数 */
static int  s_err = NF_ERR_NONE;
static bool s_busy;

/* ---------------- 校验和 ---------------- */

/* CRC-16/CCITT-FALSE，与帧头一致。 */
static uint16_t crc16_of(const uint8_t *d, size_t n)
{
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < n; i++) {
        crc ^= (uint16_t)d[i] << 8;
        for (int b = 0; b < 8; b++)
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021)
                                 : (uint16_t)(crc << 1);
    }
    return crc;
}

/* CRC-32（zlib 口径，poly 0xEDB88320），清单第二列就是它。 */
static uint32_t crc32_of(const uint8_t *d, size_t n)
{
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) {
        crc ^= d[i];
        for (int b = 0; b < 8; b++)
            crc = (crc & 1u) ? ((crc >> 1) ^ 0xEDB88320u) : (crc >> 1);
    }
    return crc ^ 0xFFFFFFFFu;
}

/* ---------------- URL 拼接 ---------------- */

/* 取 root 的目录部分（去掉最后一个 '/' 之后的文件名）。 */
static void url_dir(char *out, size_t n, const char *root)
{
    strlcpy(out, root, n);
    char *slash = strrchr(out, '/');
    /* "http://host" 的 '//' 不能砍成 "http:"，留至少 8 个字符（http://x）。 */
    if (slash && slash > out + 8) *slash = '\0';
}

/* 拼 dir + "/" + name，去掉重复斜杠。 */
static void url_join(char *out, size_t n, const char *dir, const char *name)
{
    size_t len = strlen(dir);
    while (len && dir[len - 1] == '/') len--;
    snprintf(out, n, "%.*s/%s", (int)len, dir, name);
}

/* ---------------- 极简 HTTP/1.1 客户端 ----------------
 *
 * 为什么不用 esp_http_client：它无条件引用 esp-tls，即使 HTTPS 全关，
 * mbedTLS（约 90 KB flash）仍然会被整条链进来。远程图槽只需要明文
 * http://，所以这里用 lwIP socket 自己发请求，把 TLS 彻底甩掉。
 *
 * 支持范围（只做用得到的）：
 *   - 仅 http://；GET / PUT；Basic 认证
 *   - Content-Length 与 chunked 两种响应体；最多 3 次重定向
 *   - 一律 Connection: close，不维持长连接
 */

#define HTTP_HDR_MAX   1024        /* 响应头上限，超出判错 */
#define HTTP_B64_MAX   192         /* Basic 凭据 base64 后的上限 */
#define HTTP_REDIR_MAX 3

typedef struct {
    char     host[96];
    char     path[256];
    uint16_t port;
} url_t;

/* 解析 http://host[:port]/path；userinfo 允许存在但忽略（认证走设置项）。 */
static bool url_parse(const char *url, url_t *u)
{
    memset(u, 0, sizeof(*u));
    u->port = 80;
    if (strncasecmp(url, "http://", 7) != 0) return false;

    const char *p = url + 7;
    const char *slash = strchr(p, '/');
    size_t alen = slash ? (size_t)(slash - p) : strlen(p);
    if (alen == 0 || alen >= 160) return false;

    char auth[160];
    memcpy(auth, p, alen);
    auth[alen] = '\0';

    char *hostpart = auth;
    char *at = strrchr(auth, '@');          /* 丢掉 user:pass@ 前缀 */
    if (at) hostpart = at + 1;

    char *colon = strrchr(hostpart, ':');
    if (colon) {
        *colon = '\0';
        int v = atoi(colon + 1);
        if (v > 0 && v < 65536) u->port = (uint16_t)v;
    }
    if (!hostpart[0] || strlen(hostpart) >= sizeof(u->host)) return false;

    strlcpy(u->host, hostpart, sizeof(u->host));
    strlcpy(u->path, slash ? slash : "/", sizeof(u->path));
    return true;
}

/* 标准 base64（Basic 认证用）。 */
static void b64_encode(char *out, size_t on, const char *in)
{
    static const char T[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t len = strlen(in), i = 0, o = 0;

    while (i + 2 < len && o + 4 < on) {
        uint32_t v = ((uint32_t)(uint8_t)in[i] << 16) |
                     ((uint32_t)(uint8_t)in[i + 1] << 8) |
                      (uint32_t)(uint8_t)in[i + 2];
        out[o++] = T[(v >> 18) & 63];
        out[o++] = T[(v >> 12) & 63];
        out[o++] = T[(v >> 6) & 63];
        out[o++] = T[v & 63];
        i += 3;
    }
    if (o + 4 < on && i < len) {
        bool two = (i + 1 < len);
        uint32_t v = (uint32_t)(uint8_t)in[i] << 16;
        if (two) v |= (uint32_t)(uint8_t)in[i + 1] << 8;
        out[o++] = T[(v >> 18) & 63];
        out[o++] = T[(v >> 12) & 63];
        out[o++] = two ? T[(v >> 6) & 63] : '=';
        out[o++] = '=';
    }
    out[o] = '\0';
}

/* 拼 "host[:port]"（Host 头与重定向复用）。 */
static void host_port(char *out, size_t n, const url_t *u)
{
    if (u->port == 80) snprintf(out, n, "%s", u->host);
    else               snprintf(out, n, "%s:%u", u->host, (unsigned)u->port);
}

/* DNS + connect + 收发超时。成功返回 fd，失败 -1。 */
static int http_connect(const url_t *u, int timeout_ms)
{
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    char port[8];
    snprintf(port, sizeof(port), "%u", (unsigned)u->port);
    if (getaddrinfo(u->host, port, &hints, &res) != 0 || !res) {
        ESP_LOGW(TAG, "dns fail: %s", u->host);
        return -1;
    }

    int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd < 0) { freeaddrinfo(res); return -1; }

    struct timeval tv;
    tv.tv_sec  = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    if (connect(fd, res->ai_addr, res->ai_addrlen) != 0) {
        ESP_LOGW(TAG, "connect %s:%u fail (errno %d)",
                 u->host, (unsigned)u->port, errno);
        closesocket(fd);
        freeaddrinfo(res);
        return -1;
    }
    freeaddrinfo(res);
    return fd;
}

/* 循环发送，直到 n 字节写完。 */
static int send_all(int fd, const void *buf, int n)
{
    const char *p = (const char *)buf;
    int done = 0;
    while (done < n) {
        int k = send(fd, p + done, n - done, 0);
        if (k <= 0) return -1;
        done += k;
    }
    return done;
}

typedef struct {
    int      fd;
    int      status;
    long     clen;                    /* -1 = 没有 Content-Length */
    bool     chunked;
    char     loc[SETT_URL_MAX];
    char     hdr[HTTP_HDR_MAX];
    uint8_t *pre;                     /* 头部之后、已经读进来的 body 起址 */
    int      prelen;
} resp_t;

/* 读响应头并解析；body 里多读到的部分留在 pre/prelen 里。 */
static int resp_begin(resp_t *r, int fd)
{
    memset(r, 0, sizeof(*r));
    r->fd   = fd;
    r->clen = -1;

    int total = 0;
    for (;;) {
        if (total >= HTTP_HDR_MAX - 1) return -1;
        int n = recv(fd, r->hdr + total, HTTP_HDR_MAX - 1 - total, 0);
        if (n <= 0) return -1;
        total += n;
        r->hdr[total] = '\0';
        char *end = strstr(r->hdr, "\r\n\r\n");
        if (end) {
            int hlen  = (int)(end + 4 - r->hdr);
            r->pre    = (uint8_t *)(r->hdr + hlen);
            r->prelen = total - hlen;
            break;
        }
    }

    if (strncmp(r->hdr, "HTTP/", 5) != 0) return -1;
    char *sp = strchr(r->hdr, ' ');
    if (!sp) return -1;
    r->status = atoi(sp + 1);

    /* 逐行扫描头字段。只读不写 '\0' —— body 可能就存在同一块缓冲后面。 */
    char *line = strstr(r->hdr, "\r\n");
    while (line) {
        line += 2;
        char *e = strstr(line, "\r\n");
        if (!e || e == line) break;
        size_t klen = (size_t)(e - line);

        if (klen > 15 && strncasecmp(line, "Content-Length:", 15) == 0) {
            r->clen = atol(line + 15);
        } else if (klen > 18 && strncasecmp(line, "Transfer-Encoding:", 18) == 0) {
            for (const char *q = line; q + 7 <= e; q++)
                if (strncasecmp(q, "chunked", 7) == 0) { r->chunked = true; break; }
        } else if (klen > 9 && strncasecmp(line, "Location:", 9) == 0) {
            const char *v = line + 9;
            while (v < e && (*v == ' ' || *v == '\t')) v++;
            size_t n = (size_t)(e - v);
            if (n < sizeof(r->loc)) {
                memcpy(r->loc, v, n);
                r->loc[n] = '\0';
            }
        }
        line = e;
    }
    return 0;
}

/* 读 n 字节 body：优先消费预读部分，再落到 socket。 */
static int rsp_read(resp_t *r, void *buf, int n)
{
    if (r->prelen > 0) {
        int k = (n < r->prelen) ? n : r->prelen;
        memcpy(buf, r->pre, (size_t)k);
        r->pre    += k;
        r->prelen -= k;
        return k;
    }
    return recv(r->fd, buf, n, 0);
}

/* 把 body 收下来：out 非空写 RAM（cap 为可用空间）；out 为 NULL 时逐块喂 sink
   （远程帧直接落到 flash，不在 RAM 里攒 105 KB）。返回字节数，失败 -1。 */
static int resp_body(resp_t *r, uint8_t *out, int cap,
                     int (*sink)(const void *, int))
{
    uint8_t tmp[512];
    int total = 0;

    if (r->chunked) {
        for (;;) {
            char lb[16];
            int i = 0;
            while (i < (int)sizeof(lb) - 1) {
                char ch;
                if (rsp_read(r, &ch, 1) != 1) return -1;
                if (ch == '\n') break;
                if (ch != '\r') lb[i++] = ch;
            }
            lb[i] = '\0';
            long sz = strtol(lb, NULL, 16);
            if (sz <= 0) return total;          /* 0 = 结束块 */
            while (sz > 0) {
                int want = (int)((sz < (long)sizeof(tmp)) ? sz : (long)sizeof(tmp));
                int k = rsp_read(r, tmp, want);
                if (k <= 0) return -1;
                if (out) {
                    if (total + k > cap) return -1;
                    memcpy(out + total, tmp, (size_t)k);
                } else if (sink && sink(tmp, k) != 0) {
                    return -1;
                }
                total += k;
                sz    -= k;
                power_activity();
            }
            char crlf[2];
            if (rsp_read(r, crlf, 2) != 2) return -1;   /* 块尾 CRLF */
        }
    }

    if (r->clen >= 0) {
        if (out && r->clen > cap) return -1;
        long remain = r->clen;
        while (remain > 0) {
            int want = (int)((remain < (long)sizeof(tmp)) ? remain : (long)sizeof(tmp));
            int k = rsp_read(r, tmp, want);
            if (k <= 0) return -1;              /* 短读 = 不完整，判失败 */
            if (out) {
                if (total + k > cap) return -1;
                memcpy(out + total, tmp, (size_t)k);
            } else if (sink && sink(tmp, k) != 0) {
                return -1;
            }
            total  += k;
            remain -= k;
            power_activity();
        }
        return total;
    }

    /* 既无长度也没分块：读到对端关连接为止。 */
    for (;;) {
        int want = (int)sizeof(tmp);
        if (out) {
            if (total >= cap) break;
            if (want > cap - total) want = cap - total;
        }
        int k = rsp_read(r, tmp, want);
        if (k <= 0) break;
        if (out) memcpy(out + total, tmp, (size_t)k);
        else if (sink && sink(tmp, k) != 0) return -1;
        total += k;
        power_activity();
    }
    return total;
}

/* 把凭据拼成 "Authorization" 头（没有用户名时写空串）。 */
static void auth_header(char *out, size_t n)
{
    const moink_settings_t *s = settings_get();
    out[0] = '\0';
    if (!s->remote_user[0]) return;

    char raw[SETT_USER_MAX + SETT_RPASS_MAX + 2];
    snprintf(raw, sizeof(raw), "%s:%s", s->remote_user, s->remote_pass);

    char b64[HTTP_B64_MAX];
    b64_encode(b64, sizeof(b64), raw);
    snprintf(out, n, "Authorization: Basic %s\r\n", b64);
}

/* GET 到 out（最多 cap 字节）；out 为 NULL 时把 body 流式喂给 sink。
   成功返回字节数，失败 -1。只认 200：404/403/500 都当失败，避免把错误页当帧解析。 */
static int http_get(const char *url, uint8_t *out, int cap, int *status,
                    int (*sink)(const void *, int))
{
    if (status) *status = 0;

    char target[SETT_URL_MAX];
    strlcpy(target, url, sizeof(target));

    for (int hop = 0; hop <= HTTP_REDIR_MAX; hop++) {
        url_t u;
        if (!url_parse(target, &u)) return -1;

        int fd = http_connect(&u, GET_TIMEOUT);
        if (fd < 0) return -1;

        char host[128];
        host_port(host, sizeof(host), &u);

        char authhdr[HTTP_B64_MAX + 32];
        auth_header(authhdr, sizeof(authhdr));

        char req[768];
        int rl = snprintf(req, sizeof(req),
                          "GET %s HTTP/1.1\r\n"
                          "Host: %s\r\n"
                          "User-Agent: MoInk\r\n"
                          "Accept: */*\r\n"
                          "Connection: close\r\n"
                          "%s"
                          "\r\n",
                          u.path, host, authhdr);
        if (rl <= 0 || rl >= (int)sizeof(req) ||
            send_all(fd, req, rl) != rl) {
            closesocket(fd);
            return -1;
        }

        resp_t r;
        if (resp_begin(&r, fd) != 0) {
            closesocket(fd);
            return -1;
        }

        /* 重定向：Location 可能是绝对地址，也可能是 "/path"。 */
        if (r.status >= 300 && r.status < 400 && r.loc[0] &&
            hop < HTTP_REDIR_MAX) {
            /* 缓冲留够 host(96) + Location(192) + 协议头，避免被判定截断 */
            char next[SETT_URL_MAX + 128];
            if (strncasecmp(r.loc, "http://", 7) == 0) {
                strlcpy(next, r.loc, sizeof(next));
            } else if (r.loc[0] == '/') {
                if (u.port == 80)
                    snprintf(next, sizeof(next), "http://%s%s", u.host, r.loc);
                else
                    snprintf(next, sizeof(next), "http://%s:%u%s",
                             u.host, (unsigned)u.port, r.loc);
            } else {
                closesocket(fd);            /* 相对路径重定向，不支持 */
                return -1;
            }
            if (strlen(next) >= sizeof(target)) {   /* 超长不悄悄截断 */
                closesocket(fd);
                return -1;
            }
            closesocket(fd);
            strlcpy(target, next, sizeof(target));
            continue;
        }

        if (status) *status = r.status;
        int got = (r.status == 200) ? resp_body(&r, out, cap, sink) : -1;
        closesocket(fd);
        return got;
    }
    return -1;
}

/* PUT：依次写 a、b 两段（帧头 + 帧载荷），避免为了连续缓冲再 malloc 106 KB。 */
static int http_put(const char *url, const uint8_t *a, int alen,
                    const uint8_t *b, int blen, int *status)
{
    if (status) *status = 0;

    url_t u;
    if (!url_parse(url, &u)) return -1;

    int fd = http_connect(&u, PUT_TIMEOUT);
    if (fd < 0) return -1;

    char host[128];
    host_port(host, sizeof(host), &u);

    char authhdr[HTTP_B64_MAX + 32];
    auth_header(authhdr, sizeof(authhdr));

    long total = (long)alen + (long)blen;
    char req[768];
    int rl = snprintf(req, sizeof(req),
                      "PUT %s HTTP/1.1\r\n"
                      "Host: %s\r\n"
                      "User-Agent: MoInk\r\n"
                      "Content-Type: application/octet-stream\r\n"
                      "Content-Length: %ld\r\n"
                      "Connection: close\r\n"
                      "%s"
                      "\r\n",
                      u.path, host, total, authhdr);
    if (rl <= 0 || rl >= (int)sizeof(req)) {
        closesocket(fd);
        return -1;
    }

    int rc = -1;
    if (send_all(fd, req, rl) == rl &&
        (alen == 0 || send_all(fd, a, alen) == alen) &&
        (blen == 0 || send_all(fd, b, blen) == blen)) {
        resp_t r;
        if (resp_begin(&r, fd) == 0) {
            if (status) *status = r.status;
            rc = (r.status >= 200 && r.status < 300) ? 0 : -1;
        }
    }
    closesocket(fd);
    return rc;
}

/* ---------------- 清单解析 ---------------- */

/*
 * 扫描清单。total 恒为「有效条目数」；target >= 0 时把该条的
 * 名字与 CRC32 写进 name/crc（crc 缺省为 0 = 不去重）。
 * 返回条目数；首行不是 MOINKMF1 或格式明显不对返回 -1。
 */
static int mf_scan(const char *txt, int target, char *name, size_t nsz, uint32_t *crc)
{
    const char *p = txt;
    bool hdr = false;
    int idx = 0;

    while (*p) {
        while (*p == '\r' || *p == '\n') p++;
        if (!*p) break;

        const char *e = p;
        while (*e && *e != '\r' && *e != '\n') e++;

        if (!hdr) {
            if ((size_t)(e - p) < 8 || strncmp(p, "MOINKMF1", 8) != 0) return -1;
            hdr = true;
            p = e;
            continue;
        }

        if (*p != '#' && *p != ' ' && *p != '\t') {
            /* 第一段 = 文件名 */
            char nm[MF_NAME_MAX];
            size_t k = 0;
            const char *q = p;
            while (q < e && *q != ' ' && *q != '\t') {
                if (k < sizeof(nm) - 1) nm[k++] = *q;
                q++;
                if (k >= sizeof(nm)) break;
            }
            nm[k] = '\0';
            /* 跳过空白后取 CRC32（8 位十六进制，可省） */
            while (q < e && (*q == ' ' || *q == '\t')) q++;
            uint32_t c32 = 0;
            if (q + 8 <= e) {
                for (int i = 0; i < 8; i++) {
                    char ch = q[i];
                    int d;
                    if (ch >= '0' && ch <= '9') d = ch - '0';
                    else if (ch >= 'a' && ch <= 'f') d = ch - 'a' + 10;
                    else if (ch >= 'A' && ch <= 'F') d = ch - 'A' + 10;
                    else { c32 = 0; break; }
                    c32 = (c32 << 4) | (uint32_t)d;
                }
            }
            if (nm[0]) {
                if (idx == target && name && nsz) {
                    strlcpy(name, nm, nsz);
                    if (crc) *crc = c32;
                }
                idx++;
            }
        }
        p = e;
    }
    return hdr ? idx : -1;
}

/* ---------------- 联网等待 ---------------- */

/* 定时唤醒后 STA 还在连，最长等 ONLINE_WAIT；未开联网直接判失败。 */
static bool wait_online(void)
{
    if (netif_sta_connected()) return true;
    if (!settings_get()->net_on) return false;
    for (int i = 0; i < ONLINE_WAIT / 250; i++) {
        vTaskDelay(pdMS_TO_TICKS(250));
        power_activity();
        if (netif_sta_connected()) return true;
    }
    return false;
}

/* ---------------- 拉取并刷屏 ---------------- */

/* 下载 url（整份 .bin = 16B 头 + 载荷）流式落到 flash scratch，校验后刷屏。
   成功返回 0，并把 (slot, 载荷 CRC32) 记进 NVS。
   ★ 不再需要 105 KB RAM：body 直接走 frame_blob_append，最后一个参数就是显存落点。 */
static int blob_sink(const void *d, int n)
{
    return frame_blob_append(d, n);
}

static int load_and_show(const char *url, uint8_t slot, uint32_t crc_expect)
{
    if (frame_blob_begin() != 0) { s_err = NF_ERR_MEM; return NF_ERR_MEM; }

    int st = 0;
    int n = http_get(url, NULL, EPD_MAX_BUF_LEN, &st, blob_sink);
    if (n < FRAME_HDR_LEN || st != 200) {
        frame_blob_abort();
        ESP_LOGW(TAG, "GET %s failed (n=%d status=%d)", url, n, st);
        s_err = NF_ERR_HTTP;
        return NF_ERR_HTTP;
    }

    const uint8_t *fb = frame_blob_map();
    if (!fb) { frame_blob_abort(); s_err = NF_ERR_MEM; return NF_ERR_MEM; }

    if (fb[0] != FRAME_MAGIC0 || fb[1] != FRAME_MAGIC1) {
        frame_blob_unmap(); frame_blob_abort();
        s_err = NF_ERR_HDR; return NF_ERR_HDR;
    }
    uint16_t w = (uint16_t)((fb[4] << 8) | fb[5]);
    uint16_t h = (uint16_t)((fb[6] << 8) | fb[7]);
    uint32_t len = ((uint32_t)fb[8] << 24) | ((uint32_t)fb[9] << 16) |
                   ((uint32_t)fb[10] << 8) | fb[11];
    uint16_t crc_hdr = (uint16_t)((fb[12] << 8) | fb[13]);

    if ((w & 3) || len != (uint32_t)(w / 4) * (uint32_t)h ||
        n != (int)(FRAME_HDR_LEN + len) || !epd_frame_geom_ok(w, h, len)) {
        frame_blob_unmap(); frame_blob_abort();
        ESP_LOGW(TAG, "bad geometry %ux%u len=%lu got=%d", w, h,
                 (unsigned long)len, n);
        s_err = NF_ERR_HDR;
        return NF_ERR_HDR;
    }
    if (crc16_of(fb + FRAME_HDR_LEN, len) != crc_hdr) {
        frame_blob_unmap(); frame_blob_abort();
        s_err = NF_ERR_CRC; return NF_ERR_CRC;
    }

    uint32_t pcrc = crc32_of(fb + FRAME_HDR_LEN, len);
    if (crc_expect && pcrc != crc_expect) {
        frame_blob_unmap(); frame_blob_abort();
        ESP_LOGW(TAG, "crc32 mismatch: got %08lx want %08lx",
                 (unsigned long)pcrc, (unsigned long)crc_expect);
        s_err = NF_ERR_CRC32;
        return NF_ERR_CRC32;
    }
    frame_blob_unmap();          /* 让 commit 重新映射并刷屏 */

    /* 先记 NVS 再刷屏？不 —— 刷屏失败就不能推进，与 carousel_next 语义一致。 */
    int r = frame_blob_commit_display(w, h);
    if (r != 0) { s_err = NF_ERR_HTTP; return NF_ERR_HTTP; }

    settings_remote_mark(slot, pcrc);
    s_err = NF_ERR_NONE;
    ESP_LOGI(TAG, "remote frame ok: %ux%u slot=%u crc32=%08lx", w, h,
             (unsigned)slot, (unsigned long)pcrc);
    return 0;
}

/* 拉清单到 s_mf，返回条目数。 */
static int fetch_manifest(void)
{
    const moink_settings_t *s = settings_get();
    char dir[SETT_URL_MAX], url[SETT_URL_MAX + 32];
    url_dir(dir, sizeof(dir), s->remote_url);
    url_join(url, sizeof(url), dir, "moink.mf");

    int st = 0;
    int n = http_get(url, (uint8_t *)s_mf, MF_MAX - 1, &st, NULL);
    if (n <= 0 || st != 200) {
        ESP_LOGW(TAG, "manifest GET failed (n=%d status=%d)", n, st);
        s_err = NF_ERR_MF;
        return NF_ERR_MF;
    }
    s_mf[n] = '\0';
    int c = mf_scan(s_mf, -1, NULL, 0, NULL);
    if (c < 0) { s_err = NF_ERR_MF; return NF_ERR_MF; }
    s_count = c;
    return c;
}

/* 清单模式：取下一张。 */
static int remote_next(void)
{
    const moink_settings_t *s = settings_get();
    int total = fetch_manifest();
    if (total < 0) return total;
    if (total == 0) { s_err = NF_ERR_MF; return NF_ERR_MF; }

    int last = (s->remote_slot == 0xFF) ? -1 : (int)s->remote_slot;
    if (last >= total - 1) last = -1;          /* 清单变短 → 从头开始 */
    int target = last + 1;

    char name[MF_NAME_MAX];
    uint32_t crc = 0;
    if (mf_scan(s_mf, target, name, sizeof(name), &crc) != total) {
        s_err = NF_ERR_MF;
        return NF_ERR_MF;
    }

    /* 只有一张且没变：不动屏幕，省一次整屏刷新（本屏一次 2~45 s）。 */
    if (total == 1 && target == (int)s->remote_slot && crc && crc == s->remote_crc) {
        s_err = NF_ERR_NONE;
        ESP_LOGI(TAG, "remote: single entry unchanged, skip");
        return 0;
    }

    char dir[SETT_URL_MAX], url[SETT_URL_MAX + MF_NAME_MAX + 8];
    url_dir(dir, sizeof(dir), s->remote_url);
    url_join(url, sizeof(url), dir, name);
    return load_and_show(url, (uint8_t)target, crc);
}

/* ---------------- 对外接口 ---------------- */

int net_fetch_display(void)
{
    const moink_settings_t *s = settings_get();
    if (s->remote_mode == SETT_REMOTE_OFF || !s->remote_url[0]) return NF_ERR_OFF;
    if (s_busy) return NF_ERR_BUSY;
    if (!wait_online()) { s_err = NF_ERR_OFF; return NF_ERR_OFF; }

    s_busy = true;
    power_activity();
    int r = (s->remote_mode == SETT_REMOTE_URL)
                ? load_and_show(s->remote_url, 0, 0)
                : remote_next();
    power_activity();
    s_busy = false;
    return r;
}

static void sync_task(void *arg)
{
    (void)arg;
    net_fetch_display();
    vTaskDelete(NULL);
}

int net_fetch_sync_async(void)
{
    if (s_busy) return NF_ERR_BUSY;
    if (xTaskCreate(sync_task, "net_sync", 6144, NULL, 4, NULL) != pdPASS)
        return NF_ERR_MEM;
    return 0;
}

int net_fetch_probe(void)
{
    const moink_settings_t *s = settings_get();
    if (s->remote_mode != SETT_REMOTE_MF || !s->remote_url[0]) return NF_ERR_OFF;
    if (!wait_online()) { s_err = NF_ERR_OFF; return NF_ERR_OFF; }
    s_err = NF_ERR_NONE;
    return fetch_manifest();
}

int net_fetch_count(void)     { return s_count; }
int net_fetch_last_err(void)  { return s_err; }
bool net_fetch_busy(void)     { return s_busy; }

/* ---------------- P4：上传转发 ---------------- */

int net_upload_remote(const uint8_t *hdr, const uint8_t *payload, uint32_t len)
{
    const moink_settings_t *s = settings_get();
    if (s->remote_mode == SETT_REMOTE_OFF || !s->remote_url[0]) return NF_ERR_OFF;
    if (!netif_sta_connected()) return NF_ERR_HTTP;

    char dir[SETT_URL_MAX];
    url_dir(dir, sizeof(dir), s->remote_url);

    /* 文件名用随机数：设备没有 RTC，时间戳每次重启都是 1970，会互相覆盖。 */
    char name[24];
    snprintf(name, sizeof(name), "u_%08lx.bin", (unsigned long)(esp_random() & 0xFFFFFFFFu));

    char url[SETT_URL_MAX + 32];
    url_join(url, sizeof(url), dir, name);

    int st = 0;
    if (http_put(url, hdr, FRAME_HDR_LEN, payload, (int)len, &st) != 0) {
        ESP_LOGW(TAG, "PUT %s failed (status=%d)", url, st);
        return NF_ERR_HTTP;
    }

    /* 读回清单 → 追加一行 → 写回。单用户设备，用顺序执行串行化即可。 */
    char mfurl[SETT_URL_MAX + 32];
    url_join(mfurl, sizeof(mfurl), dir, "moink.mf");

    int n = http_get(mfurl, (uint8_t *)s_mf, MF_MAX - 1, &st, NULL);
    if (n <= 0 || st == 404) {
        strlcpy(s_mf, "MOINKMF1\n", MF_MAX);
        n = (int)strlen(s_mf);
    } else if (st != 200) {
        return NF_ERR_HTTP;
    }
    s_mf[n] = '\0';

    uint32_t crc = crc32_of(payload, len);
    char line[96];
    int ll = snprintf(line, sizeof(line), "%s%s %08lx\n",
                      (n > 0 && s_mf[n - 1] != '\n') ? "\n" : "",
                      name, (unsigned long)crc);
    if (n + ll >= MF_MAX - 1) {
        ESP_LOGW(TAG, "manifest full (%d + %d >= %d)", n, ll, MF_MAX);
        return NF_ERR_MEM;
    }
    memcpy(s_mf + n, line, (size_t)ll);
    n += ll;
    s_mf[n] = '\0';

    if (http_put(mfurl, (const uint8_t *)s_mf, n, NULL, 0, &st) != 0) {
        ESP_LOGW(TAG, "manifest PUT failed (status=%d)", st);
        return NF_ERR_HTTP;
    }
    ESP_LOGI(TAG, "uploaded %s (%lu B) + manifest (%d B)", name,
             (unsigned long)len, n);
    return 0;
}
