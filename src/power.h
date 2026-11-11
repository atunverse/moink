#ifndef MOINK_POWER_H
#define MOINK_POWER_H

#include <stdint.h>
#include <stdbool.h>

/*
 * 电源管理：电池 ADC 粗测、深睡 / 唤醒源、空闲休眠判定。
 *
 * 休眠策略：
 *   - sleep_s = 空闲无活动后深睡的超时（0 = 不休眠）。
 *   - wake_s  = 定时自动唤醒间隔（0 = 关闭）。
 *   - 定时唤醒后进入「等人的窗口」：默认 AUTO_WAKE_WINDOW_S 秒内若无活动则回睡，
 *     有上传活动则按正常 sleep_s 续命。
 */

/* 配置唤醒键输入 + 电池 ADC。 */
void power_init(void);

/* 重置空闲计时（任何上传 / 请求都调用）。 */
void power_activity(void);

/* 本次是否为定时器唤醒（决定是否套用短窗口）。 */
void power_set_auto_wake(bool v);
bool power_auto_wake(void);

/* 当前唤醒原因位图（esp_sleep_get_wakeup_causes()）。 */
uint32_t power_wakeup_causes(void);

/* 空闲是否已超时，应进入深睡。 */
bool power_should_sleep(void);

/* 设唤醒源并进入深睡（不返回）。 */
void power_enter_deep_sleep(void);

/* R1.3.3：超时动作 = 关机 —— 释放自锁脚（GPIO2 拉低）让 MOS 断电，正常不返回。
   无自锁电路时拉低无效，1 s 后退回深睡，避免设备空转。 */
void power_self_lock_off(void);

/* 电池电压 mV 粗测（分压 1M:1M，×2.0；满量程需按板实测标定）。 */
int power_battery_mv(void);

/* ---------------- R1.3.6 供电来源判定（USB 5V 防倒灌电池） ----------------
 *
 * 背景：排线板上电池经背靠背 AO3401 接 VSYS，栅极由 GPIO2 驱动（高 = 导通）。
 *       插 USB 时若自锁导通，5 V 会直接压在电芯上（3~4 A，无 CC/CV）。
 *       详见 docs/方案-USB供电防倒灌-自锁门控.md
 *
 * 判据：
 *   冷启动 —— 只认按键：电池到 VSYS 的唯一路径是「按住按键」，USB 上电没人按键
 *             ⇒ 按键已松即判 USB，不自锁。不读电压（不猜板型，未配置时也安全）。
 *   运行中 —— 仅自锁态每 200 ms 采一次，连续 3 次 > 4500 mV 即释放自锁。
 *             USB 开机本就不自锁，不采样。
 *   新排线 —— gpio_preset = 排线 且 line_ver = NEW 时轮询整段跳过：CH213K 已做
 *             反向阻断，而其 ADC 接 VSYS，插线会读到 5 V，轮询反而会误断电池。
 *   复位   —— RTC_DATA_ATTR 记自锁意图，区分冷启动 / 深睡唤醒 / 软复位-WDT-OTA。
 */

/* app_main 最前面：把自锁脚定成输出低（不导通），等判据决定。 */
void power_lock_gpio_init(void);

/* 读出上电来源并决定是否导通自锁；返回 true = 已自锁（电池供电）。
   必须在 nvs_flash_init() + settings_init() 之后调用（要读运行时唤醒脚）。 */
bool power_lock_boot(void);

/* 释放自锁（切断电池通路，改由 USB 供电）。可重入。 */
void power_lock_release(void);

/* 当前是否处于自锁（电池供电）状态。 */
bool power_self_locked(void);

/* 当前是否判定为 USB 供电。 */
bool power_usb_powered(void);

/* 原始读数（不做 4600 mV 上限过滤，USB 时能读到 ~5000）。仅供运行期轮询使用。 */
int power_vsys_mv(void);

/* 启动 200 ms 轮询（内部按板型/排线版本决定是否真的采样）。 */
void power_usb_monitor_start(void);

#endif /* MOINK_POWER_H */
