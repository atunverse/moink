// smoke_page.js —— 页面冒烟测试（Node）。
// 抽取 page/index.html 主脚本的纯函数段（算法 + 打包 + 帧头），在最小 sandbox 里跑断言。
// 覆盖：CRC16 金标准、帧头 16 字节字段、packIdx 纯色打包、
//       R1.0.12 结构（Cropper 内嵌 / 文字对象 / 留白 / 双 script 闭合符）、
//       R1.2.0 统一升级入口（/api/upload）+ 单一版本号显示、
//       R1.3.0 轮播图库（4 条 /api/carousel/* 路由 + save/noshow/tlen + 页面图库 UI）。
//
// 用法：node tools/smoke_page.js   （tools/ 下已有 package.json 声明 commonjs）
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const page = fs.readFileSync(path.join(__dirname, "..", "page", "index.html"), "utf8");
const captive = fs.readFileSync(path.join(__dirname, "..", "src", "captive.c"), "utf8");
const netifAp = fs.readFileSync(path.join(__dirname, "..", "src", "netif_ap.c"), "utf8");
// R1.2.2：引脚运行时代化 / GPIO 预设 / 自锁脚 需在固件侧交叉校验
const settingsH = fs.readFileSync(path.join(__dirname, "..", "src", "settings.h"), "utf8");
const epdDrvC = fs.readFileSync(path.join(__dirname, "..", "src", "epd_drv.c"), "utf8");
const mainC = fs.readFileSync(path.join(__dirname, "..", "src", "main.c"), "utf8");
const powerC = fs.readFileSync(path.join(__dirname, "..", "src", "power.c"), "utf8");
// 版本号动态取自 version.h，避免每次升版都要改断言
const versionH = fs.readFileSync(path.join(__dirname, "..", "src", "version.h"), "utf8");
const VER = (/#define\s+MOINK_VERSION\s+"([^"]+)"/.exec(versionH) || [])[1] || "";
const settingsC = fs.readFileSync(path.join(__dirname, "..", "src", "settings.c"), "utf8");
// R1.0.12 起页面有两个 <script> 块（第 1 块 = 内嵌 Cropper.js，第 2 块 = 主脚本）。
// \r?\n：兼容 core.autocrlf 检出为 CRLF 的工作区（2026-09-22 修正）。
const m = page.match(/<script>\r?\n"use strict";\r?\n([\s\S]*?)\r?\n<\/script>/);
if (!m) { console.error("no main <script> found"); process.exit(1); }
const js = m[1];

// 只取 DOM 代码之前的纯函数段：截止到 `var $ = function` 之前。
const cut = js.indexOf("var $ = function");
if (cut < 0) { console.error("pure-section marker not found"); process.exit(1); }
const pure = js.slice(0, cut);

const sandbox = { window: {}, console: console, Uint8Array: Uint8Array,
                  Float64Array: Float64Array, Int32Array: Int32Array,
                  Math: Math, JSON: JSON, Infinity: Infinity, NaN: NaN,
                  Date: Date };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let failed = 0;
function ok(name, cond) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) failed++;
}
function eq(name, got, want) { ok(name + " (got " + got + " want " + want + ")", got === want); }

// 静态防线：脚本串里若出现字面量 </script>，浏览器会提前终结脚本块。
// R1.0.12 起：合法闭合符数量随功能块增加而调整（R1.1.0 = 3），详见下方断言。
// R1.1.0 起 = 3 个合法闭合符（内嵌 Cropper 块 + 页脚版本填充块 + 主脚本块），多一个都不行。
eq("script closer count (cropper + footer + main = exactly 3)", (page.match(/<\/script>/g) || []).length, 3);
ok("offline export keeps </script> escaped in injected html", page.indexOf("<\\/script>") >= 0);
ok("cropper.js inlined (first script block)", /<script>\s*\n?\/\* ===== Cropper\.js v1\.6\.2/.test(page));
ok("startup block intact (loadSettings call present)", /loadSettings\(\)/.test(js));
// R1.0.12 结构检查
ok("page version meta present (R1.x.y)", /moink-page-version" content="R1\.\d+\.\d+"/.test(page));
// 10. R1.0.18 UI 重构：齿轮入口 / 返回按钮 / 无页签 / 步骤条 / 设备信息网格 / 分栏 / 文案
ok("R1.0.18 gear + back nav present", page.includes('id="gearBtn"') && page.includes('id="backBtn"'));
ok("R1.0.18 tab bar removed", page.indexOf('data-t="image"') < 0 && page.indexOf('id="tabs"') < 0);
ok("R1.0.18 subtitle", page.includes("把喜欢的瞬间，放在身边"));
ok("R1.0.18 header version line removed", page.indexOf('id="i-fw"') < 0);
ok("R1.0.18 dev copy cleaned (no 预览已跑通/预览还没跑通)",
   page.indexOf("预览已跑通") < 0 && page.indexOf("预览还没跑通") < 0);
ok("R1.0.18 steps bar + updateSteps", page.includes('id="steps"') && js.indexOf("function updateSteps") >= 0);
ok("R1.0.18 infoGrid device info", page.includes('class="infoGrid"'));
ok("R1.0.18 editor split columns", page.includes('id="editorGrid"') && page.includes('id="editRight"'));
ok("R1.0.21 mode desc removed", page.indexOf("\u50cf\u62cd\u7acb\u5f97\u4e00\u6837") < 0 && page.indexOf("\u5199\u70b9\u60f3\u8bf4\u7684") < 0 && page.indexOf("modeDesc") < 0 && js.indexOf("MODE_DEF") < 0);
ok("R1.0.19 image h2 removed", page.indexOf("选图 · 裁剪 · 上传") < 0);
ok("R1.0.19 autoPush fully removed", js.indexOf("scheduleAutoPush") < 0 && page.indexOf("autoPushRow") < 0 && js.indexOf("cfg.autoPush") < 0);
ok("R1.0.19 four-color stroke/bg/tbg/objbg", page.includes("黄边") && page.includes("红边") && page.includes("黄底") && page.includes("红底"));
ok("R1.0.19 dither hint wired", page.includes('id="dmodeHint"') && js.indexOf("DMODE_HINT") >= 0);
ok("R1.0.20 pad per-side checkboxes + default-on-check",
   page.includes('id="padTOn"') && page.includes('id="padBOn"')
   && page.includes('id="padLOn"') && page.includes('id="padROn"')
   && js.indexOf("function padSideVal") >= 0 && js.indexOf('pv("padTOn"') < 0);
ok("R1.0.20 numeric-only display (no units)", js.indexOf("return s + c.unit") < 0 && js.indexOf('v * 100 : v') >= 0);
ok("R1.0.20 textarea always editable", js.indexOf('tObjBg","txt') < 0);
ok("R1.0.21 steps mode-aware", js.indexOf("\u2460 \u7f16\u8f91\u6587\u5b57") >= 0 && js.indexOf("has ? 2 : 1") >= 0);
ok("R1.0.21 padGrid grid layout", js.indexOf('padOn ? "grid"') >= 0 && page.indexOf("grid-template-columns:repeat(4,1fr)") >= 0);
ok("R1.0.21 bg selects merged row", page.indexOf('id="tbgRow"') < 0 && js.indexOf("tbgRow") < 0 && page.indexOf('id="objBgRow"') >= 0);
ok("R1.0.19 text add no auto-create", js.indexOf('text:"新文字"') < 0 && js.indexOf("请先输入文字") >= 0);
ok("R1.0.19 offline lab hint removed", page.indexOf("\u79bb\u7ebf\u5ba2\u6237\u7aef\u5bfc\u51fa\u4e3a\u5b9e\u9a8c\u6027\u529f\u80fd") < 0);
ok("R1.0.19 gamma unit + signed b/c", page.indexOf('unit:"\u00d7"') >= 0 && js.indexOf("fmtCtrl") >= 0);
// R1.0.22 修复与清理
ok("R1.0.22 upload error precedence + timeout",
   js.indexOf('xhr.responseText || ("HTTP " + xhr.status)') >= 0 && js.indexOf("xhr.timeout = 30000") >= 0);
ok("R1.0.22 stroke four-color echo", js.indexOf('tStrokeC").value = String(clamp(+o.strokeC|0, 0, 3))') >= 0);
ok("R1.0.22 pointerId guard", js.indexOf("pid:e.pointerId") >= 0 && js.indexOf("e.pointerId !== od.pid") >= 0);
ok("R1.0.22 offline export cleans runtime nodes",
   js.indexOf("cloneNode(true)") >= 0 && js.indexOf("#ctrls > *, #objLayer > *") >= 0);
ok("R1.0.22 EXIF revoke timing fixed",
   js.indexOf("im2.onload = function(){ URL.revokeObjectURL(url); adoptImg(im2, u2, f); };") >= 0);
// 9. R1.0.17 EXIF 归一 + 换图重置旋转 + 文字开关过滤
ok("R1.0.17 exifOrientation present", /function exifOrientation\(/.test(page));
ok("R1.0.17 cropRot reset on adoptImg", /curRot = 0; cfg\.cropRot = 0; syncRotUI\(\);/.test(page));
ok("R1.0.17 textOn filter in renderComposite", /cfg\.textOn \? cfg\.objsImg : \[\]/.test(page));
ok("text object system (drawObjs + normObjs)", js.indexOf("function drawObjs") >= 0 && js.indexOf("function normObjs") >= 0);
ok("padding module (contentRect/contentAR)", js.indexOf("function contentRect") >= 0 && js.indexOf("function contentAR") >= 0);
ok("cropper bridge (initCrop/getCropCanvas)", js.indexOf("function initCrop") >= 0 && js.indexOf("function getCropCanvas") >= 0);
ok("rot snap 90 (rotSnap)", js.indexOf("function rotSnap") >= 0);
ok("old crop code retired", js.indexOf("drawCropInto") < 0 && js.indexOf("imgSig") < 0 && js.indexOf("textMetrics") < 0);
ok("frozen algorithm intact (WARM_SAT_K + power law)", js.indexOf("WARM_SAT_K = 0.75") >= 0 && js.indexOf("Math.pow(s, 1 - WARM_SAT_K*g)") >= 0);

try {
  vm.runInContext(pure, sandbox, { filename: "page.js" });
} catch (e) {
  console.error("evaluate failed:", e.message);
  process.exit(1);
}

// 1. CRC16 金标准
const crc = sandbox.crc16(new Uint8Array([0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39]));
eq("crc16('123456789')", crc, 0x29B1);

// 2. 帧头 16 字节
const payload = new Uint8Array(105984).fill(0x55);
const frame = sandbox.frameWithHeader(payload);
eq("frame length", frame.length, 105984 + 16);
eq("magic0", frame[0], 0xA5);
eq("magic1", frame[1], 0x5A);
eq("version", frame[2], 1);
eq("width", (frame[4] << 8) | frame[5], 768);
eq("height", (frame[6] << 8) | frame[7], 552);
const len = (frame[8] << 24) | (frame[9] << 16) | (frame[10] << 8) | frame[11];
eq("payload length", len, 105984);
eq("crc match", ((frame[12] << 8) | frame[13]), sandbox.crc16(payload));

// 3. packIdx 纯色
const white = new Uint8Array(768 * 552).fill(1);
const buf = sandbox.packIdx(white);
eq("packIdx buffer length", buf.length, 105984);
eq("packIdx all-white == 0x55", buf.every(b => b === 0x55), true);

// 4/5. R1.0.22：modeAR / statsOf 死代码已删除
ok("R1.0.22 dead code removed (modeAR/statsOf)",
   js.indexOf("function modeAR") < 0 && js.indexOf("function statsOf") < 0);

// 6. R1.0.16 竖屏编辑 + rotateCW 桥接
eq("PANEL device frame 768x552", sandbox.PANEL.w + "x" + sandbox.PANEL.h, "768x552");
eq("edit space portrait 552x768", sandbox.EW + "x" + sandbox.EH, "552x768");
const rot = sandbox.rotateCW(new Uint8Array([1,2,3,4,5,6]), 3, 2);
eq("rotateCW mapping (CW 90)", Array.from(rot).join(","), "4,1,5,2,6,3");
ok("packFull bridge (rotateCW -> packIdx)", js.indexOf("packIdx(rotateCW(renderComposite(EW, EH), EW, EH))") >= 0);
// 7. R1.0.16 文字框宽度边柄
ok("wrap handle h-w (left-bottom) + red delete handle h-del",
   js.indexOf('"hnd h-w"') >= 0 && js.indexOf('"hnd h-del"') >= 0
   && js.indexOf('od.act === "wl"') >= 0 && js.indexOf('"hnd h-wr"') < 0
   && page.indexOf(".h-wl") < 0);
// 8. R1.0.16 卡片顺序：选图 → 风格 → 留白 → 文字
{
  const o1 = page.indexOf('id="pickCard"'), o2 = page.indexOf('id="styleCard"'),
        o3 = page.indexOf('id="padCard"'), o4 = page.indexOf('id="textCard"');
  ok("card order pick < style < pad < text", o1 >= 0 && o1 < o2 && o2 < o3 && o3 < o4);
}
ok("portrait migration (m16rot)", js.indexOf("cfg.m16rot") >= 0);

// R1.2.2：A1 真机验收通过后只保留 768x552 顺序档，A1 驱动二级菜单整体删除。
ok("R1.2.2 A1 drive second-level menu removed",
   page.indexOf('id="a1Row"') < 0 && page.indexOf('id="a1Sel"') < 0
   && page.indexOf("a1Hint") < 0 && js.indexOf("A1MODE") < 0
   && js.indexOf("a1_mode") < 0 && js.indexOf("panelGeomOf") < 0
   && js.indexOf("syncPanelRows") < 0 && js.indexOf("apiAtLeast2") < 0);
ok("R1.2.2 geometry helpers kept (geom now constant 768x552)",
   js.indexOf("function applyPanelGeom") >= 0 && js.indexOf("function migrateGeomTo") >= 0
   && js.indexOf("function onGeomChanged") >= 0
   && js.indexOf("PANEL.w === 768 && PANEL.h === 552") >= 0);
ok("R1.2.2 frame version pinned to 1 (800x600 dropped)",
   js.indexOf("hdr[2] = 1;") >= 0 && js.indexOf("(PANEL.w === 800) ? 2 : 1") < 0);
ok("R1.2.2 DEV_API kept",
   js.indexOf("var DEV_API = 0") >= 0 && js.indexOf("if (j.api != null) DEV_API") >= 0);
ok("R1.2.2 GPIO 设置 UI (preset/custom/save/reboot/state)",
   page.includes('id="gpioPreset"') && page.includes('id="gpioCustom"')
   && page.includes('id="saveGpio"') && page.includes('id="saveGpioReboot"')
   && page.includes('id="gpiomsg"')
   && js.indexOf("function syncGpioSels") >= 0 && js.indexOf("function gpioPool") >= 0
   && js.indexOf("function loadGpio") >= 0 && js.indexOf("function gpioFields") >= 0);
ok("R1.2.2 GPIO 受限池 (ADC 0-4 / WAKE 0-5 / 白名单去自锁脚 2)",
   js.indexOf("if (i === 0) return [0,1,2,3,4];") >= 0
   && js.indexOf("if (i === 1) return [0,1,2,3,4,5];") >= 0
   && js.indexOf("var GPIO_WHITE = [0,1,3,4,5,6,7,8,9,10];") >= 0
   && js.indexOf('var GPIO_KEY   = ["adc","wake","sck","mosi","cs","dc","rst","busy"];') >= 0);
ok("R1.2.2 自定义引脚以 p_* 提交、回读走 pins[] 数组",
   js.indexOf('fields["p_" + GPIO_KEY[i]] = sel.value;') >= 0
   && js.indexOf('if (k.indexOf("p_") === 0)') >= 0 && js.indexOf("s.pins[gi]") >= 0);
ok("R1.2.2 保存并重启走 /api/reboot",
   js.indexOf('fetch(api("/api/reboot"), { method: "POST" })') >= 0);
ok("R1.2.2 固件侧：引脚运行时化 + 三档预设 + 自锁脚 + 无 EPD_PIN_ 残留",
   settingsH.indexOf("#define PIN_SELF_LOCK  2") >= 0
   && settingsH.indexOf("GPIO_PRESET_LINE     1") >= 0
   && settingsH.indexOf("GPIO_PRESET_BOARD    2") >= 0
   && settingsH.indexOf("GPIO_PRESET_CUSTOM   3") >= 0
   && epdDrvC.indexOf("settings_pins()") >= 0 && epdDrvC.indexOf("EPD_PIN_") < 0);
ok("R1.2.2 固件侧：自锁 GPIO2 上电拉高 + /api/reboot + 无 a1_mode",
   mainC.indexOf("gpio_set_level((gpio_num_t)PIN_SELF_LOCK, 1);") >= 0
   && mainC.indexOf('"/api/reboot"') >= 0 && mainC.indexOf("epd_set_a1_mode") < 0);
// R1.2.2：升级不再全量重置设置，只清理本版已废弃的键（a1_mode / a11_var）。
const rfu = settingsC.slice(settingsC.indexOf("void settings_reset_for_upgrade"));
ok("R1.2.2 固件侧：升级只清废弃键、不重置用户设置",
   rfu.indexOf("DROP_KEYS") >= 0 && rfu.indexOf('"a1_mode"') >= 0
   && rfu.indexOf('"a11_var"') >= 0 && rfu.indexOf("s_cfg = DEFAULTS") < 0
   && rfu.indexOf('"sleep_s"') < 0);
// R1.2.0（FB-015）：版本号由 fw/page 两套合并为 MOINK_VERSION 一套；
//   固件与控制页合并到同一入口 /api/upload，由固件按请求体首块内容嗅探分流。
ok("R1.2.0 统一升级入口 UI (upFile/upGo/upmsg)",
   page.includes('id="upFile"') && page.includes('id="upGo"')
   && page.includes('class="savestate" id="upmsg"')
   && page.includes('accept=".bin,.html,.htm"') && page.includes('id="webClear"'));
ok("R1.2.0 旧的两个入口与同步复选框已删",
   page.indexOf('id="fwFile"') < 0 && page.indexOf('id="fwGo"') < 0
   && page.indexOf('id="webFile"') < 0 && page.indexOf('id="webGo"') < 0
   && page.indexOf("fwSyncPage") < 0 && page.indexOf("sync_page") < 0);
ok("R1.2.0 单一入口常量 + 无旧路由残留",
   js.indexOf('var UP_URL = "http://192.168.4.1/api/upload";') >= 0
   && js.indexOf("OTA_URL") < 0 && js.indexOf('"/api/ota"') < 0
   && page.indexOf('"/api/ota"') < 0);
ok("R1.2.0 双端同规则嗅探 (sniffKind + readHead, 固件 0xE9 / 页面 <!doctype)",
   js.indexOf("function sniffKind(bytes)") >= 0
   && js.indexOf("function readHead(file, cb)") >= 0
   && js.indexOf("bytes[0] === 0xE9") >= 0
   && js.indexOf('head.indexOf("<!doctype")') >= 0
   && js.indexOf("改 sniffKind() 必须同步改 src/ota_web.c 的 sniff_kind()") >= 0);
ok("R1.2.0 固件重启导致响应可能收不到 -> sentAll 兜底",
   js.indexOf("var sentAll = false") >= 0 && js.indexOf("if (isFw && sentAll)") >= 0);
// R1.1.3（FB-014）：设置项就地保存状态（不再依赖图片页里不可见的 #msg）+ 保存后回读核对
ok("R1.1.3 就地状态位 3 处 (sleepmsg/apmsg/panelmsg)",
   page.indexOf('class="savestate" id="sleepmsg"') >= 0
   && page.indexOf('id="apmsg"') >= 0 && page.indexOf('id="panelmsg"') >= 0
   && page.indexOf('id="sleepmsg" style="margin:0"') < 0);
ok("R1.1.3 就地状态助手 (saveState/readSettings/verifyFields)",
   js.indexOf("function saveState(id, kind, text)") >= 0
   && js.indexOf("function readSettings(cb)") >= 0
   && js.indexOf("function verifyFields(fields, cb)") >= 0);
ok("R1.1.3 保存后回读 /api/settings 逐字段核对（不轻信 HTTP 200）",
   js.indexOf('fetch(api("/api/settings?t=" + Date.now()))') >= 0
   && js.indexOf("badLabel(bad)") >= 0 && js.indexOf("SETT_LABEL") >= 0);
ok("R1.1.3 失败/未生效/没收到应答都有明确提示",
   js.indexOf('"✗ 保存失败：设备返回 "') >= 0 && js.indexOf('"✗ 未生效："') >= 0
   && js.indexOf('"⚠ 没收到应答：') >= 0);
ok("R1.1.3 本地预览不谎报网络异常（且照常切档预览）",
   js.indexOf("if (LOCAL_PREVIEW){") >= 0
   && js.indexOf("本地预览（未连设备）：只在本页生效") >= 0);
ok("R1.1.3 旧的静默提示路径已移除",
   page.indexOf('msg("保存失败", "err")') < 0 && page.indexOf('msg("网络错误", "err")') < 0);
ok("R1.2.0 热点密码单字段语义（留空=保持 / 勾选清除=开放，FB-014①）",
   page.indexOf("留空 = 保持当前密码") >= 0 && page.indexOf('id="apClearPw"') >= 0
   && page.indexOf("留空 = 清除密码") < 0 && page.indexOf("留空则不修改") < 0);
ok("R1.2.0 热点保存按需携带 pass（缺省不发送 = 固件保持）",
   js.indexOf('if ($("apClearPw").checked) fields.pass = "";') >= 0
   && js.indexOf('else if ($("apPass").value) fields.pass = $("apPass").value;') >= 0);
ok(VER + " 版本 meta", !!VER && page.indexOf('content="' + VER + '"') >= 0);
ok("R1.2.1 正式配置页不含 iOS captive 专用渲染逻辑",
   js.indexOf("captiveLitePreview") < 0 && js.indexOf("iosDevice") < 0
   && page.indexOf("iosCaptiveNotice") < 0
   && js.indexOf("return packIdx(rotateCW(renderComposite(EW, EH), EW, EH))") >= 0);
ok("R1.2.1 上传前显示 loading",
   page.indexOf('id="workLoading"') >= 0 && page.indexOf('id="workLoadingText"') >= 0
   && js.indexOf("function afterLoadingPaint(fn)") >= 0
   && js.indexOf('showWorkLoading("正在生成上传数据…")') >= 0
   && js.indexOf('afterLoadingPaint(function(){ buildAndUpload("show"); })') >= 0);
ok("R1.2.1 裁剪手势松手后才生成目标预览",
   js.indexOf("crop: function(){ schedulePreview(true); }") < 0
   && js.indexOf("cropend: function(){ cropInvalid(); schedulePreview(false); }") >= 0);
ok("R1.2.1 Apple captive 使用轻量 Safari 引导页并返回 Success",
   captive.indexOf("请使用 Safari 打开配置页") >= 0
   && captive.indexOf("<p>墨印 · MoInk</p>") >= 0
   && captive.indexOf("连接窗口性能较低") < 0
   && captive.indexOf("复制地址并关闭此页") >= 0
   && captive.indexOf("192.168.4.1") >= 0
   && captive.indexOf("moink_done=1") >= 0
   && captive.indexOf("请点击右上角的“完成”关闭此页面") >= 0
   && captive.indexOf("<TITLE>Success</TITLE>") >= 0
   && captive.indexOf("#define APPLE_SUCCESS_WINDOW_MS 60000") >= 0
   && netifAp.indexOf("captive_apple_station_disconnected();") >= 0
   && captive.indexOf("captive_deauth_task") < 0);
ok("R1.2.1 小米文件选择兜底缩短为 0.8 秒",
   js.indexOf('if (!pickerLeftPage) $("browserFallback").classList.add("show");') >= 0
   && js.indexOf("}, 800);") >= 0 && js.indexOf("}, 1200);") < 0);
ok("R1.2.1 文字框仅当前会话有效，重新打开页面为空",
   js.indexOf("delete stored.objsImg; delete stored.objsNote; delete stored.text;") >= 0
   && js.indexOf("cfg.objsImg = [];") >= 0
   && js.indexOf("cfg.objsNote = [];") >= 0
   && js.indexOf('if (!o){ txtEl.value = ""; return; }') >= 0);
ok("R1.2.1 文字拖动全尺寸并复用 DOM 手柄",
   js.indexOf("liveBase = renderBase(EW, EH)") >= 0
   && js.indexOf("function ensureObjHandles(el)") >= 0
   && js.indexOf('if (el.querySelector(".hnd")) return') >= 0
   && js.indexOf('if (od) relayoutOne(od.i, od.act === "m" || od.act === "r")') >= 0
   && js.indexOf('el.textContent = "";\n  var hS') < 0);
// R1.2.2：A0 / A1 几何一致（768x552），几何助手收敛为常量分支。
ok("R1.2.2 applyPanelGeom(A1) keeps 768x552 and returns false",
   sandbox.applyPanelGeom(1) === false
   && sandbox.PANEL.w === 768 && sandbox.PANEL.h === 552
   && sandbox.EW === 552 && sandbox.EH === 768);
sandbox.applyPanelGeom(0);   /* 还原 */
eq("R1.1.0 GEOM_SRC default geometry", sandbox.GEOM_SRC.w + "x" + sandbox.GEOM_SRC.h, "552x768");

ok("R1.2.0 状态栏单版本号 (版本/接口, 无 fw/page 双行)",
   page.includes('id="i-verD"') && page.includes('id="i-apiD"')
   && page.indexOf('id="i-fw"') < 0 && page.indexOf('id="i-page"') < 0);
ok("R1.2.0 热更页落后固件时红字警示 (DEV_FW + verNum + j.ver||j.fw)",
   js.indexOf('var DEV_FW = "";') >= 0 && js.indexOf("function verNum(v)") >= 0
   && js.indexOf("var ver = j.ver || j.fw") >= 0
   && js.indexOf("控制页版本低于固件") >= 0);
ok("R1.2.0 A1.1 诊断变体 UI 整块删除 (选项/行/字段)",
   page.indexOf("A1.1") < 0 && page.indexOf('id="a11Sel"') < 0
   && page.indexOf('id="a11Row"') < 0 && js.indexOf("a11_var") < 0
   && js.indexOf("a11Sel") < 0);
ok("R1.2.0 版本号比较按 主*10000+次*100+修订",
   js.indexOf("+m[1] * 10000 + +m[2] * 100 + +m[3]") >= 0);
ok("页脚存在 (footer#appFoot)",
   page.indexOf('id="appFoot"') >= 0 && page.indexOf("footer#appFoot") >= 0);
ok("页脚含 GitHub 地址", page.indexOf('href="https://github.com/atunverse/moink"') >= 0);
ok("页脚版本号运行时填充 (footVer + meta)",
   page.indexOf('id="footVer"') >= 0 && page.indexOf('meta[name="moink-page-version"]') >= 0);

// =====================================================================
// R1.3.0：多图轮播图库（FB-017 第二部分）—— 固件 / 页面 / 契约三方交叉校验
// =====================================================================
const frameC = fs.readFileSync(path.join(__dirname, "..", "src", "frame.c"), "utf8");
const storeC = fs.readFileSync(path.join(__dirname, "..", "src", "store.c"), "utf8");
const storeH = fs.readFileSync(path.join(__dirname, "..", "src", "store.h"), "utf8");
const contract = fs.readFileSync(path.join(__dirname, "..", "docs", "CONTRACT.md"), "utf8");

ok("R1.3.0 固件侧：4 条轮播路由注册",
   mainC.indexOf('"/api/carousel/list"') >= 0 && mainC.indexOf('"/api/carousel/full"') >= 0
   && mainC.indexOf('"/api/carousel/delete"') >= 0 && mainC.indexOf('"/api/carousel/clear"') >= 0);
ok("R1.3.0 固件侧：max_uri_handlers=32（修 HANDLERS_FULL abort 循环）",
   mainC.indexOf("#define HTTPD_MAX_URI   32") >= 0
   && mainC.indexOf("cfg.max_uri_handlers = HTTPD_MAX_URI") >= 0);
ok("R1.3.0 固件侧：httpd 任务栈 8192",
   mainC.indexOf("#define HTTPD_STACK     8192") >= 0);
ok("R1.3.0 固件侧：/api/frame query save / noshow / tlen",
   frameC.indexOf('"save"') >= 0 && frameC.indexOf('"noshow"') >= 0
   && frameC.indexOf('"tlen"') >= 0
   && frameC.indexOf("bool want_save = false, want_show = true;") >= 0);
ok("R1.3.0 固件侧：轮播满 8 返回 HTTP 507",
   frameC.indexOf("STORE_ERR_FULL") >= 0 && frameC.indexOf("507") >= 0);
ok("R1.3.0 固件侧：store 保存/读取/删除/清空 四件套",
   storeC.indexOf("int store_save_frame(") >= 0 && storeC.indexOf("int store_load_slot(") >= 0
   && storeC.indexOf("int store_delete_slot(") >= 0 && storeC.indexOf("void store_clear(") >= 0);
ok("R1.3.0 固件侧：缩略上限统一 STORE_THUMB_JPEG_MAX",
   storeH.indexOf("#define STORE_THUMB_JPEG_MAX 20000u") >= 0
   && frameC.indexOf("STORE_THUMB_JPEG_MAX") >= 0 && storeC.indexOf("STORE_THUMB_JPEG_MAX") >= 0);
ok("R1.3.2 固件侧：按键消抖 + 单击/双击 + 20 s 长按",
   mainC.indexOf("#define HOLD_RESET_S    20") >= 0
   && mainC.indexOf("#define BTN_SAMPLE_MS     20") >= 0
   && mainC.indexOf("#define BTN_DEBOUNCE_N    3") >= 0
   && mainC.indexOf("#define BTN_DOUBLE_MS     400") >= 0
   && mainC.indexOf("if (++agree >= BTN_DEBOUNCE_N && stable != raw)") >= 0);
ok("R1.3.2 固件侧：刷屏与按键解耦（UI 队列 + display_task）",
   mainC.indexOf("static void display_task(void *arg)") >= 0
   && mainC.indexOf("static void ui_post(ui_event_t ev)") >= 0
   && mainC.indexOf("UI_EV_CAROUSEL_NEXT") >= 0
   && mainC.indexOf("xQueueCreate(UI_QUEUE_LEN") >= 0
   && mainC.indexOf("xQueueReceive(s_ui_q") >= 0);
ok("R1.3.2 固件侧：旧「唤醒即切图 / pending 未清」逻辑已移除",
   mainC.indexOf("bool pending = s_woken_by_btn") < 0
   && mainC.indexOf("waiting") < 0
   && mainC.indexOf("btn: single click (wake only)") >= 0);
ok("R1.3.2 固件侧：按键任务早于 store_init、display_task 最后启动",
   mainC.indexOf("xTaskCreate(button_task") >= 0
   && mainC.indexOf("xTaskCreate(button_task") < mainC.indexOf("store_init();")
   && mainC.indexOf("xTaskCreate(display_task") > mainC.indexOf("start_server()"));
ok("R1.3.0 页面：图库卡片 + 大图预览层元素",
   page.indexOf('id="galGrid"') >= 0 && page.indexOf('id="carouselClear"') >= 0
   && page.indexOf('id="prevOverlay"') >= 0 && page.indexOf('id="prevCanvas"') >= 0
   && page.indexOf('id="prevClose"') >= 0 && page.indexOf('id="caromsg"') >= 0);
ok("R1.3.4 页面：双通道上传 —— 刷新不入库 / 入库不刷新（FB-018）",
   page.indexOf('id="goOnly"') >= 0 && page.indexOf("上传到图库") >= 0
   && js.indexOf("function uploadOnly()") >= 0
   && js.indexOf("function buildAndUpload(mode)") >= 0
   && js.indexOf('var doSave = (mode === "save")') >= 0
   && js.indexOf('api(doSave ? "/api/frame?save=1&noshow=1" : "/api/frame")') >= 0
   && js.indexOf('buildAndUpload("show")') >= 0
   && js.indexOf('buildAndUpload("save")') >= 0);
ok("R1.3.0 页面：轮播满 8 的 507 提示",
   js.indexOf("xhr.status === 507") >= 0 && js.indexOf("轮播已满 8 张") >= 0);
ok("R1.3.2 固件侧：carousel_next 只在 display_task 中调用一次",
   (mainC.split("carousel_next();").length - 1) === 1);
ok("R1.3.2 页面：双击切图 / 长按 20 秒文案",
   page.indexOf("双击设备按键") >= 0 && page.indexOf("长按 20 秒") >= 0
   && page.indexOf("长按 5 秒") < 0 && page.indexOf("短按设备按键") < 0);
ok("R1.3.2 契约：已记录按键动作与刷屏解耦",
   contract.indexOf("### 5.1 按键动作与刷屏解耦") >= 0
   && contract.indexOf("`HOLD_RESET_S`(20 s)") >= 0);
ok("R1.3.2 固件侧：唤醒来源识别（button / timer / power_on / other）",
   mainC.indexOf("WAKE_SRC_BUTTON") >= 0 && mainC.indexOf("WAKE_SRC_TIMER") >= 0
   && mainC.indexOf("WAKE_SRC_POWER_ON") >= 0
   && mainC.indexOf("wake_src_from_bits") >= 0
   && mainC.indexOf("wake_reason") >= 0
   && mainC.indexOf("wake_bits") >= 0);
ok("R1.3.2 固件侧：唤醒补双击窗口收紧到 1.5 s",
   mainC.indexOf("#define BTN_WAKE_ARM_MS   1500") >= 0
   && mainC.indexOf("BTN_WAKE_ARM_MS   2500") < 0);
ok("R1.3.2 固件侧：轮播元数据多键单次 commit",
   storeC.indexOf("static int st_nvs_set_u8s(") >= 0
   && storeC.indexOf("st_nvs_set_u8s(KEY_COUNT") >= 0
   && (storeC.split("st_nvs_set_u8(KEY_CUR").length - 1) === 0);
ok("R1.3.2 固件侧：carousel_show 刷屏成功后才推进 cur（carousel_next 经它切图）",
   mainC.indexOf("if (frame_display_slot(slot) != 0)") >= 0
   && mainC.indexOf("store_meta_set(count, slot);") >= 0
   && mainC.indexOf("carousel_show((cur + 1) % count);") >= 0);
ok("预览窗口「显示到屏幕」：页面按钮 + 固件 /api/carousel/show 经显示队列切图",
   page.indexOf('id="prevShow"') >= 0
   && page.indexOf('/api/carousel/show?slot=') >= 0
   && mainC.indexOf('"/api/carousel/show"') >= 0
   && mainC.indexOf("ui_post_msg(UI_EV_CAROUSEL_SHOW, slot)") >= 0
   && mainC.indexOf("sizeof(ui_msg_t)") >= 0);
ok("R1.3.2 页面：设备信息显示「本次唤醒」",
   page.indexOf('id="i-wake"') >= 0
   && js.indexOf("wakeTxt") >= 0 && js.indexOf("j.wake_reason") >= 0);
ok("R1.3.2 契约：唤醒来源已写入 §5.2 与 /api/info 字段表",
   contract.indexOf("### 5.2 唤醒来源识别") >= 0
   && contract.indexOf("`wake_reason`") >= 0);
ok("R1.3.3 固件侧：超时动作（休眠 / 关机）可配",
   settingsH.indexOf("#define SETT_ACTION_OFF") >= 0
   && settingsH.indexOf("timeout_action") >= 0
   && mainC.indexOf("settings_set_timeout_action") >= 0
   && mainC.indexOf("settings_set_wake_show") >= 0);
ok("R1.3.3 固件侧：关机 = 拉低自锁脚 GPIO2",
   powerC.indexOf("void power_self_lock_off(void)") >= 0
   && powerC.indexOf("gpio_set_level((gpio_num_t)PIN_SELF_LOCK, 0)") >= 0
   && mainC.indexOf("power_self_lock_off();") >= 0);
ok("R1.3.3 固件侧：定时唤醒自动切图（默认开）",
   settingsC.indexOf(".wake_show   = 1") >= 0
   && mainC.indexOf("s_wake_src == WAKE_SRC_TIMER && settings_get()->wake_show") >= 0
   && mainC.indexOf("timer wake: auto carousel next") >= 0);
ok("R1.3.3 页面：电源管理（超时动作 + 唤醒后切图 + 自锁提示）",
   page.indexOf("超时动作") >= 0 && page.indexOf('id="actionSel"') >= 0
   && page.indexOf('id="wakeShow"') >= 0 && page.indexOf("高电平自锁") >= 0
   && js.indexOf("function syncPowerUI()") >= 0
   && js.indexOf("timeout_action: $(\"actionSel\").value") >= 0);
ok("R1.3.3 契约：电源管理 §5.3 与设置字段已记录",
   contract.indexOf("### 5.3 电源管理") >= 0
   && contract.indexOf("`timeout_action`") >= 0
   && contract.indexOf("`wake_show`") >= 0);
ok("R1.3.0 页面：缩略随帧上传（buildThumbJpeg + &tlen= + 缩略头 fmt=2）",
   js.indexOf("function buildThumbJpeg()") >= 0 && js.indexOf("&tlen=") >= 0
   && js.indexOf("hdr[2] = 2;") >= 0);
ok("R1.3.0 页面：图库四接口 + 整帧解码/旋转渲染",
   js.indexOf('api("/api/carousel/list")') >= 0
   && js.indexOf('api("/api/carousel/full?slot=" + slot)') >= 0
   && js.indexOf('api("/api/carousel/delete?slot=" + slot)') >= 0
   && js.indexOf('api("/api/carousel/clear")') >= 0
   && js.indexOf("function decodeFrame(payload, w, h)") >= 0
   && js.indexOf("function renderFrameToCanvas(canvas, payload, w, h, rot)") >= 0);
ok("主帧头仍固定 hdr[2]=1（fmt=2 只用于缩略头）",
   js.indexOf("hdr[2] = 1;") >= 0);
ok("R1.3.0 CONTRACT 已同步轮播契约",
   contract.indexOf("### 1.1 随帧携带的缩略载荷") >= 0
   && contract.indexOf("/api/carousel/list") >= 0
   && contract.indexOf("store_count") >= 0
   && contract.indexOf("version = " + VER) >= 0);

ok("R1.3.4 固件：删除改为 NVS alive 位图（O(1)，搬移循环已删除）",
   storeC.indexOf("#define KEY_ALIVE") >= 0
   && storeC.indexOf("static int st_idx2phys(int idx)") >= 0
   && storeC.indexOf("int store_slot_phys(int idx)") >= 0
   && storeC.indexOf("int nc = st_popcount8(nav);") >= 0
   && storeC.indexOf("for (int j = slot + 1;") < 0);
ok("R1.3.4 固件：读取路径全部经逻辑→物理换算（不再直算偏移）",
   (storeC.match(/int phys = st_idx2phys\(slot\);/g) || []).length === 4
   && mainC.indexOf("int phys = store_slot_phys(i);") >= 0
   && mainC.indexOf("int phys = store_slot_phys(slot);") >= 0
   && mainC.indexOf("(uint32_t)i * STORE_SLOT_SZ") < 0);
ok("R1.3.4 固件：老设备 alive 位图自动迁移 + count 以位图为准",
   storeC.indexOf("alive bitmap created from count=") >= 0
   && storeC.indexOf("((1u << c) - 1u) & mask") >= 0
   && storeC.indexOf("int c = st_popcount8(s_alive);") >= 0);
ok("R1.3.4 契约：§9 槽位映射（alive 位图 / 逻辑序号 / 零擦写）已记录",
   contract.indexOf("槽位映射（R1.3.4）") >= 0
   && contract.indexOf("store_slot_phys") >= 0
   && contract.indexOf("flash 零擦写") >= 0);
ok("R1.3.4 契约：§6.2 保留位（删除状态码 404/503/500 + bat_mv 语义）已记录",
   contract.indexOf("### 6.2 状态码与 `bat_mv` 语义") >= 0
   && contract.indexOf("#### 6.2.1") >= 0
   && contract.indexOf("#### 6.2.2") >= 0
   && contract.indexOf("no such slot") >= 0
   && contract.indexOf("busy") >= 0);

console.log(failed === 0 ? "SMOKE: ALL PASS" : ("SMOKE: " + failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
