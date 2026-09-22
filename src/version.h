#ifndef MOINK_VERSION_H
#define MOINK_VERSION_H

/*
 * 三层版本号（重构 R 系列起点，与旧 M 系列区分）：
 *   api  2  —— 帧格式契约版本（16 字节头 + 2bpp 载荷；载荷几何 768x552 或 A1 原生 800x600）。
 *   fw   R1.1.1 —— 固件版本（PROJECT_VER 展示串，写入 OTA app_desc 的 project_name）。
 *   page R1.1.1 —— 内嵌页面版本（OTA 上传页面后以解析到的 meta 为准）。
 *
 * api 2 变更（2026-09-22，FB-010）：帧头字段与偏移不变，hdr[2] 允许 1 或 2
 * （2 = 载荷为 A1 原生 800x600）；固件按 hdr 里的宽高自行判断载荷布局，
 * 故 api 1 的 768x552 帧仍被接受，旧页面热更不跟进时不会失效。
 *
 * R1.1.1 变更（2026-09-23，FB-011 / FB-012）：api 保持 2（未动帧格式）。
 *   FB-011 —— 页面 DEV_API 改三态，离线预览也能显示 A1 驱动档位与 800x600 编辑空间；
 *   FB-012 —— /api/ota 新增可选查询参数 ?sync_page=1，校验通过后清除页面热更标记，
 *             使固件升级可一并把控制页切回内嵌新页面；A1 档位下拉文案精简。
 *
 * 升级判据：改动是否涉及固件接口（api 或路由）——没动就只发页面，动了就固件 + 页面同步。
 */
#define MOINK_API_VERSION   2
#define MOINK_FW_VERSION    "R1.1.1"
#define MOINK_PAGE_VERSION  "R1.1.1"

#endif /* MOINK_VERSION_H */
