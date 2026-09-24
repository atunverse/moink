/*
 * 墨印 · MoInk — store 原始帧存储（R1.2.0 底座，FB-017 第一部分）
 *
 * 职责一句话：找到分区表里的 "store" 分区，报告槽位容量。本版不写入。
 *
 * 为什么不用文件系统（LittleFS / FATFS）：轮播帧是「定长大对象、写一次读多次」，
 * 整槽轮转写入的写放大 = 恰好 1（每张图消耗一次整槽擦除），没有任何文件系统
 * 元数据开销；LittleFS 的写时复制与元数据提交反而会带来额外擦写。
 * 若第二部分出现「变长文件 / 频繁改写」的需求再重新评估（分区 subtype 已按
 * spiffs 预留，届时无需改表）。
 */
#include "store.h"

#include <stdio.h>

#include "esp_log.h"
#include "esp_partition.h"

static const char *TAG = "store";

static const esp_partition_t *s_part;
static uint32_t s_slots;

void store_init(void)
{
    s_part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
                                      ESP_PARTITION_SUBTYPE_ANY, "store");
    if (!s_part) {
        s_slots = 0;
        ESP_LOGW(TAG, "store partition not found (flashed over an older "
                      "partition table via OTA?) - carousel storage unavailable");
        return;
    }

    s_slots = s_part->size / STORE_SLOT_SZ;
    if (s_slots > STORE_SLOT_MAX) s_slots = STORE_SLOT_MAX;
    ESP_LOGI(TAG, "store: off=0x%06lx size=%lu KB, %lu slot(s) x %u KB "
                  "(frame <= %u B)",
             (unsigned long)s_part->address, (unsigned long)(s_part->size / 1024),
             (unsigned long)s_slots, (unsigned)(STORE_SLOT_SZ / 1024),
             (unsigned)STORE_FRAME_MAX);
}

int store_slots(void)
{
    return (int)s_slots;
}
