/*
 * diag.h —— 临时诊断开关（2026-11-16）
 *
 * 起因：勾选 120Hz 后网页打不开，串口却一片安静（不 panic、不复位、无 httpd 报错），
 *       无法判断「芯片死了」还是「httpd 卡住」还是「请求根本没到」。
 *
 * 打开后（MOINK_DIAG 1）会额外输出：
 *   - 每 3 秒一行心跳：堆余量 / 最低水位 / 运行时长 / 当前 PLL
 *   - 每个 HTTP 请求进来时打一行（方法 + URI）
 *   - WiFi 热点：手机接入/断开（平时是 LOGI，被日志级别压掉了）
 *   - 刷屏：开始 / 每一步失败 / 结束耗时（平时是 LOGI）
 *
 * ★ 平时置 0（默认）：diag_req() 只剩一次空调用，心跳任务根本不创建，零成本。
 *   下次再遇到「堆一路阴跌 / 网页打不开 / 刷新卡住」时改成 1 重编，
 *   配合 tools/serial_cap.py 实时看日志即可。
 *
 * 2026-11-16 就是靠它定位到「TIME_WAIT 120 s + 13 条连接把堆榨干」的。
 */
#ifndef MOINK_DIAG_H
#define MOINK_DIAG_H

#define MOINK_DIAG 1

/* 请求计数 + 逐请求打点（定义在 main.c）。打开诊断时心跳会打印计数，
   可以判断「页面打不开」到底是请求没到设备，还是到了但应答回不去。
   ★ 声明必须在 #if 之外：关闭诊断时各 handler 仍会调用它（函数体是空的）。 */
extern volatile unsigned g_req_count;
void diag_req(const char *uri);

#if MOINK_DIAG
#include "esp_log.h"
#define DIAG_E(tag, fmt, ...) ESP_LOGE(tag, "[diag] " fmt, ##__VA_ARGS__)
#else
#define DIAG_E(tag, fmt, ...) do { (void)(tag); } while (0)
#endif

#endif /* MOINK_DIAG_H */
