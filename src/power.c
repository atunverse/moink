#include "power.h"
#include "epd_drv.h"
#include "netif_ap.h"     /* netif_shutdown_before_sleep() */
#include "settings.h"

#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_attr.h"
#include "esp_rom_sys.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <stdio.h>   /* snprintf：冷启动判据的诊断行 */

static const char *TAG = "power";

#define AUTO_WAKE_WINDOW_S 180   /* 定时唤醒后等人的窗口（秒） */

/* 电池分压 1M:1M => Vbat = Vpin * (1M+1M)/1M = Vpin * 2.0（比值与 100k:100k 相同）。
   ⚠️ 分压比是板级硬件事实：换板 / 改电阻必须同步改这里，否则电量整体偏移。
   ⚠️ 1M 高阻源（≈500k 输出阻抗）会让 ADC 读数偏低：ADC 端建议并联 100nF 到地，
      并在换板后按实测复核 BAT_FULLSCALE_MV。 */
#define BAT_DIV_NUM        200
#define BAT_DIV_DEN        100
#define BAT_ADC_MAX        4095
#define BAT_FULLSCALE_MV   3100   /* 12dB 满量程，按板实测标定（换分压后建议复核） */
/* 未连接判定：单节锂电物理范围 + 采样极差（见 power_battery_mv）。
   R1.3.4：改为「一次调用内多次采样」，见函数注释。 */
#define BAT_MV_MIN         2400
#define BAT_MV_MAX         4600
#define BAT_SAMPLES        12     /* 每次调用的采样点数（中位数抗单个坏点） */
#define BAT_SPREAD_MAX     500    /* mV：max-min 超过即判悬空（真实电池毫秒级不会跳这么多） */

static adc_oneshot_unit_handle_t s_adc;
static TickType_t s_last_activity;
static bool s_auto_wake = false;

/* R1.3.6 供电来源判定。RTC 内存跨深睡与软件复位存活、只有真断电才丢 ——
   正好用来区分「冷启动」与「运行中重启」。 */
#define LOCK_MAGIC        0x4D4F494EUL   /* "MOIN" */
/* 阈值 4.5 V：单节锂电满电 4.2 V，留 0.3 V 余量（4.6~4.8 V 的劣质电源也判得出）。
   电池带载通常 3.9~4.1 V，正常顶不到。 */
#define USB_MV_THRESHOLD  4500
#define USB_POLL_US       200000
#define USB_HITS_NEED     3              /* 连续 3 次（600 ms）才认，防单点噪声 */

RTC_DATA_ATTR static uint32_t s_lock_magic;
RTC_DATA_ATTR static uint8_t  s_lock_want;   /* 1 = 电池自锁，0 = USB 不自锁 */
static bool     s_usb_pwr = false;
static uint8_t  s_usb_hits;
static esp_timer_handle_t s_usb_timer;

/* R1.2.2：唤醒脚与电池 ADC 脚改为运行时从 settings_pins() 取。
   ADC 通道与引脚在 ESP32-C3 上固定绑定：GPIO0..4 = ADC1_CH0..CH4。 */
static uint8_t s_wake_pin = 5;
static adc_channel_t s_adc_ch = ADC_CHANNEL_0;

/* 电池 ADC：只用 ADC1（ADC2 与 WiFi 共用，不可用），通道随引脚。
   幂等 —— power_lock_boot() 可能在 power_init() 之前就要读电压。 */
static void power_adc_init(void)
{
    if (s_adc != NULL) return;

    const pin_cfg_t *p = settings_pins();
    s_adc_ch = (adc_channel_t)p->v[PIN_IDX_ADC];

    adc_oneshot_unit_init_cfg_t u = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&u, &s_adc));
    adc_oneshot_chan_cfg_t c = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
    ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, s_adc_ch, &c));
}

void power_init(void)
{
    const pin_cfg_t *p = settings_pins();
    s_wake_pin = p->v[PIN_IDX_WAKE];

    gpio_config_t btn = {
        .pin_bit_mask = 1ULL << s_wake_pin,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&btn));

    power_adc_init();

    ESP_LOGI(TAG, "wake btn GPIO%u, battery ADC GPIO%u (ADC1_CH%d)",
             s_wake_pin, p->v[PIN_IDX_ADC], (int)s_adc_ch);

    power_activity();
}

void power_activity(void)
{
    s_last_activity = xTaskGetTickCount();
}

void power_set_auto_wake(bool v) { s_auto_wake = v; }

uint32_t power_wakeup_causes(void)
{
    return esp_sleep_get_wakeup_causes();
}

bool power_should_sleep(void)
{
    const moink_settings_t *s = settings_get();
    uint32_t limit = s->sleep_s;

    if (s_auto_wake) {
        /* 定时醒来：用短窗口等人，除非用户设了更短的空闲超时。 */
        if (limit == 0 || limit > AUTO_WAKE_WINDOW_S) limit = AUTO_WAKE_WINDOW_S;
    }
    if (limit == 0) return false;

    TickType_t idle = xTaskGetTickCount() - s_last_activity;
    return idle >= pdMS_TO_TICKS(limit * 1000);
}

void power_enter_deep_sleep(void)
{
    netif_shutdown_before_sleep();   /* 先撤 NAPT，再停 WiFi */
    esp_wifi_stop();
    epd_panel_deep_sleep();

    /* 唤醒键：内部上拉、按钮接 GND，低电平唤醒（RTC 域 GPIO0..5）。 */
    gpio_pullup_en((gpio_num_t)s_wake_pin);
    gpio_pulldown_dis((gpio_num_t)s_wake_pin);
    gpio_set_direction((gpio_num_t)s_wake_pin, GPIO_MODE_INPUT);
    ESP_ERROR_CHECK(esp_sleep_enable_gpio_wakeup_on_hp_periph_powerdown(
        1ULL << s_wake_pin, ESP_GPIO_WAKEUP_GPIO_LOW));

    /* 自锁脚：按当前电源状态锁存电平（R1.3.6）。
       USB 供电（未自锁）时必须锁「低」—— 若照旧无条件锁高，深睡期间插着线就会
       一直 5 V 倒灌电池，而芯片睡着时没有能力发现（C3 的 ULP 访问不到 SAR ADC）。 */
    gpio_hold_dis((gpio_num_t)PIN_SELF_LOCK);
    gpio_set_direction((gpio_num_t)PIN_SELF_LOCK, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)PIN_SELF_LOCK, s_lock_want ? 1 : 0);
    gpio_hold_en((gpio_num_t)PIN_SELF_LOCK);
    gpio_deep_sleep_hold_en();

    /* 超时动作 = 关机时不设定时唤醒：无自锁电路会退回深睡（见
       power_self_lock_off），若仍按 wake_s 挂定时器，「关机」会变成
       「定时开机」。只有「休眠」动作才需要定时唤醒。 */
    uint32_t wake_s = (settings_get()->timeout_action == SETT_ACTION_SLEEP)
                      ? settings_get()->wake_s : 0;
    if (wake_s > 0) {
        esp_sleep_enable_timer_wakeup((uint64_t)wake_s * 1000000ULL);
    }

    ESP_LOGI(TAG, "deep sleep (btn GPIO%u low, timer %lus, self-lock GPIO%d held=%d)",
             s_wake_pin, (unsigned long)wake_s, PIN_SELF_LOCK, s_lock_want ? 1 : 0);
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_deep_sleep_start();
}

void power_self_lock_off(void)
{
    ESP_LOGW(TAG, "timeout action = off: release self-lock GPIO%d", PIN_SELF_LOCK);

    /* 自锁 = MOS 一键开机：GPIO2 输出高 → MOS 导通维持供电，拉低即断电。
       有自锁电路时约 100 ms 内失电，下面的代码不会执行到。
       深睡唤醒后 hold 可能仍生效，必须先解除，否则 set_level 静默无效。 */
    gpio_hold_dis((gpio_num_t)PIN_SELF_LOCK);
    gpio_set_direction((gpio_num_t)PIN_SELF_LOCK, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)PIN_SELF_LOCK, 0);
    s_lock_want = 0;
    s_usb_pwr   = true;

    /* 无自锁电路（USB 供电 / 未装 MOS）时拉低无效：1 s 后退回深睡，
       避免设备一直空转耗电（此时 hold 会锁住低电平，MOS 若存在仍保持关断）。 */
    vTaskDelay(pdMS_TO_TICKS(1000));
    ESP_LOGW(TAG, "self-lock low did not cut power (no self-lock circuit?), "
                  "fallback to deep sleep");
    power_enter_deep_sleep();
}

/* ★ 2026-11-17：软重启绝不能再用 esp_restart()。
   系统复位会把数字域整体复位，自锁脚 GPIO2 的输出寄存器清零 → MOS 断开 →
   电池供电的设备当场失电，"重启"变成"关机"，自锁自然也就没了（表现为
   「网页点应用并重启后设备关机」）。
   深睡时 pad 电平由 LP 域保持，因此用「锁存自锁电平 + 深睡 + 定时唤醒」模拟
   一次复位：唤醒后 reset reason = DEEPSLEEP、RTC 内存里的 s_lock_want 完好，
   power_lock_boot() 走深睡分支，自锁不丢，其余初始化与冷启动完全一致。 */
void power_restart(void)
{
    ESP_LOGW(TAG, "soft restart via deep sleep (self_lock=%d)", s_lock_want);

    /* 其他唤醒源先清掉：按键 GPIO 唤醒若还挂着，理论上不会触发（键没按），
       但复位语义上应当干净。 */
    esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);

    /* 顺序同 power_enter_deep_sleep：先写电平，再 hold。 */
    gpio_hold_dis((gpio_num_t)PIN_SELF_LOCK);
    gpio_set_direction((gpio_num_t)PIN_SELF_LOCK, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)PIN_SELF_LOCK, s_lock_want ? 1 : 0);
    gpio_hold_en((gpio_num_t)PIN_SELF_LOCK);
    gpio_deep_sleep_hold_en();

    esp_sleep_enable_timer_wakeup(100ULL * 1000);   /* 100 ms 后醒来 = 重启 */
    vTaskDelay(pdMS_TO_TICKS(60));                  /* 等日志与 HTTP 应答发完 */
    esp_deep_sleep_start();
}

int power_battery_mv(void)
{
    /* R1.3.4（FB-019）：**一次调用内完成全部采样**。
       旧实现要求「跨请求连续 3 次有效」才返回数值，而 /api/info 每次只调本函数一次、
       控制页又只在打开时请求一次 ⇒ 计数器永远到不了 3，首次打开必显示「未连接」，
       必须手动刷新数次才偶发出值（实测复现）。
       新做法：
       1. 连采 BAT_SAMPLES 次，取**中位数**（单个坏点不影响结果）；
       2. 用**极差 max-min** 判悬空：ADC 悬空时读数靠杂散耦合乱漂
          （实测 3.2/3.3/17.6V 交替），极差远大于真实电池；
       3. 中位数越界或极差超限 → 返回 -1（页面显示「未连接」）。
       这样单次 /api/info 即可出稳定电压，页面无需轮询
       （轮询会让 power_activity() 不断续命、永不休眠）。 */
    int v[BAT_SAMPLES];
    int n = 0;

    for (int i = 0; i < BAT_SAMPLES; i++) {
        int raw = 0;
        if (adc_oneshot_read(s_adc, s_adc_ch, &raw) != ESP_OK) continue;
        /* 注意乘法顺序：先除再乘，避免 raw*3100*200 溢出 int */
        v[n++] = raw * BAT_FULLSCALE_MV / BAT_ADC_MAX * BAT_DIV_NUM / BAT_DIV_DEN;
    }
    if (n < 3) return -1;

    /* 插入排序（最多 12 个元素），取中位数与极差 */
    for (int i = 1; i < n; i++) {
        int t = v[i], j = i - 1;
        while (j >= 0 && v[j] > t) { v[j + 1] = v[j]; j--; }
        v[j + 1] = t;
    }
    int med = v[n / 2];
    int spread = v[n - 1] - v[0];

    if (med < BAT_MV_MIN || med > BAT_MV_MAX) return -1;
    if (spread > BAT_SPREAD_MAX) return -1;
    return med;
}


/* ---------------- R1.3.6 供电来源判定 ---------------- */

void power_lock_gpio_init(void)
{
    /* ★ 2026-11-17：运行中软重启（深睡 / OTA / 恢复出厂）时，自锁脚可能正被
       hold 锁在高电平维持供电。此刻绝不能拉低 —— 电池供电会当场掉电。
       原样保留，交给 power_lock_boot() 统一收尾；冷启动时 magic 无效，
       照旧先断开、等判据。 */
    if (s_lock_magic == LOCK_MAGIC) return;

    gpio_config_t c = {
        .pin_bit_mask = 1ULL << PIN_SELF_LOCK,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&c);
    gpio_set_level((gpio_num_t)PIN_SELF_LOCK, 0);   /* 先断开，等判据 */
}

bool power_lock_boot(void)
{
    esp_reset_reason_t rr = esp_reset_reason();
    bool fresh = (s_lock_magic != LOCK_MAGIC);
    s_lock_magic = LOCK_MAGIC;

    /* 深睡唤醒：hold 仍锁存着上次的电平，动它会直接改供电状态。 */
    if (!fresh && rr == ESP_RST_DEEPSLEEP) {
        s_usb_pwr = (s_lock_want == 0);
        /* ★ 2026-11-17 顺序修正：hold 生效期间写输出寄存器对外无效，因此必须
           「设方向 → 写电平 → 最后解除 hold」。反过来会有一瞬由已复位为 0 的
           输出寄存器驱动 pad，电池供电当场掉电。 */
        gpio_set_direction((gpio_num_t)PIN_SELF_LOCK, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)PIN_SELF_LOCK, s_lock_want ? 1 : 0);
        gpio_hold_dis((gpio_num_t)PIN_SELF_LOCK);
        gpio_deep_sleep_hold_dis();
        return s_lock_want != 0;
    }
    /* 软件复位 / WDT / OTA：设备本来就在跑，按键是松的，不能用按键判据。 */
    if (!fresh) {
        s_usb_pwr = (s_lock_want == 0);
        /* ★ 2026-11-17：先写电平再解除 hold（理由同深睡分支）。 */
        gpio_set_direction((gpio_num_t)PIN_SELF_LOCK, GPIO_MODE_OUTPUT);
        gpio_set_level((gpio_num_t)PIN_SELF_LOCK, s_lock_want ? 1 : 0);
        gpio_hold_dis((gpio_num_t)PIN_SELF_LOCK);
        return s_lock_want != 0;
    }

    /* ---- 真冷启动：只认按键，不看电压 ----
       电池能到达 VSYS 的唯一路径是「按键按住」，USB 上电则没人按键
       ⇒ 按键已松，必然意味着有另一路电源 ⇒ 不自锁。
       只可能漏判成「开机失败」（按太短 / 接法选错），不会误判成「意外掉电」。
       冷启动刻意不读 ADC：刷机后用户还没选接法，固件既不知道用哪个唤醒脚、
       也不知道分压接在哪一侧，拿电压猜就等于主动自锁倒灌。 */
    /* ★★ 2026-11-17：按键脚不能只认设置里那一个。
       刚刷完机 / 恢复出厂时 GPIO 预设是「默认」（唤醒 = GPIO5），而排线与
       整合板的电源键接在 GPIO1 —— 只读设置值必然读到悬空高电平，于是判成
       「USB 上电」→ 不自锁 → 松开按键即断电（表现为「必须一直按住」）。
       既然硬件只有三种固定接法，这里就把「设置值 + 两种硬件固定值」都当候选，
       任一为低即认定按键按住。误判的代价是「USB 带电池时多导通 200 ms」，
       由 idle_monitor 的 ADC 轮询发现 5 V 后立即释放，远小于开不了机的代价。 */
    static const uint8_t EXTRA_KEY[] = { 5, 1 };   /* 默认档 / 排线·整合板 */

    uint8_t cand[4];
    int nc = 0;
    cand[nc++] = settings_pins()->v[PIN_IDX_WAKE];
    for (size_t i = 0; i < sizeof(EXTRA_KEY); i++) {
        bool dup = false;
        for (int k = 0; k < nc; k++)
            if (cand[k] == EXTRA_KEY[i]) dup = true;
        if (!dup && nc < (int)sizeof(cand)) cand[nc++] = EXTRA_KEY[i];
    }

    for (int i = 0; i < nc; i++) {
        gpio_config_t btn = {
            .pin_bit_mask = 1ULL << cand[i],
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        gpio_config(&btn);
    }
    esp_rom_delay_us(2000);   /* 等内部上拉把脚位拉稳 */

    /* 上电瞬间 VSYS 与引脚都在爬升，单次采样容易读到假高：
       20 ms 窗口内连采 20 次（1 ms 间隔），任一脚任一次为低即认按下。 */
    bool pressed = false;
    int lv[4] = { 1, 1, 1, 1 };
    for (int t = 0; t < 20 && !pressed; t++) {
        for (int i = 0; i < nc; i++) {
            if (gpio_get_level((gpio_num_t)cand[i]) == 0) {
                lv[i] = 0;
                pressed = true;
            }
        }
        if (!pressed) esp_rom_delay_us(1000);
    }

    /* 用 LOGE 打：生产日志级别是 ERROR，LOGI 会被裁掉 */
    char list[48];
    int off = 0;
    list[0] = '\0';
    for (int i = 0; i < nc && off < (int)sizeof(list) - 12; i++)
        off += snprintf(list + off, sizeof(list) - (size_t)off,
                        " G%u=%d", (unsigned)cand[i], lv[i]);
    ESP_LOGE(TAG, "[pwr] cold key:%s pressed=%d", list, (int)pressed);
    s_lock_want = pressed ? 1 : 0;
    s_usb_pwr   = !pressed;
    gpio_set_level((gpio_num_t)PIN_SELF_LOCK, pressed ? 1 : 0);
    return pressed;
}

void power_lock_release(void)
{
    if (s_lock_want == 0) return;
    gpio_hold_dis((gpio_num_t)PIN_SELF_LOCK);
    gpio_set_direction((gpio_num_t)PIN_SELF_LOCK, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)PIN_SELF_LOCK, 0);
    s_lock_want = 0;
    s_usb_pwr   = true;
}

bool power_self_locked(void) { return s_lock_want != 0; }
bool power_usb_powered(void) { return s_usb_pwr; }

int power_vsys_mv(void)
{
    if (s_adc == NULL) return -1;
    int raw = 0;
    if (adc_oneshot_read(s_adc, s_adc_ch, &raw) != ESP_OK) return -1;
    /* 乘法顺序同 power_battery_mv：先除再乘，避免 raw*3100*200 溢出 int */
    return raw * BAT_FULLSCALE_MV / BAT_ADC_MAX * BAT_DIV_NUM / BAT_DIV_DEN;
}

/* 只在自锁态（电池供电）才需要查：不自锁时电池已隔离，读了也没意义。
   ★ 2026-11-17：只服务 FPC 老排线 —— 定时器也只在那一档才会创建（见
   power_usb_monitor_start）。老排线没有硬件反向阻断，插入 5 V 只能靠 ADC
   发现后主动释放自锁，否则会倒灌电池；整合板 / 新排线（CH213K）硬件已处理，
   默认档没有自锁电路，都不进这里。
   连续 USB_HITS_NEED 次超阈值才释放：阈值与满电只差 0.3 V，单点噪声需去抖。 */
static void usb_poll_cb(void *arg)
{
    (void)arg;

    if (s_lock_want == 0) {
        s_usb_hits = 0;
        return;
    }

    const moink_settings_t *st = settings_get();
    /* ★ 2026-11-17：只有 FPC 老排线才检测，其余硬件一律跳过。 */
    if (!(st->gpio_preset == GPIO_PRESET_LINE && st->line_ver == LINE_VER_OLD)) {
        s_usb_hits = 0;
        return;
    }

    int mv = power_vsys_mv();
    if (mv < 0) return;

    if (mv > USB_MV_THRESHOLD) {
        if (++s_usb_hits >= USB_HITS_NEED) {
            s_usb_hits = 0;
            power_lock_release();
            /* 日志级别被压到 ERROR，这里用 LOGE 才看得见。 */
            ESP_LOGE(TAG, "[pwr] USB %d mV, release self-lock", mv);
        }
    } else {
        s_usb_hits = 0;
    }
}

void power_usb_monitor_start(void)
{
    if (s_usb_timer != NULL) return;

    /* ★ 2026-11-17：只有 FPC 老排线需要运行时 200 ms 的 USB 检测。
       其余硬件连定时器都不建 —— 不轮询就没有 200 ms 周期唤醒：
         · 默认档：没有自锁电路，判了也没用
         · 整合板：电源通路在硬件侧处理
         · FPC 新排线（CH213K）：已反向阻断，且 ADC 接 VSYS，插线读到 5 V 后
           照旧轮询会在 600 ms 内把电池通路切掉（拔线即断电） */
    const moink_settings_t *st = settings_get();
    if (!(st->gpio_preset == GPIO_PRESET_LINE && st->line_ver == LINE_VER_OLD)) {
        ESP_LOGW(TAG, "[pwr] usb poll off (preset=%u line_ver=%u)",
                 (unsigned)st->gpio_preset, (unsigned)st->line_ver);
        return;
    }

    esp_timer_create_args_t a = {
        .callback = usb_poll_cb,
        .name     = "usb_poll",
    };
    if (esp_timer_create(&a, &s_usb_timer) != ESP_OK) {
        ESP_LOGE(TAG, "[pwr] usb timer create failed");
        return;
    }
    esp_timer_start_periodic(s_usb_timer, USB_POLL_US);
}
