#ifndef MOINK_OTA_WEB_H
#define MOINK_OTA_WEB_H

#include "esp_http_server.h"
#include <stddef.h>

/*
 * OTA + 页面热更。
 *   POST /api/ota  —— 收 app 包写另一 OTA 槽，校验后切槽重启；新固件跑稳 45s 才
 *                     取消回滚（esp_ota_mark_app_valid_cancel_rollback），失败自动回滚。
 *   POST /api/web  —— 收 index.html 写入 960KB "web" 分区（带 CRC32），并解析页面
 *                     版本号存 NVS。GET / 优先返回 web 分区里的页面，否则返回内嵌页。
 */

/* 注册 /api/ota 与 /api/web 路由。 */
void ota_web_register(httpd_handle_t server);

/* 上电后调用：跑稳 45s 取消回滚（无回滚待确认时是无害空操作）。 */
void ota_web_confirm(void);

/* web 分区容量（字节，运行时读取，勿硬编码）。 */
size_t ota_web_capacity(void);

/* web 分区是否存在已上传页面。 */
bool ota_web_has_page(void);

/* 清除已上传页面，回退到内嵌页。 */
void ota_web_clear(void);

/* 当前生效页面版本（上传过的优先，否则回退内嵌页版本）。 */
const char *ota_web_page_version(void);

/* 流式发送 web 分区里的页面（调用前先 ota_web_has_page()）。 */
esp_err_t ota_web_stream_page(httpd_req_t *req);

#endif /* MOINK_OTA_WEB_H */
