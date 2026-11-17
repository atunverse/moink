/* ==================================================================
   60-device.js —— 设备信息 / 电源 / 热点 / 联网 / 远程 / 屏幕 / GPIO
   ================================================================== */
/* ---------- 设备信息 / 设置 ----------
   视图切换（创作 ↔ 设备）由 50-ui.js 的 showView 负责，这里只留数据侧。 */

/* R1.2.0（FB-015）：统一版本号。ver = 当前生效页面版本（热更页优先，否则等于
   固件编译号）；fw = 固件编译号，仅用于判断热更控制页是否落后于固件。
   R 号按 主*10000 + 次*100 + 修订 折算成整数比较。 */
var DEV_FW = "";
function verNum(v){
  var m = /(\d+)\.(\d+)\.(\d+)/.exec(v || "");
  return m ? (+m[1] * 10000 + +m[2] * 100 + +m[3]) : 0;
}
function refreshInfo(){
  fetch(api("/api/info")).then(function(r){ return r.json(); }).then(function(j){
    var ver = j.ver || j.fw || "";
    DEV_FW = j.fw || "";
    var el = $("i-verD");
    el.textContent = ver || "—";
    if (DEV_FW && verNum(ver) < verNum(DEV_FW)){
      el.style.color = "var(--err)";
      el.title = "控制页版本低于固件（" + ver + " < " + DEV_FW + "），建议重新上传固件";
    } else {
      el.style.color = "";
      el.title = (DEV_FW && verNum(ver) > verNum(DEV_FW))
        ? "控制页已单独热更（固件 " + DEV_FW + "）" : "";
    }
    $("i-apiD").textContent = j.api != null ? j.api : "—";
    if (j.api != null) DEV_API = +j.api || 1;
    $("i-panel").textContent = j.panel || "—";
    $("i-ssid").textContent = j.ssid || "—";
    $("i-heap").textContent = j.heap != null ? (j.heap/1024).toFixed(0) + " KB" : "—";
    $("i-bat").textContent = (j.bat_mv > 0) ? (j.bat_mv/1000).toFixed(2) + " V" : "未连接";
    $("i-clients").textContent = j.clients != null ? j.clients : "—";
    var wakeTxt = { button: "按键", timer: "定时", power_on: "上电/复位", other: "其他" };
    $("i-wake").textContent = j.wake_reason ? (wakeTxt[j.wake_reason] || j.wake_reason) : "—";
    $("i-wake").title = (j.wake_bits != null) ? ("唤醒位图 0x" + (+j.wake_bits).toString(16)) : "";
    var ok = (j.ssid != null);
    $("conn").textContent = ok ? ("已连接 · " + j.ssid) : "未连接";
    $("conn").classList.toggle("ok", ok);
    if (j.panel) PANEL.name = j.panel;
    if (j.panel === "A1") PANEL.id = 1; else PANEL.id = 0;
    if (applyPanelGeom(PANEL.id)) onGeomChanged();
  }).catch(function(){ $("conn").textContent = LOCAL_PREVIEW ? "本地预览" : "未连接"; });
}
function syncPowerUI(){
  /* 超时动作 = 关机时没有「自动唤醒 / 唤醒后切图」这两项。 */
  /* 「不超时」⇔ sleep_s = 0：超时动作、自动唤醒都没有意义，整块藏掉 */
  var never = ($("sleepSel").value === "0");
  $("actionRow").style.display = never ? "none" : "";
  var off = ($("actionSel").value === "1");
  $("sleepOpts").style.display = (never || off) ? "none" : "";
}
function loadSettings(){
  fetch(api("/api/settings")).then(function(r){ return r.json(); }).then(function(s){
    $("sleepSel").value = String(s.sleep_s);
    $("actionSel").value = String(s.timeout_action == null ? 0 : s.timeout_action);
    $("wakeSel").value = String(s.wake_s);
    $("wakeShow").checked = (s.wake_show == null) ? true : !!s.wake_show;  /* 默认开启 */
    $("lineNew").checked = !!s.line_v;   /* R1.3.6：默认老排线（未勾选） */
    syncPowerUI();
    $("apSsid").value = s.ssid || "";
    $("apPass").placeholder = s.pass_set ? "已设置（留空 = 保持当前密码）" : "留空 = 开放热点";
    $("apClearRow").style.display = s.pass_set ? "" : "none";
    $("apClearPw").checked = false;
    $("panelSel").value = String(s.panel);
    $("wifiPwrSel").value = String(s.wifi_pwr == null ? 2 : s.wifi_pwr);
    loadGpio(s);
    if (applyPanelGeom(+s.panel)) onGeomChanged();
    $("vrot").checked = !!cfg.vrot;   /* R1.4.0-3：页面本地偏好，不写设备 */
  }).catch(function(){});
  loadNet();          /* R1.3.5：联网状态与上游 WiFi 列表 */
  loadRemote();       /* R1.4.0：远程图槽 */
  readSettings(function(s){
    if (!s) return;
    $("rMode").value = String(s.r_mode == null ? 0 : s.r_mode);
    $("rUrl").value  = s.r_url || "";
    $("rUser").value = s.r_user || "";
    $("rPass").placeholder = s.r_pass_set ? "已设置（留空 = 保持当前密码）" : "留空 = 无密码";
    $("rPass").value = "";
  });
}

/* ---------- 联网（R1.3.5）----------
   只在打开设置 / 用户操作后请求，**不做定时轮询**：/api/net 会调 power_activity()，
   轮询会让设备永远不休眠（与电池电压那条是同一个坑）。 */
function netBody(o){
  return Object.keys(o).map(function(k){
    return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]);
  }).join("&");
}
function loadNet(){
  fetch(api("/api/net")).then(function(r){ return r.ok ? r.json() : null; })
    .then(function(n){
      if (!n) return;
      $("netOn").checked = !!n.on;
      $("naptOn").checked = !!n.napt_on;
      var st = $("netState");
      if (n.connected){
        st.textContent = "已连上 " + n.ssid + " · " + n.ip +
                         (n.rssi ? " · " + n.rssi + " dBm" : "") +
                         (n.napt ? " · 转发中" : "");
        st.style.color = "var(--ok)";
      } else if (!n.on){
        st.textContent = n.count ? "未启用" : "还没有保存任何网络";
        st.style.color = "var(--mut)";
      } else if (n.trying >= 0){
        st.textContent = "正在连接第 " + (n.trying + 1) + " 个网络…";
        st.style.color = "var(--acc)";
      } else {
        st.textContent = n.count ? "未连接，后台重试中" : "没有可用的网络";
        st.style.color = "var(--err)";
      }
      var box = $("wifiList");
      box.innerHTML = "";
      (n.list || []).forEach(function(w, i){
        var row = document.createElement("div");
        row.className = "wifiItem";
        var nm = document.createElement("span");
        nm.className = "n";
        nm.textContent = w.ssid + (w.has_pass ? "" : "（开放）");
        row.appendChild(nm);
        if (n.connected && w.ssid === n.ssid){
          var t = document.createElement("span");
          t.className = "tag2"; t.textContent = "已连接";
          row.appendChild(t);
        }
        var del = document.createElement("button");
        del.className = "del"; del.textContent = "删除";
        del.onclick = function(){ postNet({action: "del", idx: i}, "wifimsg"); };
        row.appendChild(del);
        box.appendChild(row);
      });
    })
    .catch(function(){ /* 旧固件没有 /api/net：静默跳过 */ });
}
function postNet(o, msgId){
  var el = $(msgId);
  if (el) saveState(msgId, "", "保存中…");
  fetch(api("/api/net"), {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: netBody(o)
  }).then(function(r){
    return r.text().then(function(t){ return {ok: r.ok, status: r.status, text: t}; });
  }).then(function(x){
    if (!x.ok) throw new Error(x.text || ("HTTP " + x.status));
    if (el) saveState(msgId, "ok", "✓ 已保存");
    setTimeout(loadNet, 500);
  }).catch(function(e){
    if (el) saveState(msgId, "err", "✗ " + (e.message || "失败"));
  });
}
/* 扫描附近 WiFi（R1.3.5）：点一次扫一次，**绝不定时扫** —— 扫描要把射频从热点
   信道挪到别的信道，连着的手机手会卡 1~2 秒，反复扫等于把热点打断。 */
function scanAp(){
  var box = $("scanList"), btn = $("wifiScan");
  btn.disabled = true;
  box.innerHTML = "";
  saveState("scanfmsg", "", "扫描中…（约 2 秒）");
  fetch(api("/api/scan"))
    .then(function(r){
      return r.text().then(function(t){ return {ok: r.ok, status: r.status, text: t}; });
    })
    .then(function(x){
      if (!x.ok) throw new Error(x.text || ("HTTP " + x.status));
      var d = JSON.parse(x.text), list = d.list || [];
      if (!list.length){ saveState("scanfmsg", "", "没扫到，靠近路由器再试"); return; }
      saveState("scanfmsg", "ok", "✓ " + list.length + " 个");
      list.forEach(function(a){
        var row = document.createElement("div");
        row.className = "scanItem";
        var nm = document.createElement("span");
        nm.className = "n"; nm.textContent = a.ssid;
        row.appendChild(nm);
        var bar = document.createElement("span");
        bar.className = "bar"; bar.textContent = a.rssi + " dBm";
        row.appendChild(bar);
        var lk = document.createElement("span");
        lk.className = "lk"; lk.textContent = a.lock ? "加密" : "开放";
        row.appendChild(lk);
        row.onclick = function(){
          $("staSsid").value = a.ssid;
          box.innerHTML = "";
          if (a.lock){
            $("staPass").placeholder = "输入该 WiFi 的密码";
            $("staPass").focus();
          }else{
            $("staPass").value = "";
            $("staPass").placeholder = "开放网络，密码留空";
            $("wifiAdd").focus();
          }
          saveState("scanfmsg", "ok", "已填入名称");
        };
        box.appendChild(row);
      });
    })
    .catch(function(e){
      saveState("scanfmsg", "err", "✗ " + (e.message || "扫描失败"));
    })
    .then(function(){ btn.disabled = false; });
}
function initNetUI(){
  $("wifiScan").onclick = scanAp;
  $("wifiAdd").onclick = function(){
    var ssid = $("staSsid").value.trim();
    if (!ssid){ saveState("wifimsg", "err", "✗ 请填 WiFi 名称"); return; }
    postNet({action: "add", ssid: ssid, pass: $("staPass").value}, "wifimsg");
    $("staSsid").value = ""; $("staPass").value = "";
  };
  $("netOn").onchange  = function(){ postNet({on: $("netOn").checked ? 1 : 0}, "wifimsg"); };
  $("naptOn").onchange = function(){ postNet({napt: $("naptOn").checked ? 1 : 0}, "wifimsg"); };
  $("netRefresh").onclick = loadNet;
}
/* ---------- 设置就地保存状态（R1.1.3，FB-014）----------
   背景：全局提示 #msg 挂在「图片」标签页里，切到「设备」标签页保存设置时写进去的
   提示是看不见的 —— 连保存失败都是静默的。现在每条设置都在自己的按钮后就地反馈：
   保存中 / ✓ 已保存并生效 / ✗ 未生效 / ✗ 失败原因。
   并且不轻信 "HTTP 200"：保存后回读 /api/settings 逐字段核对，确认真落进了设备。
   热点改名会立刻踢掉客户端（应答可能收不到），所以回读带重试。 */
var SETT_LABEL = { panel:"屏幕", gpio_preset:"GPIO 接法",
                   wifi_pwr:"WiFi 功率", sleep_s:"超时", timeout_action:"超时动作",
                   wake_s:"自动唤醒", wake_show:"唤醒后切图", line_v:"排线版本",
                   ssid:"热点名", pass:"热点密码" };
function saveState(id, kind, text){
  var el = id ? $(id) : null; if (!el) return;
  el.textContent = text || "";
  el.className = "savestate " + (kind || "");
  if (el._t){ clearTimeout(el._t); el._t = null; }
  if (kind === "ok"){    /* 成功 8 秒后自动淡出；失败 / 待核对常驻，直到下次操作 */
    el._t = setTimeout(function(){ el.textContent = ""; el.className = "savestate"; }, 8000);
  }
}
function readSettings(cb){
  fetch(api("/api/settings?t=" + Date.now()))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(s){ cb(s); })
    .catch(function(){ cb(null); });
}
/* 回读逐字段核对。cb(bad)：bad=[] 全部生效 / bad=[键…] 未生效 / bad=null 读不到。
   读不到时自动重试，覆盖「热点刚切换、手机还没重连上」的窗口。 */
function verifyFields(fields, cb){
  var keys = Object.keys(fields);
  if (!keys.length) return cb([]);
  var tries = 0, MAX = 3;
  (function attempt(){
    tries++;
    readSettings(function(s){
      if (!s){ if (tries < MAX) return setTimeout(attempt, 2500); return cb(null); }
      var bad = [];
      keys.forEach(function(k){
        var want = String(fields[k]);
        if (k === "pass"){                       /* 固件不回显密码，只回显「有没有设」 */
          if ((!!s.pass_set) !== (want !== "")) bad.push(k);
          return;
        }
        if (k.indexOf("p_") === 0){      /* GPIO 引脚：固件以 pins[] 数组回显 */
          var gi = GPIO_KEY.indexOf(k.slice(2));
          var gv = (gi >= 0 && s.pins) ? String(s.pins[gi]) : "";
          if (gv !== want) bad.push(k);
          return;
        }
        var got = (s[k] == null) ? "" : String(s[k]);
        if (got !== want) bad.push(k);
      });
      cb(bad);
    });
  })();
}
function badLabel(bad){ return bad.map(function(k){ return SETT_LABEL[k] || k; }).join("、"); }
/* stateId = 就地状态元素 id；note = 成功后额外补充的话 */
function postSettings(fields, done, stateId, note){
  if (LOCAL_PREVIEW){   /* file:// 打开：请求到不了设备，别谎报"网络异常" */
    saveState(stateId, "warn", "⚠ 本地预览（未连设备）：只在本页生效，未写入设备");
    done && done();
    return;
  }
  var body = Object.keys(fields).map(function(k){ return k + "=" + encodeURIComponent(fields[k]); }).join("&");
  saveState(stateId, "busy", "保存中…");
  fetch(api("/api/settings"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body
  }).then(function(r){
    if (!r.ok){ saveState(stateId, "err", "✗ 保存失败：设备返回 " + r.status + "，请重试"); return; }
    verifyFields(fields, function(bad){
      if (bad === null) saveState(stateId, "warn", "⚠ 已提交，但读不到设备确认 —— 请刷新页面核对");
      else if (bad.length) saveState(stateId, "err", "✗ 未生效：" + badLabel(bad) + "（请重试）");
      else saveState(stateId, "ok", note || "✓ 已保存并生效");
      done && done();
    });
  }).catch(function(){
    /* 改热点名/密码会立刻断掉客户端，应答可能收不到，但设备侧可能已经保存了 → 回读确认。 */
    saveState(stateId, "warn", "⚠ 没收到应答，正在核对（热点可能已切换）…");
    verifyFields(fields, function(bad){
      if (bad === null) saveState(stateId, "warn", "⚠ 没收到应答：若刚改了热点名/密码，请用新名称重连热点后再刷新核对");
      else if (bad.length) saveState(stateId, "err", "✗ 保存失败：" + badLabel(bad) + " 未生效 —— 请重连 MoInk 热点后重试");
      else { saveState(stateId, "ok", "✓ 已保存并生效（热点已切换，请用新名称重连）"); done && done(); }
    });
  });
}
/* 休眠/唤醒改为显式保存（不再随下拉框变更即时保存） */
$("actionSel").addEventListener("change", syncPowerUI);
$("sleepSel").addEventListener("change", syncPowerUI);
$("saveSleep").addEventListener("click", function(){
  postSettings({
    sleep_s: $("sleepSel").value,
    timeout_action: $("actionSel").value,
    wake_s: $("wakeSel").value,
    wake_show: $("wakeShow").checked ? 1 : 0,
    line_v: $("lineNew").checked ? 1 : 0
  }, function(){ loadSettings(); }, "sleepmsg");
});
$("saveAp").addEventListener("click", function(){
  /* FB-014①：pass 按需携带 —— 留空 = 不携带（固件保持当前密码）；
     勾选「清除密码」= 显式发空串（热点转开放）。 */
  var fields = { ssid: $("apSsid").value, wifi_pwr: $("wifiPwrSel").value };
  if ($("apClearPw").checked) fields.pass = "";
  else if ($("apPass").value) fields.pass = $("apPass").value;
  postSettings(fields, function(){
    $("apPass").value = "";
    refreshInfo(); loadSettings();
  }, "apmsg");
});
/* 编辑空间几何切换后的重排：画布尺寸 / 对象手柄 / 预览全部跟着换。 */
function onGeomChanged(){
  liveBase = null; liveAbove = null; liveMetric = null;
  try { prevEl.width = EW; prevEl.height = EH; } catch(e){}
  try { layoutObjs(); } catch(e){}
  schedulePreview(false);
}
/* R1.4.0-3：上下旋转是页面本地偏好（只影响输出帧），改动即存不进设备、无需重启。 */
$("vrot").addEventListener("change", function(){
  cfg.vrot = $("vrot").checked ? 1 : 0;
  saveCfg();
  msg(cfg.vrot ? "已开启上下旋转：之后刷新 / 存图库的画面会旋转 180°"
               : "已关闭上下旋转：输出恢复正向", "ok", 5000);
});
$("panelSel").addEventListener("change", function(){ PANEL.id = +$("panelSel").value; });
$("savePanel").addEventListener("click", function(){
  var p = $("panelSel").value;
  var fields = { panel: p };
  postSettings(fields, function(){
    PANEL.id = +p;
    if (applyPanelGeom(PANEL.id)) onGeomChanged();
    refreshInfo();
  }, "panelmsg");
});

/* ---------- 远程图槽（R1.4.0）----------
   只在打开设置、用户点按钮时请求；/api/remote 会 power_activity()，
   定时轮询等于让设备永不休眠。 */
function rBody(o){
  return Object.keys(o).map(function(k){
    return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]);
  }).join("&");
}
function loadRemote(){
  fetch(api("/api/remote")).then(function(r){ return r.ok ? r.json() : null; })
    .then(function(j){
      if (!j) return;
      var el = $("rState");
      var names = { 0: "未启用", 1: "单张 .bin", 2: "清单 moink.mf" };
      var txt = "模式：" + (names[j.mode] || j.mode) +
                (j.online ? " · 已联网" : " · 未联网");
      if (j.mode && j.count) txt += " · 清单 " + j.count + " 张";
      if (j.slot >= 0) txt += " · 上次第 " + (j.slot + 1) + " 张";
      if (j.busy) txt += " · 同步中…";
      if (j.err) txt += " · 上次错误码 " + j.err;
      el.textContent = txt;
      el.style.color = j.busy ? "var(--acc)" : (j.err ? "var(--err)" : "var(--mut)");
    })
    .catch(function(){ /* 旧固件没有 /api/remote：静默跳过 */ });
}
$("rSave").addEventListener("click", function(){
  var f = { r_mode: $("rMode").value, r_url: $("rUrl").value,
            r_user: $("rUser").value };
  if ($("rPass").value) f.r_pass = $("rPass").value;
  postSettings(f, function(){ loadRemote(); $("rPass").value = ""; }, "rmsg",
               "✓ 已保存");
});
$("rSync").addEventListener("click", function(){
  saveState("rmsg", "busy", "已请求同步，正在拉取并刷屏…");
  fetch(api("/api/remote"), { method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: rBody({ act: "sync" }) })
    .then(function(r){ return r.text().then(function(t){ return {ok: r.ok, s: r.status, t: t}; }); })
    .then(function(x){
      if (!x.ok) throw new Error(x.t || ("HTTP " + x.s));
      saveState("rmsg", "ok", "✓ 已开始同步（刷屏需 2~45 秒，稍后看屏幕）");
      setTimeout(loadRemote, 1500);
    })
    .catch(function(e){ saveState("rmsg", "err", "✗ " + (e.message || "失败")); });
});
$("rProbe").addEventListener("click", function(){
  saveState("rmsg", "busy", "正在读清单…（未联网时最多等 15 秒）");
  fetch(api("/api/remote"), { method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: rBody({ act: "probe" }) })
    .then(function(r){ return r.text().then(function(t){ return {ok: r.ok, t: t}; }); })
    .then(function(x){
      if (!x.ok) throw new Error(x.t);
      var j = JSON.parse(x.t);
      if (j.count < 0) saveState("rmsg", "err", "✗ 读不到清单（错误码 " + j.err + "）");
      else saveState("rmsg", "ok", "✓ 清单 " + j.count + " 张");
      loadRemote();
    })
    .catch(function(e){ saveState("rmsg", "err", "✗ " + (e.message || "失败")); });
});
/* 把当前画面直接 PUT 到远程目录（任何接受 PUT 的服务都行，不限 WebDAV）。
   不刷新屏幕、不占本地槽。 */
/* 与「保存」面板的「存到远程」共用同一段逻辑（50-ui.js 的 pushRemote），
   只是状态显示位置不同：这里在设置卡片里，那里在画布状态条。 */
$("rPush").addEventListener("click", function(){
  pushRemote(function(kind, text){ saveState("rmsg", kind, text); });
});

/* ---------- GPIO 设置（R1.2.2，FB-GPIO）----------
   4 档：0 默认 / 1 排线 / 2 整合板 / 3 自定义。自定义时 8 个下拉逐个选引脚；
   已选过的 IO 自动从其它下拉里去掉；ADC 限 GPIO0–4（ESP32-C3 只有 ADC1 五个通道），
   唤醒限 GPIO0–5（RTC 深睡唤醒域），其余限安全白名单 0..10（排除固件自用的自锁脚 2）。
   引脚改动只在启动时初始化，故必须重启生效 → 提供「保存并重启」。 */
var GPIO_KEY   = ["adc","wake","sck","mosi","cs","dc","rst","busy"];
var GPIO_WHITE = [0,1,3,4,5,6,7,8,9,10];   /* 0..10 去掉自锁脚 GPIO2 */
function gpioPool(i){
  if (i === 0) return [0,1,2,3,4];          /* ADC1_CH0..CH4 = GPIO0..4 */
  if (i === 1) return [0,1,2,3,4,5];        /* RTC GPIO0..5 */
  return GPIO_WHITE.slice();
}
function gpioSels(){ return Array.prototype.slice.call(document.querySelectorAll("#gpioCustom .gpin")); }
/* 重算 8 个下拉的选项：先满足 changedIdx（用户刚改的那个），其余依次避让，
   保证 8 个 IO 两两不重复。 */
function syncGpioSels(changedIdx){
  var sels = gpioSels(), n = sels.length;
  var order = [];
  if (changedIdx != null && changedIdx >= 0) order.push(changedIdx);
  for (var i = 0; i < n; i++) if (i !== changedIdx) order.push(i);
  var taken = {}, val = new Array(n);
  order.forEach(function(i){
    var pool = gpioPool(i).map(String), cur = sels[i].value;
    if (pool.indexOf(cur) >= 0 && !taken[cur]) { val[i] = cur; }
    else {
      var free = pool.filter(function(x){ return !taken[x]; });
      val[i] = free.length ? free[0] : pool[0];
    }
    taken[val[i]] = true;
  });
  sels.forEach(function(s, i){
    var others = {};
    for (var j = 0; j < n; j++) if (j !== i) others[val[j]] = true;
    var opts = gpioPool(i).map(String).filter(function(x){ return !others[x] || x === val[i]; });
    if (opts.indexOf(val[i]) < 0) opts.push(val[i]);
    s.innerHTML = opts.map(function(x){ return '<option value="'+x+'">GPIO'+x+'</option>'; }).join("");
    s.value = val[i];
  });
}
function toggleGpioCustom(){ $("gpioCustom").style.display = ($("gpioPreset").value === "3") ? "" : "none"; }
/* R1.3.6：「排线版本」只在接法选「排线」时才出现 —— 其它档位没有这回事。 */
function syncLineVer(preset){
  var v = (preset == null) ? $("gpioPreset").value : String(preset);
  var disp = (v === "1") ? "" : "none";
  $("lineVerRow").style.display = disp;
  $("lineVerHint").style.display = disp;
}
function loadGpio(s){
  var preset = (s && s.gpio_preset != null) ? +s.gpio_preset : 0;
  $("gpioPreset").value = String(preset);
  var pins = (s && s.pins && s.pins.length === 8) ? s.pins.map(Number) : [0,5,4,6,7,1,3,10];
  gpioSels().forEach(function(sel, i){
    var v = String(pins[i]);
    sel.innerHTML = '<option value="'+v+'">GPIO'+v+'</option>';
    sel.value = v;
  });
  syncGpioSels(null);
  toggleGpioCustom();
  syncLineVer(preset);
}
function gpioFields(){
  var preset = $("gpioPreset").value;
  var fields = { gpio_preset: preset };
  if (preset === "3") gpioSels().forEach(function(sel, i){ fields["p_" + GPIO_KEY[i]] = sel.value; });
  return fields;
}
function rebootDevice(){
  saveState("gpiomsg", "busy", "重启中…");
  fetch(api("/api/reboot"), { method: "POST" }).then(function(){
    saveState("gpiomsg", "ok", "✓ 已重启，请用 MoInk 热点重连后刷新");
  }).catch(function(){
    /* 重启会立刻断开热点，收不到应答属正常。 */
    saveState("gpiomsg", "warn", "⚠ 已发出重启指令，设备断连属正常，请稍候重连");
  });
}
gpioSels().forEach(function(sel, i){
  sel.addEventListener("change", function(){ syncGpioSels(i); });
});
$("gpioPreset").addEventListener("change", function(){
  if ($("gpioPreset").value === "3") syncGpioSels(null);
  toggleGpioCustom();
  syncLineVer();
});
$("saveGpio").addEventListener("click", function(){
  postSettings(gpioFields(), function(){}, "gpiomsg", "✓ 已保存，重启后生效");
});
$("saveGpioReboot").addEventListener("click", function(){
  postSettings(gpioFields(), function(){ rebootDevice(); }, "gpiomsg", "✓ 已保存，正在重启…");
});
