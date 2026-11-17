#ifndef MOINK_OTA_WEB_H
#define MOINK_OTA_WEB_H

#include "esp_http_server.h"
#include <stddef.h>

/*
 * 固件升级入口 —— R1.4.0 起只做 OTA，控制页随固件一起更新。
 *
 *   POST /api/upload    唯一升级入口，只接受 ESP32 镜像（首字节 0xE9）。
 *                       写另一 OTA 槽 -> 校验 -> 重置设置（保留热点凭据）
 *                       -> 切槽重启；新固件跑稳 45s 才取消回滚，失败自动回滚。
 *
 * 页面热更整体移除（R1.4.0）：web 分区已从分区表删除，
 * /api/web/clear、page_ver 与「页面分区分流」全部不再存在，控制页只有内嵌一份。
 */

/* 注册 /api/upload 路由。 */
void ota_web_register(httpd_handle_t server);

/* 上电后调用：跑稳 45s 取消回滚（无回滚待确认时是无害空操作）。 */
void ota_web_confirm(void);

#endif /* MOINK_OTA_WEB_H */
