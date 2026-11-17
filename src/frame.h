#ifndef MOINK_FRAME_H
#define MOINK_FRAME_H

#include "esp_http_server.h"
#include <stddef.h>
#include <stdint.h>

/*
 * 帧格式 v1/v2（api = 2）：16 字节头（大端）+ 2bpp 载荷。字段与偏移不变，
 * 只有 hdr[2] 与载荷几何在 v2 上扩展：
 *
 *   偏移 0-1   魔数 0xA5 0x5A
 *   偏移 2     格式版本：1 = 768x552 载荷；2 = A1 原生 800x600 载荷
 *   偏移 3     面板类型（0=A0 / 1=A1，信息性字段）
 *   偏移 4-5   宽（BE）
 *   偏移 6-7   高（BE）
 *   偏移 8-11  载荷长度（BE）
 *   偏移 12-13 CRC16/CCITT-FALSE（poly 0x1021, init 0xFFFF，载荷字节）
 *   偏移 14-15 保留（0）
 *
 * 载荷为 2bpp 位图（MSB 优先、行自下而上 = 180° 契约，与 epd_drv.c 一致），
 * 长度为 宽/4*高：768x552 → 105984；800x600 → 120000。
 * 固件按 hdr 里的宽高判定布局，两种几何都接受（见 epd_frame_geom_ok）。
 */

#define FRAME_HDR_LEN    16
#define FRAME_MAGIC0     0xA5
#define FRAME_MAGIC1     0x5A
#define FRAME_FMT_VERSION 1          /* 基础格式（768x552 载荷） */
#define FRAME_FMT_VERSION_NATIVE 2   /* A1 原生 800x600 载荷 */

/* 打开 flash 落点（scratch 分区）。幂等；没有该分区只打日志，不影响其它功能。 */
void frame_prealloc(void);

/* 创建同步量。 */
void frame_init(void);

/* 阻塞等待一帧就绪（由上传处理器触发）。 */
void frame_wait(void);

/* 锁缓冲 -> 整屏刷新 -> 面板深睡 -> 解锁。成功返回 0。 */
int frame_display_now(void);

/* R1.0.8：残影清理（持帧锁，与传图/显示互斥）。成功返回 0。 */
int frame_clear_cycles(int cycles);

/* POST /api/frame 处理器：收头 -> 校验 -> 流式收载荷并算 CRC -> 触发显示。
   R1.3.0 轮播 query：
     save=1            存槽并显示
     save=1&noshow=1  只存不显示（批量上传前几张，避免逐张刷屏）
     无 save           只显示不存（原行为） */
esp_err_t frame_upload_handler(httpd_req_t *req);

/* R1.3.0 轮播：读 store 槽 slot（头+载荷）-> 校验几何 -> 整屏显示。
   与传图/残影清理共用帧锁。成功返回 0，空/坏槽或几何不符返回非 0。 */
int frame_display_slot(int slot);

/* ---------------- R1.4.0：流式帧落点（替代 120 KB 静态缓冲） ----------------
 *
 * 帧不再驻留 RAM：上传/远程下载都「边收边写」flash 里的 scratch 分区，
 * 显示时用 esp_partition_mmap() 把同一块 flash 映射进地址空间，直接把只读
 * 指针交给驱动 —— epd_write_frame_2bpp() 本来就是逐行读 src，零改动。
 *
 * 用法固定（三个终点互斥，全部负责解锁）：
 *   if (frame_blob_begin() != 0) return -1;      // 擦 scratch + 取锁
 *   while (...) frame_blob_append(d, n);         // 任意次
 *   ...任意失败分支都调 frame_blob_abort()...
 *   return frame_blob_commit_display(w, h);      // flush + 刷屏 + 解锁
 *
 * ★ 上传路径另外还要在解锁前自己 flush（frame_upload_handler 内部已处理）。
 * ★ 锁被占（有别的刷屏在跑）时 begin 返回 -1，调用方应直接放弃。
 */
int  frame_blob_begin(void);
int  frame_blob_append(const void *d, int n);
int  frame_blob_commit_display(uint16_t w, uint16_t h);
void frame_blob_abort(void);
uint32_t frame_blob_bytes(void);

/* 把 scratch 内容（头+载荷）映射成只读指针，供远程 PUT 直接发送。
   成功返回基址（含 16 B 帧头），失败 NULL。调用方用完必须 frame_blob_unmap()。 */
const uint8_t *frame_blob_map(void);
void frame_blob_unmap(void);

#endif /* MOINK_FRAME_H */
