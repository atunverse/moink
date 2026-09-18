#ifndef MOINK_CAPTIVE_H
#define MOINK_CAPTIVE_H

#include "esp_http_server.h"
#include <stdbool.h>

/*
 * 强制门户：手机连上热点后自动弹出控制页。
 *   1) DNS 劫持：UDP :53 上把一切 A 查询都答成 192.168.4.1。
 *   2) OS 探测劫持：/generate_204、/hotspot-detect.html 等路径重定向到首页，
 *      或返回各系统期望的探测正文。
 */

/* 启动 DNS 劫持任务（不返回，内部自建任务）。 */
void captive_dns_start(void);

/* 处理 OS captive 探测路径；命中则已响应并返回 true。 */
bool captive_probe_redirect(httpd_req_t *req);

#endif /* MOINK_CAPTIVE_H */
