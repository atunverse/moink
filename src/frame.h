#ifndef MOINK_FRAME_H
#define MOINK_FRAME_H

#include "esp_http_server.h"
#include <stddef.h>
#include <stdint.h>

/*
 * 帧格式 v1（api = 1）：16 字节头（大端）+ 2bpp 载荷。
 *
 *   偏移 0-1   魔数 0xA5 0x5A
 *   偏移 2     格式版本 = 1
 *   偏移 3     面板类型（0=A0 / 1=A1，信息性字段）
 *   偏移 4-5   宽（BE）
 *   偏移 6-7   高（BE）
 *   偏移 8-11  载荷长度（BE）
 *   偏移 12-13 CRC16/CCITT-FALSE（poly 0x1021, init 0xFFFF，载荷字节）
 *   偏移 14-15 保留（0）
 *
 * 载荷为 768x552 的 2bpp 位图，105984 字节，MSB 优先、行自下而上（180° 契约，
 * 与 epd_drv.c 完全一致）。整帧上传，无局部刷新。
 */

#define FRAME_HDR_LEN    16
#define FRAME_MAGIC0     0xA5
#define FRAME_MAGIC1     0x5A
#define FRAME_FMT_VERSION 1

/* 分配帧缓冲并创建同步量。 */
void frame_init(void);

/* 阻塞等待一帧就绪（由上传处理器触发）。 */
void frame_wait(void);

/* 锁缓冲 -> 整屏刷新 -> 面板深睡 -> 解锁。成功返回 0。 */
int frame_display_now(void);

/* R1.0.8：残影清理（持帧锁，与传图/显示互斥）。成功返回 0。 */
int frame_clear_cycles(int cycles);

/* POST /api/frame 处理器：收头 -> 校验 -> 流式收载荷并算 CRC -> 触发显示。 */
esp_err_t frame_upload_handler(httpd_req_t *req);

#endif /* MOINK_FRAME_H */
