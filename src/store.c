/*
 * 墨印 · MoInk — store 原始帧存储（R1.2.0 底座 + R1.3.0 读写 + R1.3.1 交互定案）
 *
 * 职责一句话：把「帧头 + 2bpp 载荷」整槽写进 store 分区，支持按键轮播。
 *
 * 为什么不用文件系统（LittleFS / FATFS）：轮播帧是「定长大对象、写一次读多次」，
 * 整槽写入的写放大 = 恰好 1（每张图消耗一次整槽擦除），没有任何文件系统
 * 元数据开销；LittleFS 的写时复制与元数据提交反而会带来额外擦写。
 *
 * R1.3.0（FB-017 第二部分）：实现帧存取 + 轮播元数据（NVS "store" 命名空间），
 *   写入为 round-robin 轮转覆盖。
 * R1.3.1（交互定案）：语义改为「追加到末尾」——
 *   - 新图永远写到 count 槽，轮播满 8 张时拒绝上传（STORE_ERR_FULL），不再轮转覆盖；
 *   - store_delete_slot() 删除后把后续槽整体前移一位（顺序紧凑），新图继续追加；
 *     ⚠️ 该行为自 R1.3.4 起取消，见下一节。
 *   - store_thumb_frame() 输出 96x69 的 8x8 抽稀缩略小帧，供网页缩略图列表渲染。
 *   读取：读槽 -> 校验魔数（0xA5 0x5A）-> 按头里的载荷长读回 -> 交 frame.c 显示。
 *   清空：只清 NVS 元数据，不擦 flash（下次写入整槽覆盖，省一次全分区擦写）。
 *
 * R1.3.4（FB-020 根治）：取消「删除后前移」——
 *   - 新增 NVS 位图 alive（1 字节，bit i = 物理槽 i 有效）。逻辑序号 = alive 中
 *     第 N 个置位的物理槽，因此物理槽允许留空洞，删除不再搬移任何数据。
 *   - 删除 = 清一个 bit + count--/cur 修正，一次 NVS commit（原子），flash 零擦写。
 *     原来删最前一张要搬 7 个槽（≈10 s、896 KB 擦写），现在 <20 ms。
 *   - 上传优先写「末尾之后」的空位（等价于追加到末尾），末尾已满才回填最早的空洞。
 *   - 老固件只有 cnt、没有 alive 键：init 时按 (1<<cnt)-1 生成，与旧物理布局等价；
 *     alive 与 cnt 不一致时以 alive 为准修正 cnt（自愈）。
 *   - 对外语义不变：接口的 slot 一律是逻辑序号（0..count-1），api 仍为 2。
 */
#include "store.h"

#include <string.h>

#include "esp_log.h"
#include "esp_partition.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "store";

#define NVS_NS      "store"
#define KEY_COUNT   "cnt"
#define KEY_CUR     "cur"
#define KEY_WIDX    "widx"      /* R1.3.4 起不再维护（写指针恒等于 count） */
#define KEY_ALIVE   "alive"     /* R1.3.4：物理槽有效位图，bit i = 槽 i 有效 */

/* 帧头魔数（与 frame.h 的 FRAME_MAGIC0/1 一致，此处按值校验避免头文件耦合）。 */
/* 槽内帧头魔数见 store.h（STORE_MAGIC0/1）。 */static const esp_partition_t *s_part;
static uint32_t s_slots;
static uint8_t  s_alive;        /* R1.3.4：物理槽有效位图（RAM 缓存，写时同步） */
static SemaphoreHandle_t s_lock;

/* ---------------- NVS 小工具 ---------------- */

static int st_nvs_get_u8(const char *k, uint8_t *v)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return -1;
    esp_err_t e = nvs_get_u8(h, k, v);
    nvs_close(h);
    if (e == ESP_ERR_NVS_NOT_FOUND) { *v = 0; return 0; }
    return (e == ESP_OK) ? 0 : -1;
}

static int st_nvs_set_u8(const char *k, uint8_t v)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return -1;
    esp_err_t e = nvs_set_u8(h, k, v);
    if (e == ESP_OK) e = nvs_commit(h);
    nvs_close(h);
    return (e == ESP_OK) ? 0 : -1;
}

/* R1.3.2：多键一次提交（k2/k3 传 NULL 表示没有更多键）。
   原来 cnt / cur 各走一次 st_nvs_set_u8，每次切图要 2 次 NVS commit，
   长期按键轮播会明显增加擦写磨损；而且两次提交之间掉电会留下
   「count 已变、cur 还是旧值」的半套状态。 */
static int st_nvs_set_u8s(const char *k1, uint8_t v1,
                          const char *k2, uint8_t v2,
                          const char *k3, uint8_t v3)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return -1;
    esp_err_t e = nvs_set_u8(h, k1, v1);
    if (e == ESP_OK && k2) e = nvs_set_u8(h, k2, v2);
    if (e == ESP_OK && k3) e = nvs_set_u8(h, k3, v3);
    if (e == ESP_OK) e = nvs_commit(h);
    nvs_close(h);
    if (e != ESP_OK) ESP_LOGW(TAG, "nvs meta write failed: %s", esp_err_to_name(e));
    return (e == ESP_OK) ? 0 : -1;
}

/* 与 st_nvs_get_u8 相同，但额外报告「键是否存在」——store_init 用它区分
   「从没有 alive 键（老固件升级）」和「alive 恰为 0（用户清空过）」。 */
static int st_nvs_get_u8f(const char *k, uint8_t *v, int *found)
{
    nvs_handle_t h;
    *v = 0;
    if (found) *found = 0;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return -1;
    esp_err_t e = nvs_get_u8(h, k, v);
    nvs_close(h);
    if (found && e == ESP_OK) *found = 1;
    if (e == ESP_ERR_NVS_NOT_FOUND) { *v = 0; return 0; }
    return (e == ESP_OK) ? 0 : -1;
}

static int st_popcount8(uint8_t v)
{
    int n = 0;
    while (v) { n += (v & 1); v >>= 1; }
    return n;
}

/* 逻辑序号（0..count-1，按物理槽升序）-> 物理槽号。
   越界 / 该序号没有对应的有效槽返回 -1。 */
static int st_idx2phys(int idx)
{
    if (idx < 0) return -1;
    for (int i = 0; i < (int)s_slots; i++) {
        if (!(s_alive & (1u << i))) continue;
        if (idx == 0) return i;
        idx--;
    }
    return -1;
}

/* 新图写入位置：优先「最后一个有效槽之后」的空位（等价于追加到末尾），
   末尾已满时才回填最早的空洞。只有回填时新图才不在逻辑末尾，所以
   store_save_frame 必须用 st_phys2idx() 反查真实序号，不能假定 count-1。 */
static int st_find_free(void)
{
    int last = -1;
    for (int i = 0; i < (int)s_slots; i++)
        if (s_alive & (1u << i)) last = i;
    for (int i = last + 1; i < (int)s_slots; i++)
        if (!(s_alive & (1u << i))) return i;
    for (int i = 0; i <= last; i++)
        if (!(s_alive & (1u << i))) return i;
    return -1;
}

/* 物理槽 -> 逻辑序号（按 alive 升序数第几个）。phys 未被置位返回 -1。 */
static int st_phys2idx(uint8_t alive, int phys)
{
    if (phys < 0 || !(alive & (1u << phys))) return -1;
    return st_popcount8((uint8_t)(alive & ((1u << phys) - 1u)));
}

int store_slot_phys(int idx)
{
    return st_idx2phys(idx);
}

/* ---------------- 初始化 ---------------- */

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
    s_lock = xSemaphoreCreateMutex();

    /* 元数据归一 + 槽位位图（R1.3.4）。alive 的 bit i = 物理槽 i 有效；
       逻辑序号 = alive 中第 N 个置位的槽（物理槽因此可以留空洞）。
       老固件只有 cnt 没有 alive 键：按「物理连续」生成 (1<<cnt)-1，与旧布局
       完全等价，升级零风险；两者不一致时以 alive 为准（它直接决定可读槽）。 */
    uint8_t c = 0, w = 0, av = 0;
    int found = 0;
    st_nvs_get_u8(KEY_COUNT, &c);
    st_nvs_get_u8(KEY_WIDX, &w);
    st_nvs_get_u8f(KEY_ALIVE, &av, &found);
    if (c > STORE_SLOT_MAX) { c = 0; st_nvs_set_u8(KEY_COUNT, c); }
    if (w >= STORE_SLOT_MAX) { w = 0; st_nvs_set_u8(KEY_WIDX, w); }

    uint8_t mask = (uint8_t)((s_slots >= 8) ? 0xFFu : ((1u << s_slots) - 1u));
    if (!found) {
        av = (uint8_t)(((1u << c) - 1u) & mask);
        st_nvs_set_u8(KEY_ALIVE, av);
        ESP_LOGI(TAG, "alive bitmap created from count=%u -> 0x%02X", c, av);
    }
    av &= mask;
    int pc = st_popcount8(av);
    if (pc != (int)c) {
        ESP_LOGW(TAG, "meta mismatch: count=%u alive=0x%02X -> fix count=%d",
                 c, av, pc);
        st_nvs_set_u8(KEY_COUNT, (uint8_t)pc);
    }
    s_alive = av;

    ESP_LOGI(TAG, "store: off=0x%06lx size=%lu KB, %lu slot(s) x %u KB, "
                  "count=%d alive=0x%02X widx=%u",
             (unsigned long)s_part->address, (unsigned long)(s_part->size / 1024),
             (unsigned long)s_slots, (unsigned)(STORE_SLOT_SZ / 1024),
             pc, (unsigned)av, w);
}

int store_slots(void)
{
    return (int)s_slots;
}

const esp_partition_t *store_part(void)
{
    return s_part;
}

/* ---------------- 元数据 ---------------- */

void store_meta_get(int *count, int *cur)
{
    uint8_t k = 0;
    st_nvs_get_u8(KEY_CUR, &k);
    /* R1.3.4：张数以 alive 位图为唯一真源，避免 cnt 与位图不一致时
       carousel_next() 的取模把 cur 带到不存在的槽。 */
    int c = st_popcount8(s_alive);
    if (k >= c) k = 0;
    if (count) *count = c;
    if (cur)   *cur = (int)k;
}

void store_meta_set(int count, int cur)
{
    /* R1.3.4：该接口现在只用于轮播推进（改 cur）。count 以 alive 位图为准，
       调用方传入的过期值不参与写入，避免把 NVS 的 cnt 写坏。 */
    int c = st_popcount8(s_alive);
    if (count != c) count = c;
    if (count < 0 || count > STORE_SLOT_MAX) return;
    if (count == 0) cur = 0;
    else if (cur < 0 || cur >= count) cur = 0;
    st_nvs_set_u8s(KEY_COUNT, (uint8_t)count, KEY_CUR, (uint8_t)cur, NULL, 0);
}

/* ---------------- 读写 ---------------- */

/* CRC-16/CCITT-FALSE（与 frame.c 相同契约：poly 0x1021, init 0xFFFF）。 */
static uint16_t st_crc16(const uint8_t *d, size_t n)
{
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < n; i++) {
        crc ^= (uint16_t)d[i] << 8;
        for (int b = 0; b < 8; b++)
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021)
                                 : (uint16_t)(crc << 1);
    }
    return crc;
}

/* 写载荷。from_flash=1 时源在 flash 映射区：spi_flash_write 会关 cache，
   源指针那一刻读不到，必须逐块拷进内部 RAM 再写。 */
static esp_err_t write_payload(uint32_t flash_off, const uint8_t *src,
                               uint32_t len, int from_flash)
{
    if (!from_flash)
        return esp_partition_write(s_part, flash_off, src, len);

    static uint8_t blk[4096];
    for (uint32_t done = 0; done < len; ) {
        uint32_t n = len - done;
        if (n > sizeof(blk)) n = sizeof(blk);
        memcpy(blk, src + done, n);
        esp_err_t e = esp_partition_write(s_part, flash_off + done, blk, n);
        if (e != ESP_OK) return e;
        done += n;
    }
    return ESP_OK;
}

/* 保存一帧：逻辑上追加到末尾（cur 指向新图），物理上优先写末尾之后的空位，
   末尾已满才回填最早的空洞（R1.3.4）。轮播满时拒绝（STORE_ERR_FULL），
   不覆盖已有图。count / cur / alive 一次 NVS commit。 */
static int save_frame_common(const uint8_t *hdr, uint32_t hdr_len,
                             const uint8_t *payload, uint32_t len,
                             const uint8_t *thumb, uint32_t tlen,
                             int payload_from_flash)
{
    if (!s_part || !s_lock) return -1;
    if (hdr_len != 16) return -1;
    if (len == 0 || len > STORE_FRAME_MAX) return -1;
    uint32_t thumb_extra = (thumb && tlen > 0 && tlen <= STORE_THUMB_JPEG_MAX)
                           ? 16u + tlen : 0u;
    if (hdr_len + len + thumb_extra > STORE_SLOT_SZ) return -1;

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(5000)) != pdTRUE) return -1;

    int cnt = st_popcount8(s_alive);
    if (cnt >= (int)s_slots) {
        xSemaphoreGive(s_lock);
        return STORE_ERR_FULL;      /* 已满：请先删除或清空 */
    }

    /* 逻辑上始终「追加到末尾」，物理上写到第一个空位——删除留下的空洞被
       原地复用，省掉整槽搬移（R1.3.4）。 */
    int slot = st_find_free();
    if (slot < 0) {
        xSemaphoreGive(s_lock);
        return STORE_ERR_FULL;
    }
    uint32_t off = (uint32_t)slot * STORE_SLOT_SZ;

    esp_err_t e = esp_partition_erase_range(s_part, off, STORE_SLOT_SZ);
    if (e == ESP_OK) e = esp_partition_write(s_part, off, hdr, hdr_len);
    if (e == ESP_OK) e = write_payload(off + hdr_len, payload, len,
                                       payload_from_flash);
    if (e == ESP_OK && thumb_extra)
        e = esp_partition_write(s_part, off + hdr_len + len, thumb,
                                thumb_extra);    /* 缩略头+缩略载荷整体 */

    if (e != ESP_OK) {
        ESP_LOGE(TAG, "slot %d write failed: %s", slot, esp_err_to_name(e));
        xSemaphoreGive(s_lock);
        return -1;
    }

    /* 一次 commit 写 count / cur / alive：掉电最多是「槽已写、位图未置」，
       此时该槽仍被当成空槽，下次上传覆盖它，不会污染逻辑序号。 */
    uint8_t nav = (uint8_t)(s_alive | (1u << slot));
    int ncnt = cnt + 1;
    int ncur = st_phys2idx(nav, slot);      /* 回填空洞时新图不在末尾 */
    if (ncur < 0) ncur = ncnt - 1;
    if (st_nvs_set_u8s(KEY_COUNT, (uint8_t)ncnt, KEY_CUR, (uint8_t)ncur,
                       KEY_ALIVE, nav) != 0) {
        xSemaphoreGive(s_lock);         /* 位图不置位：该槽保持「空」 */
        return -1;
    }
    s_alive = nav;

    xSemaphoreGive(s_lock);
    ESP_LOGI(TAG, "saved frame -> phys slot %d, logical %d (count=%d, alive=0x%02X)",
             slot, ncur, ncnt, (unsigned)nav);
    return ncur;            /* 返回逻辑序号，供调用方日志/显示 */
}

/* payload 在 RAM（页面 buffer、远程下载缓冲等老路径）。 */
int store_save_frame(const uint8_t *hdr, uint32_t hdr_len,
                     const uint8_t *payload, uint32_t len,
                     const uint8_t *thumb, uint32_t tlen)
{
    return save_frame_common(hdr, hdr_len, payload, len, thumb, tlen, 0);
}

/* payload 在 flash 映射区（R1.4.0 流式：帧不再驻留 RAM）。 */
int store_save_frame_from_flash(const uint8_t *hdr, uint32_t hdr_len,
                                const uint8_t *payload, uint32_t len,
                                const uint8_t *thumb, uint32_t tlen)
{
    return save_frame_common(hdr, hdr_len, payload, len, thumb, tlen, 1);
}

/* 删除逻辑序号 slot：只清 alive 里的一个 bit，不碰 flash、不搬移（R1.3.4）。
   物理槽内容原样留着当空洞，下次上传原地复用（写入前本来就要整槽擦）。
   cur 修正：被删槽在前则 cur--；正好删当前图则 cur 指向前移后的同位置。
   返回 STORE_DEL_*。 */
int store_delete_slot(int slot)
{
    if (!s_part || !s_lock) {
        ESP_LOGE(TAG, "delete: store 未初始化（分区或锁缺失）");
        return STORE_DEL_EBAD;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(5000)) != pdTRUE) {
        ESP_LOGW(TAG, "delete: 取锁超时（slot %d）", slot);
        return STORE_DEL_EBUSY;
    }

    int phys = st_idx2phys(slot);
    if (phys < 0) {
        ESP_LOGW(TAG, "delete: 逻辑槽 %d 不存在（alive=0x%02X）",
                 slot, (unsigned)s_alive);
        xSemaphoreGive(s_lock);
        return STORE_DEL_EBAD;
    }

    uint8_t cur = 0;
    st_nvs_get_u8(KEY_CUR, &cur);

    uint8_t nav = (uint8_t)(s_alive & ~(1u << phys));
    int nc = st_popcount8(nav);
    int ncur = (int)cur;
    if (slot < (int)cur) ncur = (int)cur - 1;
    else if (slot == (int)cur)
        ncur = (nc == 0) ? 0 : ((cur >= nc) ? (nc - 1) : (int)cur);
    if (ncur < 0 || ncur >= nc) ncur = 0;

    if (st_nvs_set_u8s(KEY_COUNT, (uint8_t)nc, KEY_CUR, (uint8_t)ncur,
                       KEY_ALIVE, nav) != 0) {
        ESP_LOGE(TAG, "delete: 元数据提交失败（逻辑 %d / 物理 %d）", slot, phys);
        xSemaphoreGive(s_lock);
        return STORE_DEL_EIO;
    }
    s_alive = nav;

    xSemaphoreGive(s_lock);
    ESP_LOGI(TAG, "deleted logical %d (phys %d) -> count=%d cur=%d alive=0x%02X",
             slot, phys, nc, ncur, (unsigned)nav);
    return STORE_DEL_OK;
}

/* 生成逻辑槽 slot 的缩略小帧：4x4 抽稀取众数色，位序与整帧（packIdx）同一契约：
   行自下而上、列右到左、字节内 MSB 优先。输出 16B 帧头 + 抽稀载荷，
   头内写实际几何（768x552→192x138，800x600→200x150）。
   内存友好：不整帧 malloc，按「缩略行」读 4 个源行缓冲（最大 4*200B），
   idx 抽稀图最大 200*150=30000B。每个失败点打 ERROR 日志便于定位。 */
int store_thumb_frame(int slot, uint8_t *out, uint32_t cap)
{
    if (!s_part || !s_lock) return -1;
    if (cap < STORE_THUMB_ENTRY) return -1;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(5000)) != pdTRUE) return -1;

    int phys = st_idx2phys(slot);          /* 逻辑序号 -> 物理槽（R1.3.4） */
    if (phys < 0) {
        xSemaphoreGive(s_lock);
        return -1;
    }
    uint32_t off = (uint32_t)phys * STORE_SLOT_SZ;
    uint8_t hdr[16];
    if (esp_partition_read(s_part, off, hdr, sizeof(hdr)) != ESP_OK) {
        ESP_LOGE(TAG, "thumb: slot %d header read failed", slot);
        xSemaphoreGive(s_lock);
        return -1;
    }
    if (hdr[0] != STORE_MAGIC0 || hdr[1] != STORE_MAGIC1) {
        ESP_LOGE(TAG, "thumb: slot %d bad magic (%02X %02X)",
                 slot, hdr[0], hdr[1]);
        xSemaphoreGive(s_lock);
        return -1;
    }
    uint32_t w = ((uint32_t)hdr[4] << 8) | hdr[5];
    uint32_t h = ((uint32_t)hdr[6] << 8) | hdr[7];
    uint32_t plen = ((uint32_t)hdr[8] << 24) | ((uint32_t)hdr[9] << 16) |
                    ((uint32_t)hdr[10] << 8) | hdr[11];
    /* 4x4 抽稀要求源几何能被 4 整除，且与载荷自洽 */
    if (!w || !h || (w & 3) || (h & 3) || plen != (w >> 2) * h) {
        ESP_LOGE(TAG, "thumb: slot %d bad geom %lux%lu plen=%lu", slot,
                 (unsigned long)w, (unsigned long)h, (unsigned long)plen);
        xSemaphoreGive(s_lock);
        return -1;
    }

    uint32_t tw = w >> 2, th = h >> 2;
    uint32_t tlen = (tw >> 2) * th;
    if (!tlen || tw > STORE_THUMB_W || th > STORE_THUMB_H || 16u + tlen > cap) {
        ESP_LOGE(TAG, "thumb: slot %d size overflow tw=%lu th=%lu tlen=%lu", slot,
                 (unsigned long)tw, (unsigned long)th, (unsigned long)tlen);
        xSemaphoreGive(s_lock);
        return -1;
    }

    uint32_t RB = w >> 2;
    uint8_t *rows = malloc(4u * RB);       /* 单缩略行的 4 个源行缓冲（≤800B） */
    uint8_t *idxp = malloc(tlen);          /* 抽稀索引 2bit/像素打包（≤7500B） */
    if (!rows || !idxp) {
        ESP_LOGE(TAG, "thumb: slot %d malloc fail rows=%lu idxp=%lu", slot,
                 (unsigned long)(4u * RB), (unsigned long)tlen);
        free(rows);
        free(idxp);
        xSemaphoreGive(s_lock);
        return -1;
    }
    memset(idxp, 0, tlen);

    /* 众数抽稀：每缩略行读 4 个源行，逐块统计代表色，写入 idxp 的 2bit 位 */
    for (uint32_t ty = 0; ty < th; ty++) {
        for (uint32_t dy = 0; dy < 4; dy++) {
            uint32_t y = ty * 4 + dy;
            uint32_t rowoff = off + 16 + (h - 1 - y) * RB;   /* 行自下而上契约 */
            if (esp_partition_read(s_part, rowoff, rows + dy * RB, RB) != ESP_OK) {
                ESP_LOGE(TAG, "thumb: slot %d row read failed @y=%lu", slot,
                         (unsigned long)y);
                free(rows);
                free(idxp);
                xSemaphoreGive(s_lock);
                return -1;
            }
        }
        for (uint32_t tx = 0; tx < tw; tx++) {
            uint32_t vote[4] = { 0, 0, 0, 0 };
            for (uint32_t dy = 0; dy < 4; dy++) {
                const uint8_t *row = rows + dy * RB;
                for (uint32_t dx = 0; dx < 4; dx++) {
                    uint32_t x = tx * 4 + dx;
                    uint8_t v = row[(w - 1 - x) >> 2];
                    vote[(v >> ((x & 3) * 2)) & 3]++;
                }
            }
            uint32_t best = 0;
            for (uint32_t k = 1; k < 4; k++)
                if (vote[k] > vote[best]) best = k;
            uint32_t pi = ty * tw + tx;
            idxp[pi >> 2] |= (uint8_t)(best << ((pi & 3) * 2));
        }
    }

    /* 按 packIdx 位序打包缩略帧载荷（行自下而上、列右到左、MSB 优先） */
    uint32_t TRB = tw >> 2;
    uint8_t *tpayload = out + 16;
    for (uint32_t r = 0; r < th; r++) {
        uint32_t srcrow = (th - 1 - r) * tw, bo = r * TRB;
        for (uint32_t xb = 0; xb < TRB; xb++) {
            uint32_t xa = tw - 4 - (xb << 2);
            uint8_t v = 0;
            for (uint32_t k = 0; k < 4; k++) {
                uint32_t pi = srcrow + xa + k;
                v |= (uint8_t)(((idxp[pi >> 2] >> ((pi & 3) * 2)) & 3) << (k * 2));
            }
            tpayload[bo + xb] = v;
        }
    }

    uint16_t crc = st_crc16(tpayload, tlen);
    out[0] = STORE_MAGIC0; out[1] = STORE_MAGIC1;
    out[2] = hdr[2];                        /* 帧格式版本沿用整帧 */
    out[3] = hdr[3];                        /* 面板类型沿用 */
    out[4] = (uint8_t)(tw >> 8); out[5] = (uint8_t)tw;
    out[6] = (uint8_t)(th >> 8); out[7] = (uint8_t)th;
    out[8]  = (uint8_t)(tlen >> 24); out[9]  = (uint8_t)(tlen >> 16);
    out[10] = (uint8_t)(tlen >> 8); out[11] = (uint8_t)tlen;
    out[12] = (uint8_t)(crc >> 8); out[13] = (uint8_t)crc;
    out[14] = 0; out[15] = 0;

    free(rows);
    free(idxp);
    xSemaphoreGive(s_lock);
    return (int)(16u + tlen);
}

int store_load_slot(int slot, uint8_t *buf, uint32_t cap)
{
    if (!s_part || !s_lock) return -1;
    if (slot < 0) return -1;
    if (cap < 16) return -1;

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(5000)) != pdTRUE) return -1;

    int phys = st_idx2phys(slot);          /* 逻辑序号 -> 物理槽（R1.3.4） */
    if (phys < 0) {
        xSemaphoreGive(s_lock);
        return -1;
    }
    uint32_t off = (uint32_t)phys * STORE_SLOT_SZ;
    uint8_t hdr[16];
    esp_err_t e = esp_partition_read(s_part, off, hdr, sizeof(hdr));
    int total = -1;

    if (e == ESP_OK && hdr[0] == STORE_MAGIC0 && hdr[1] == STORE_MAGIC1) {
        uint32_t len = ((uint32_t)hdr[8] << 24) | ((uint32_t)hdr[9] << 16) |
                       ((uint32_t)hdr[10] << 8) | hdr[11];
        if (len && len <= STORE_FRAME_MAX && 16u + len <= cap) {
            e = esp_partition_read(s_part, off + 16, buf + 16, len);
            if (e == ESP_OK) {
                memcpy(buf, hdr, 16);
                total = 16 + (int)len;
            }
        }
    }

    xSemaphoreGive(s_lock);
    if (total < 0) ESP_LOGW(TAG, "slot %d empty or bad (magic/len)", slot);
    return total;
}

/* 读出槽 slot 的预存缩略帧（R1.3.2：网页离线预生成，存于帧后槽尾）。
   布局：帧头(16) + 帧载荷(flen) + 缩略头(16) + 缩略载荷(tlen)。
   缩略头[2]：1=2bit 缩略（上限 STORE_THUMB_LEN），2=彩色 JPEG（上限
   STORE_THUMB_JPEG_MAX）。 */

void store_clear(void)
{
    if (st_nvs_set_u8s(KEY_COUNT, 0, KEY_CUR, 0, KEY_ALIVE, 0) != 0) {
        ESP_LOGE(TAG, "clear: 元数据写入失败");
        return;
    }
    s_alive = 0;
    ESP_LOGI(TAG, "carousel cleared (bitmap reset, slots left as-is)");
}
