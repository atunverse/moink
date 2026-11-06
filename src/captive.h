#ifndef MOINK_CAPTIVE_H
#define MOINK_CAPTIVE_H

#include "esp_http_server.h"
#include <stdbool.h>
/*
 * 强制门户：手机连上热点后自动弹出控制页。
 *   1) DNS 劫持：UDP :53 上把一切 A 查询都答成 192.168.4.1。
 *   2) 未匹配业务路由的 GET（包括 OS 探测）重定向到设备首页。
 */

/* 启动 DNS 劫持任务（不返回，内部自建任务）。 */
void captive_dns_start(void);

/* 注册为最后一个 GET 通配路由。 */
esp_err_t captive_redirect(httpd_req_t *req);

/* Apple 探测地址返回轻量 Safari 引导页；完成页友好提示，后台复探返回标准 Success。 */
esp_err_t captive_apple_landing(httpd_req_t *req);

/* WiFi 客户端断开时清除本次 Apple Success 状态。 */
void captive_apple_station_disconnected(void);

/* 客户端连上热点时调用：开一次 60 秒门户窗口。
 * 窗口内只把系统探测域名解析到设备（弹窗必然出现），其它域名照常转发，
 * 网络同时可用；窗口结束后全部放行，手机判定「有网」并自动关闭门户页。 */
void captive_portal_arm(void);

/* 门户窗口是否仍然有效。 */
bool captive_portal_active(void);

#endif /* MOINK_CAPTIVE_H */
