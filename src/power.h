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

/* 电池电压 mV 粗测（分压 470k:100k；满量程需按板实测标定）。 */
int power_battery_mv(void);

#endif /* MOINK_POWER_H */
