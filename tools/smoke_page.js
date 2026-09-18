// smoke_page.js —— 页面冒烟测试（Node）。
// 抽取 page/index.html 主脚本的纯函数段（算法 + 打包 + 帧头），在最小 sandbox 里跑断言。
// 覆盖：CRC16 金标准、帧头 16 字节字段、packIdx 纯色打包、
//       R1.0.12 结构（Cropper 内嵌 / 文字对象 / 留白 / 双 script 闭合符）。
//
// 用法：node tools/smoke_page.js   （tools/ 下已有 package.json 声明 commonjs）
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const page = fs.readFileSync(path.join(__dirname, "..", "page", "index.html"), "utf8");
// R1.0.12 起页面有两个 <script> 块（第 1 块 = 内嵌 Cropper.js，第 2 块 = 主脚本）。
const m = page.match(/<script>\n"use strict";\n([\s\S]*?)\n<\/script>/);
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
// R1.0.12 起 = 2 个合法闭合符（内嵌 Cropper 块 + 主脚本块），多一个都不行。
eq("script closer count (cropper + main = exactly 2)", (page.match(/<\/script>/g) || []).length, 2);
ok("cropper.js inlined (first script block)", /<script>\s*\n?\/\* ===== Cropper\.js v1\.6\.2/.test(page));
ok("startup block intact (loadSettings call present)", /loadSettings\(\)/.test(js));
// R1.0.12 结构检查
ok("page version = R1.0.22", /moink-page-version" content="R1\.0\.22"/.test(page));
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

console.log(failed === 0 ? "SMOKE: ALL PASS" : ("SMOKE: " + failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
