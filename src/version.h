#ifndef MOINK_VERSION_H
#define MOINK_VERSION_H

/*
 * 三层版本号（重构 R 系列起点，与旧 M 系列区分）：
 *   api  1  —— 帧格式契约版本（16 字节头 + 2bpp 载荷）。页面 / 固件据此判兼容。
 *   fw   R1.0.0 —— 固件版本（PROJECT_VER 展示串，写入 OTA app_desc 的 project_name）。
 *   page R1.0.0 —— 内嵌页面版本（OTA 上传页面后以解析到的 meta 为准）。
 *
 * 升级判据：改动是否涉及固件接口（api 或路由）——没动就只发页面，动了就固件 + 页面同步。
 */
#define MOINK_API_VERSION   1
#define MOINK_FW_VERSION    "R1.0.10"
#define MOINK_PAGE_VERSION  "R1.0.24"

#endif /* MOINK_VERSION_H */
