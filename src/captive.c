#include "captive.h"

#include "esp_log.h"
#include "esp_netif.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <string.h>
#include <errno.h>

static const char *TAG = "captive";

#define DNS_PORT 53
#define DNS_BUF  512

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

    uint8_t q[DNS_BUF], r[DNS_BUF];

    for (;;) {
        struct sockaddr_in from;
        socklen_t fl = sizeof(from);
        int n = recvfrom(sock, q, sizeof(q), 0, (struct sockaddr *)&from, &fl);
        if (n < 12) continue;                 /* 至少一个完整 DNS 头 */

        /* 跳过非标准查询（QR=0 且 QDCOUNT>0）。 */
        if ((q[2] & 0x80) != 0) continue;
        if (q[4] != 0 || q[5] == 0) continue;

        memset(r, 0, sizeof(r));
        r[0] = q[0]; r[1] = q[1];             /* 事务 ID 原样回 */
        r[2] = 0x81; r[3] = 0x80;             /* QR=1, RD/RA，无错误 */
        r[4] = 0x00; r[5] = 0x01;             /* QDCOUNT = 1 */
        r[6] = 0x00; r[7] = 0x01;             /* ANCOUNT = 1 */

        /* 问题段长度：走 label 长度字节，兼容压缩指针。 */
        int qend = 12;
        while (qend < n && q[qend] != 0) {
            if ((q[qend] & 0xC0) == 0xC0) { qend += 2; break; }
            qend += 1 + q[qend];
        }
        qend += 1;                            /* 结尾 0 */
        qend += 4;                            /* QTYPE + QCLASS */
        if (qend > n) continue;
        memcpy(r + 12, q + 12, (size_t)(qend - 12));
        /* R1.0.8：答案段固定 16 字节，问题段满长时会越界写任务栈，直接丢弃 */
        if (qend + 16 > DNS_BUF) continue;

        /* 答案：指向问题段的压缩指针 + A 记录 192.168.4.1，TTL 60。 */
        int a = qend;
        r[a++] = 0xC0; r[a++] = 0x0C;         /* NAME ptr -> offset 12 */
        r[a++] = 0x00; r[a++] = 0x01;         /* TYPE  = A   */
        r[a++] = 0x00; r[a++] = 0x01;         /* CLASS = IN  */
        r[a++] = 0x00; r[a++] = 0x00; r[a++] = 0x00; r[a++] = 0x3C; /* TTL 60 */
        r[a++] = 0x00; r[a++] = 0x04;         /* RDLEN = 4  */
        r[a++] = 192; r[a++] = 168; r[a++] = 4; r[a++] = 1;

        sendto(sock, r, a, 0, (struct sockaddr *)&from, fl);
    }
}

void captive_dns_start(void)
{
    xTaskCreate(dns_task, "captive_dns", 3072, NULL, 5, NULL);
}

bool captive_probe_redirect(httpd_req_t *req)
{
    const char *uri = req->uri;

    /* 带导航意图的探测：重定向到控制页。 */
    if (strcmp(uri, "/generate_204") == 0 ||
        strcmp(uri, "/hotspot-detect.html") == 0 ||
        strcmp(uri, "/redirect") == 0 ||
        strcmp(uri, "/canonical.html") == 0 ||
        strcmp(uri, "/success.txt") == 0 ||
        strcmp(uri, "/library/test/success.html") == 0) {
        httpd_resp_set_status(req, "302 Found");
        httpd_resp_set_hdr(req, "Location", "/");
        httpd_resp_send(req, NULL, 0);
        return true;
    }

    /* 纯连通性探针：返回系统期望的正文。 */
    if (strcmp(uri, "/ncsi.txt") == 0) {
        httpd_resp_set_type(req, "text/plain");
        httpd_resp_sendstr(req, "Microsoft NCSI");
        return true;
    }
    if (strcmp(uri, "/connecttest.txt") == 0) {
        httpd_resp_set_type(req, "text/plain");
        httpd_resp_sendstr(req, "Microsoft Connect Test");
        return true;
    }

    return false;
}
