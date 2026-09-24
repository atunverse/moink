#pragma once
#include <stdint.h>

/*
 * 轮播帧存储底座（FB-017 第一部分，随 R1.2.0 并入）：
 * 本版只做分区探测与容量上报，不读不写 —— 轮播的上传 / 调度 / 播放在第二部分接入。
 * 提前把 store 分区固化进 4MB 分区表，是因为分区表只能靠整包线刷改写（OTA 改不了）。
 *
 * 槽位布局（写入策略详见 docs/调研-内置Flash延寿方案.md）：
 *   - 槽位固定 128 KB（STORE_SLOT_SZ），共 STORE_SLOT_MAX 个；单槽可容纳最大帧
 *     800x600 2bpp = 120,000 B（768x552 = 105,984 B）。
 *   - 轮播图片「整槽轮转写入」：新图永远写下一个槽（round-robin），绝不原地覆写，
 *     把擦写均匀摊到全部槽位上；轮播游标（当前槽号 / 张数 / 播放模式）存 NVS
 *     （NVS 自带磨损均衡），store 分区内不放会被反复改写的元数据。
 */

#define STORE_SLOT_SZ   0x20000u   /* 单槽 128 KB */
#define STORE_SLOT_MAX  8u         /* 0x110000 / 0x20000 */
#define STORE_FRAME_MAX 120000u    /* 一帧的最大字节数（800x600 2bpp） */

/* 启动时探测 "store" 分区；缺失（旧分区表 OTA 上来的设备）时 slots = 0。 */
void store_init(void);

/* 可用槽位数；0 = 分区不存在，轮播功能不可用。 */
int store_slots(void);
