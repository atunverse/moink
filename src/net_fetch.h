#ifndef MOINK_NET_FETCH_H
#define MOINK_NET_FETCH_H

#include <stdint.h>
#include <stdbool.h>

/*
 * 远程图槽（R1.4.0）：定时唤醒后不走本地 8 槽，而是从 HTTP 目录 / WebDAV
 * 拉一张 .bin 直接刷屏 —— 全程只碰帧缓冲，零 flash 写。
 *
 * 两种模式（settings.remote_mode）：
 *   SETT_REMOTE_URL  remote_url 直接指向一个 .bin
 *   SETT_REMOTE_MF   remote_url 指向目录，读其中的 moink.mf 逐张轮播
 *
 * 清单格式（纯文本，UTF-8/ASCII）：
 *   MOINKMF1
 *   0001.bin 1a2b3c4d
 *   0002.bin 89abcdef
 * 第二列是「载荷」的 CRC32（zlib 口径），可省略（省略则不去重，每次照刷）。
 *
 * ★ 失败语义：任何失败都返回非 0 且屏幕保持不动，由调用方回退本地轮播。
 */

/* 错误码（net_fetch_last_err 返回这些值，0 = 没错） */
#define NF_ERR_NONE     0
#define NF_ERR_OFF     -1    /* 远程模式关闭 / 无 URL / 未联网 */
#define NF_ERR_HTTP    -2    /* 连接或状态码失败 */
#define NF_ERR_HDR     -3    /* 帧头不合法（魔数 / 几何 / 长度） */
#define NF_ERR_CRC     -4    /* 载荷 CRC16 不符 */
#define NF_ERR_CRC32   -5    /* 与清单里的 CRC32 不符 */
#define NF_ERR_MF      -6    /* 清单缺失或格式错 */
#define NF_ERR_BUSY    -7    /* 已有一次同步在跑 */
#define NF_ERR_MEM     -8    /* 清单超长 / 帧缓冲抢不到 */

/* 取一张并刷屏。成功 0；失败 <0（NF_ERR_*）。会等 STA 连上（最多 15 s）。 */
int net_fetch_display(void);

/* 页面「立即同步」：起一次性任务，不阻塞 httpd。0 = 已排队。 */
int net_fetch_sync_async(void);

/* 只拉清单、更新内部计数，不刷屏。返回条目数（<0 = 失败）。 */
int net_fetch_probe(void);

int  net_fetch_count(void);
int  net_fetch_last_err(void);
bool net_fetch_busy(void);

/*
 * P4 上传转发：把一帧 PUT 到远程目录并追加进清单。
 *   hdr     16 字节帧头；payload 载荷；len 载荷长度。
 * 调用方必须已持有帧缓冲（即正在 frame_upload_handler 里）。
 * 返回 0 成功 / NF_ERR_OFF / NF_ERR_HTTP / NF_ERR_MEM（清单超 4 KB）。
 */
int net_upload_remote(const uint8_t *hdr, const uint8_t *payload, uint32_t len);

#endif /* MOINK_NET_FETCH_H */
