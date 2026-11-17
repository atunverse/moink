// smoke_page.js —— 页面冒烟测试（Node）。
// 抽取 page/index.dev.html 主脚本的纯函数段（算法 + 打包 + 帧头），在最小 sandbox 里跑断言。
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

const page = fs.readFileSync(path.join(__dirname, "..", "page", "index.dev.html"), "utf8");
const prod = fs.readFileSync(path.join(__dirname, "..", "page", "index.html"), "utf8");
const captive = fs.readFileSync(path.join(__dirname, "..", "src", "captive.c"), "utf8");
const netifAp = fs.readFileSync(path.join(__dirname, "..", "src", "netif_ap.c"), "utf8");
// R1.2.2：引脚运行时代化 / GPIO 预设 / 自锁脚 需在固件侧交叉校验
const settingsH = fs.readFileSync(path.join(__dirname, "..", "src", "settings.h"), "utf8");
const epdDrvC = fs.readFileSync(path.join(__dirname, "..", "src", "epd_drv.c"), "utf8");
const epdDrvH = fs.readFileSync(path.join(__dirname, "..", "src", "epd_drv.h"), "utf8");
const sdkconfig = fs.readFileSync(path.join(__dirname, "..", "sdkconfig.moink"), "utf8");
const mainC = fs.readFileSync(path.join(__dirname, "..", "src", "main.c"), "utf8");
const powerC = fs.readFileSync(path.join(__dirname, "..", "src", "power.c"), "utf8");
// 版本号动态取自 version.h，避免每次升版都要改断言
const versionH = fs.readFileSync(path.join(__dirname, "..", "src", "version.h"), "utf8");
const VER = (/#define\s+MOINK_VERSION\s+"([^"]+)"/.exec(versionH) || [])[1] || "";
/* 本地批次标识（R1.4.0-1 / -2 …）不算版本号本体：契约与文档只记主线号。 */
const VER_BASE = VER.replace(/-\d+$/, "");
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
// R1.4.0 起 = 2 个合法闭合符（主脚本块 + 页脚版本填充块）：构图自己实现后不再内嵌 Cropper。
eq("script closer count (footer + main = exactly 2)", (page.match(/<\/script>/g) || []).length, 2);
ok("R1.4.0-3 offline export removed (页面不再单独发布)",
   page.indexOf("下载离线客户端") < 0 && js.indexOf("saveOffline") < 0);
// R1.4.0：构图改为「固定照片 + 取景框」，Cropper.js 整个移除（省 41KB，也不再有两套缩放交互）
ok("cropper.js removed", page.indexOf("Cropper.js v1.6.2") < 0 && js.indexOf("new Cropper(") < 0);
ok("startup block intact (loadSettings call present)", /loadSettings\(\)/.test(js));
// R1.0.12 结构检查
ok("page version meta present (R1.x.y)", /moink-page-version" content="R1\.\d+\.\d+(-\d+)?"/.test(page));
// 10. R1.0.18 UI 重构：齿轮入口 / 返回按钮 / 无页签 / 步骤条 / 设备信息网格 / 分栏 / 文案
ok("R1.0.18 gear + back nav present", page.includes('id="gearBtn"') && page.includes('id="backBtn"'));
ok("mobile viewport zoom disabled, viewfinder owns its gestures",
   page.includes('maximum-scale=1, user-scalable=no')
   && page.includes('touch-action:pan-x pan-y')
   && js.includes('document.addEventListener("gesturestart", stopViewportGesture, { passive:false })')
   && js.includes('document.addEventListener("gesturechange", stopViewportGesture, { passive:false })')
   && page.includes('cursor:move; touch-action:none'));   /* 取景框自己接管拖动，页面不再缩 */
ok("R1.0.18 tab bar removed", page.indexOf('data-t="image"') < 0 && page.indexOf('id="tabs"') < 0);
ok("R1.0.18 subtitle", page.includes("把喜欢的瞬间，放在身边"));
ok("R1.0.18 header version line removed", page.indexOf('id="i-fw"') < 0);
ok("R1.0.18 dev copy cleaned (no 预览已跑通/预览还没跑通)",
   page.indexOf("预览已跑通") < 0 && page.indexOf("预览还没跑通") < 0);
// R1.4.0：步骤条整体删除，改由底栏 + 上滑面板承担导航
ok("R1.4.0 steps bar removed (nav moved to dock)",
   !page.includes('id="steps"') && js.indexOf("updateSteps") < 0);
ok("R1.0.18 infoGrid device info", page.includes('class="infoGrid"'));
// R1.4.0：双栏卡片改为单栏 App 骨架（画布 + 面板 + 底栏）
ok("R1.4.0 single-column app shell",
   page.includes('id="stage"') && page.includes('id="sheet"') && page.includes('id="dock"')
   && !page.includes('id="editorGrid"') && !page.includes('id="editRight"'));
ok("R1.0.21 mode desc removed", page.indexOf("\u50cf\u62cd\u7acb\u5f97\u4e00\u6837") < 0 && page.indexOf("\u5199\u70b9\u60f3\u8bf4\u7684") < 0 && page.indexOf("modeDesc") < 0 && js.indexOf("MODE_DEF") < 0);
ok("R1.0.19 image h2 removed", page.indexOf("选图 · 裁剪 · 上传") < 0);
ok("R1.0.19 autoPush fully removed", js.indexOf("scheduleAutoPush") < 0 && page.indexOf("autoPushRow") < 0 && js.indexOf("cfg.autoPush") < 0);
ok("R1.0.19 four-color stroke/bg/tbg/objbg", page.includes("黄边") && page.includes("红边") && page.includes("黄底") && page.includes("红底"));
ok("R1.0.19 dither hint wired", page.includes('id="dmodeHint"') && js.indexOf("DMODE_HINT") >= 0);
ok("R1.4.1 pad no longer uses per-side checkboxes",
   page.indexOf('id="padTOn"') < 0 && js.indexOf("function padSideVal") < 0);
ok("R1.0.20 numeric-only display (no units)", js.indexOf("return s + c.unit") < 0 && js.indexOf('v * 100 : v') >= 0);
ok("R1.0.20 textarea always editable", js.indexOf('tObjBg","txt') < 0);
ok("R1.4.0 mode switch only toggles visibility",
   js.indexOf('classList.toggle("empty"') >= 0 && js.indexOf("initCrop(); else destroyCrop();") >= 0);
// R1.4.0：留白并入「特效 → 边框 → 白边」，不再有独立的「启用留白」开关
ok("R1.4.5 custom white edge retired (no pad sliders / lock / frame group)",
   page.indexOf('id="padT"') < 0 && page.indexOf('id="padB"') < 0
   && page.indexOf('id="padL"') < 0 && page.indexOf('id="padR"') < 0
   && page.indexOf('id="padLock"') < 0
   && js.indexOf("var PAD_IDS = ") < 0 && js.indexOf("function applyPad") < 0
   && js.indexOf("function syncPadUI") < 0 && js.indexOf("function drawFrame") < 0
   && js.indexOf("function drawPadMask") < 0 && js.indexOf("function layoutPadMask") >= 0
   && page.indexOf('data-l2="边框"') < 0);
ok("R1.4.6 templates are six L3 options (花边 removed)",
   page.indexOf('data-l3="细边框" data-act="tplLine"') >= 0
   && page.indexOf('data-l3="拍立得" data-act="tplPolaroid"') >= 0
   && page.indexOf('data-l3="花边"') < 0 && js.indexOf("tplFlower") < 0
   && page.indexOf('data-l3="拼图" data-act="tplPuzzle"') >= 0
   && page.indexOf('data-l3="票据" data-act="tplTicket"') >= 0
   && page.indexOf('data-l3="胶片" data-act="tplFilm"') >= 0);
// R1.4.11：「系统维护」拆成「更新和恢复」+「其他」，两者都是第 2 栏的下拉项，
// 和 电源管理 / 热点设置 同级；不再有单独的「系统维护」分组。
ok("R1.4.0-3 维护区只剩「更新和恢复」（其他已并入屏幕）",
   /<summary>\s*更新和恢复/.test(page)
   && !/<summary>\s*其他/.test(page)
   && !/系统维护/.test(page));
ok("R1.4.0 upload jumps into compose",
   js.indexOf("autoCompose = true") >= 0
   && js.indexOf('if (autoCompose)') >= 0
   && js.indexOf('openTool("compose")') >= 0);
ok("R1.4.0 sheet collapses fully (flex min-height fix)",
   /#sheet\{[^}]*min-height:0/.test(page));

// R1.4.0 换模型：照片固定、只动取景框。
// 契约：①构图状态存原图像素（不与容器尺寸耦合，面板开合多少次都不漂）；
//       ②照片只按 contain 定位，不缩放不平移；③取景框是唯一的交互入口（拖动 + 四角缩放）。
ok("R1.4.0 fixed photo, moveable viewfinder",
   js.indexOf("function cropMetrics") >= 0
   && js.indexOf("function cropRender") >= 0
   && js.indexOf("function cropMaxW") >= 0
   && page.indexOf('id="cropBox"') >= 0
   && page.indexOf('data-h="nw"') >= 0
   && js.indexOf('addEventListener("pointerdown", cropDown)') >= 0
   && js.indexOf("zoomOnTouch") < 0        /* 图像捏合缩放必须彻底消失 */
   && js.indexOf("cropRatio") < 0);
ok("R1.0.21 bg selects merged row", page.indexOf('id="tbgRow"') < 0 && js.indexOf("tbgRow") < 0 && page.indexOf('id="objBgRow"') >= 0);
ok("R1.0.19 text add no auto-create", js.indexOf('text:"新文字"') < 0 && js.indexOf("请先输入文字") >= 0);
ok("R1.0.19 offline lab hint removed", page.indexOf("\u79bb\u7ebf\u5ba2\u6237\u7aef\u5bfc\u51fa\u4e3a\u5b9e\u9a8c\u6027\u529f\u80fd") < 0);
ok("R1.0.19 gamma unit + signed b/c", page.indexOf('unit:"\u00d7"') >= 0 && js.indexOf("fmtCtrl") >= 0);
// R1.0.22 修复与清理
ok("R1.0.22 upload error precedence + timeout",
   js.indexOf('xhr.responseText || ("HTTP " + xhr.status)') >= 0 && js.indexOf("xhr.timeout = 30000") >= 0);
// R1.4.3：颜色统一成色点行（描边色 / 文字色 / 底色 / 图标色同一套组件）
ok("R1.4.3 color rows are dots (no color selects)",
   page.indexOf('id="rowStrokeC"') >= 0 && page.indexOf('id="rowTextC"') >= 0
   && page.indexOf('<div class="swRow" id="objBgRow"') >= 0
   && page.indexOf('<div class="swRow" id="noteBgRow"') < 0   /* R1.4.0 已删：纸底归配色面板 */
   && page.indexOf('<div class="swRow" id="stkColors"') >= 0
   && page.indexOf('id="tStrokeC"') < 0 && page.indexOf('id="tColor"') < 0
   && page.indexOf('id="tObjBg"') < 0 && page.indexOf('id="tBg"') < 0
   && js.indexOf("function paintSw(id, v)") >= 0 && js.indexOf("function bindObjSw(id, key)") >= 0
   && js.indexOf("function syncSw()") >= 0);
ok("R1.0.22 pointerId guard", js.indexOf("pid:e.pointerId") >= 0 && js.indexOf("e.pointerId !== od.pid") >= 0);
ok("R1.4.0-3 屏幕设置：上下旋转（页面侧 180°）+ 清理残影移入屏幕",
   page.indexOf('id="vrot"') >= 0
   && page.indexOf('id="clearBtn"') >= 0
   && page.indexOf('id="hflip"') < 0
   && js.indexOf("function rot180Payload") >= 0
   && js.indexOf("if (cfg.vrot) p = rot180Payload(p, PANEL.w, PANEL.h);") >= 0
   && js.indexOf('cfg.vrot = $("vrot").checked ? 1 : 0;') >= 0);
ok("R1.0.22 EXIF revoke timing fixed",
   js.indexOf("im2.onload = function(){ URL.revokeObjectURL(url); adoptImg(im2, u2, f); };") >= 0);
// 9. R1.0.17 EXIF 归一 + 换图重置旋转 + 文字开关过滤
ok("R1.0.17 exifOrientation present", /function exifOrientation\(/.test(page));
ok("R1.0.17 cropRot reset on adoptImg", /curRot = 0; cfg\.cropRot = 0; syncRotUI\(\);/.test(page));
ok("R1.4.1 text layer always on (no checkbox)", js.indexOf("cfg.textOn") < 0 && page.indexOf('id="textOn"') < 0);
ok("text object system (drawObjs + normObjs)", js.indexOf("function drawObjs") >= 0 && js.indexOf("function normObjs") >= 0);
ok("padding module (contentRect/contentAR)", js.indexOf("function contentRect") >= 0 && js.indexOf("function contentAR") >= 0);
ok("cropper bridge (initCrop/getCropCanvas)", js.indexOf("function initCrop") >= 0 && js.indexOf("function getCropCanvas") >= 0);
ok("R1.4.0 取景框微调 ±45 + 照片整格 90°",
   js.indexOf("CROP_MAX_ROT = 45") >= 0 && page.indexOf('max="45"') >= 0
   && js.indexOf("function rotSnap") < 0
   && js.indexOf("function rotateQuarter") >= 0
   && js.indexOf("function imgUpright") >= 0
   && page.indexOf('data-act="rotL"') >= 0 && page.indexOf('data-act="rotR"') >= 0);

// R1.4.1：面板改成「二级分组 + 三级选项」两层，一屏只显示一个控件。
// 结构契约：.pane > .grp[data-l2] > .box[data-l3]，选项条按这份 DOM 生成；
// 旧的 .tabs / data-look 页签体系必须彻底消失（两套并存会互相打脸）。
ok("R1.4.1 two-level option bars (L2/L3) present",
   page.includes('id="l2bar"') && page.includes('id="l3bar"')
   && js.indexOf("function showLvl") >= 0
   && js.indexOf("function lvlGroups") >= 0
   && js.indexOf("function lvlRow") >= 0
   && js.indexOf("function initTabs") < 0
   && page.indexOf("data-look=") < 0 && page.indexOf('id="colorTabs"') < 0
   && page.indexOf('id="fxTabs"') < 0);
ok("R1.4.1 compose groups 取景 / 照片方向 / 角度微调",
   page.indexOf('data-l2="取景"') >= 0
   && page.indexOf('data-l2="照片方向"') >= 0
   && page.indexOf('data-l2="角度微调"') >= 0
   && page.indexOf('data-act="cropMax"') >= 0
   && page.indexOf('data-act="cropCenter"') >= 0
   && page.indexOf('data-act="rotZero"') >= 0);
ok("R1.4.2 color groups: style first, plain names",
   page.indexOf('data-l2="风格"') < page.indexOf('data-l2="基础"')
   && page.indexOf('data-l2="高级（"') < 0 && page.indexOf('data-l2="抖动（"') < 0
   && page.indexOf('data-l2="高级"') >= 0 && page.indexOf('data-l2="抖动"') >= 0
   && page.indexOf('data-l3="亮度"') >= 0 && page.indexOf('id="ctrls-brightness"') >= 0
   && js.indexOf('$("coreLab").textContent') >= 0);
ok("R1.4.2 gray / naive presets hide the strength slider",
   page.indexOf('id="coreRow"') >= 0 && js.indexOf('row.style.display = m.key ? "" : "none"') >= 0);
ok("R1.4.5 fx groups 模板 / 文字 / 日期 / 贴纸",
   page.indexOf('data-l2="模板"') >= 0 && page.indexOf('data-l2="文字"') >= 0
   && page.indexOf('data-l2="贴纸"') >= 0 && page.indexOf('data-l2="边框"') < 0
   && page.indexOf('data-l2="添加"') < 0
   && page.indexOf('data-l3="字体"') >= 0 && page.indexOf('data-l3="描边"') >= 0
   && page.indexOf('data-l3="填充"') >= 0 && page.indexOf('data-l3="底色"') >= 0
   /* R1.4.9：日期升为独立二级菜单，不再挂在「文字」下面，也没有「添加日期」按钮 */
   && page.indexOf('data-l2="日期"') >= 0 && page.indexOf('id="dateAdd"') < 0);
ok("R1.4.2 size / width / rotate only on canvas handles",
   page.indexOf('data-l3="大小"') < 0 && page.indexOf('data-l3="宽度"') < 0
   && page.indexOf('data-l3="方向"') < 0
   && /class="hconly"/.test(page)
   && page.indexOf('id="tSize"') >= 0 && page.indexOf('id="tWrap"') >= 0
   && page.indexOf('id="tRot"') >= 0);
ok("R1.4.5 templates only set cfg.tpl (no pad, no baked text)",
   js.indexOf("function tplApply") >= 0 && js.indexOf("var TPL = {") >= 0
   && js.indexOf('cfg.tpl = name') >= 0
   && js.indexOf("function tplPad") < 0 && js.indexOf("var TPL_DEF") < 0
   && js.indexOf("o.tpl = name") < 0);
// R1.4.9 起面板高度改成固定值：原来「按内容自适应」会让画布随选项忽大忽小。
// 这条断言改为钉住「固定高度 + min-height:0」——后者是防 flex 子项按内容撑开、
// max-height 压不住的老 bug（当时表现是面板收起后仍占高度）。
// R1.4.10：面板高度回到「跟内容走」（内容少就不留白），
// 画布尺寸由固定基准高度决定 —— 两件事分开，画面才不会跟着面板跳。
ok("R1.4.10 sheet height follows content, canvas uses a fixed basis",
   /#sheet\.up\{[^}]*height:auto[^}]*max-height:38%/.test(page)
   && /function stageBaseH\(\)\{/.test(js)
   && /var ah = stageBaseH\(\);/.test(js)
   && /wrap\.style\.top = Math\.round\(8 \+ ah \/ 2\)/.test(js)
   && /\.panes\{[^}]*min-height:0/.test(page));
ok("R1.4.0-4 option bars: content-width, no ellipsis truncation",
   /\.lvl\{[^}]*justify-content:center/.test(page)
   && /\.lvl b\{[^}]*min-width:max-content/.test(page)
   && !/\.lvl b\{[^}]*text-overflow:ellipsis/.test(page));
ok("R1.4.0-4 保存页一屏看全（面板加高 + 图槽定高）",
   /#sheet\.up\[data-panel="save"\]\{[^}]*max-height:calc\(100% - var\(--brand-h\)/.test(page)
   && /#sheet\[data-panel="save"\] \.galCell\{ aspect-ratio:auto; height:76px; \}/.test(page));
ok("R1.4.0-4 不超时隐藏超时动作 + 自动唤醒",
   page.indexOf('id="actionRow"') >= 0
   && js.indexOf('var never = ($("sleepSel").value === "0");') >= 0
   && js.indexOf('$("actionRow").style.display = never ? "none" : "";') >= 0
   && js.indexOf('$("sleepSel").addEventListener("change", syncPowerUI);') >= 0);
ok("R1.4.0-4 远程图槽：账号口径不再点名 WebDAV",
   page.indexOf('placeholder="账号（可空）"') >= 0
   && page.indexOf("WebDAV 账号") < 0
   && page.indexOf("存到远程（WebDAV）") < 0);
ok("R1.4.1 single L3 item hides the L3 row",
   js.indexOf("g.items.length > 1") >= 0);
ok("R1.4.1 text rotate + width wired (no undefined rotSnap)",
   js.indexOf("function snapTextRot") >= 0 && js.indexOf("rotSnap(") < 0
   && page.indexOf('id="tWrap"') >= 0 && js.indexOf('$("tWrap").addEventListener("input"') >= 0);
// R1.4.3：贴纸分三级（图标 / 表情 / 上传图片）—— 颜色只作用于图标，
// 表情格里的「＋」排在最前并弹输入框，上传图片排在最后且只在本页有效。
ok("R1.4.3 stickers split into 图标 / 表情 / 上传图片",
   page.indexOf('data-l3="图标"') >= 0 && page.indexOf('data-l3="表情"') >= 0
   && page.indexOf('data-l3="上传图片"') >= 0
   && page.indexOf('id="stkRow"') > page.indexOf('data-l3="图标"')
   && page.indexOf('id="stkEmo"') > page.indexOf('data-l3="表情"')
   && page.indexOf('id="stkUp"') > page.indexOf('data-l3="上传图片"')
   && page.indexOf('id="stkUp"') > page.indexOf('id="stkEmo"')
   && page.indexOf('id="stkColors"') < page.indexOf('id="stkRow"')
   && js.indexOf('$("stkEmo").appendChild(emoAddCell())') >= 0
   && js.indexOf('b.id = "stkEmoAdd"') >= 0
   && page.indexOf('id="emoPop"') >= 0 && page.indexOf('id="stkEmoIn"') >= 0
   && js.indexOf("function openEmoPop()") >= 0
   && js.indexOf("function addStkGlyph") >= 0 && js.indexOf("function addStkEmoji") >= 0
   && js.indexOf("function addStkImg") >= 0
   && js.indexOf('kind: "glyph"') < 0 && js.indexOf('kind:"glyph"') >= 0
   && js.indexOf("function stkPaint") >= 0 && js.indexOf("EMOJI_FONT") >= 0
   /* 表情格不参与染色：stkPaint 只扫 #stkRow，画布里 emoji 走黑色填充 */
   && js.indexOf('querySelectorAll("#stkRow .stkCell")') >= 0
   && js.indexOf('querySelectorAll("#stkEmo .stkCell")') < 0
   && js.indexOf('ctx.fillStyle = "#000"') >= 0);
// R1.4.3：风格预设居中；字体改成一行胶囊 + 右侧上传；点画布对象直接进对应面板
ok("R1.4.3 style presets centered",
   /<div class="row center" id="presets"/.test(page)
   && /\.row\.center\{[^}]*justify-content:center/.test(page));
ok("R1.4.3 font chips + local font upload",
   page.indexOf('class="chips" id="tFontRow"') >= 0 && page.indexOf('id="tFontUp"') >= 0
   && page.indexOf('id="fontFile"') >= 0 && page.indexOf('id="tFont"') >= 0
   && js.indexOf("function renderFontChips()") >= 0
   && js.indexOf("function fontAvail(fam)") >= 0
   && js.indexOf("FONT_CAND.forEach") >= 0
   && js.indexOf("new FontFace(fam, fr.result)") >= 0
   && js.indexOf("document.fonts.add(loaded)") >= 0
   && js.indexOf("pickFont(addFontEntry(") >= 0);
ok("R1.4.3 tapping a canvas object opens its own panel",
   js.indexOf("function focusObj(i)") >= 0 && js.indexOf("function gotoLvl(t, grp, l3)") >= 0
   && js.indexOf('gotoLvl("fx", "贴纸", k)') >= 0
   && js.indexOf('gotoLvl("fx", "文字", "文字")') >= 0
   && js.indexOf("if (objTapMoved){ objTapMoved = false; return; }") >= 0
   && js.indexOf("objTapMoved = true") >= 0);
ok("R1.4.3 every color row is label-first dots",
   /\.swRow > span\{[^}]*margin-right/.test(page)
   && page.indexOf('<span>图标颜色</span>') >= 0
   && page.indexOf('<span>描边色</span>') >= 0
   && page.indexOf('<span>文字色</span>') >= 0
   && page.indexOf('<span>文字底色</span>') >= 0
   && page.indexOf('<span>屏幕底色</span>') < 0);   /* R1.4.0 已删 */

ok("R1.4.3 dropdowns became chip rows (one look for every option row)",
   page.indexOf('class="chipRow" id="dmodeRow"') >= 0
   && page.indexOf('class="chipRow" id="spaceRow"') >= 0
   && page.indexOf('<select id="dmode" style="display:none">') >= 0
   && page.indexOf('<select id="space" style="display:none">') >= 0
   && js.indexOf("function paintChips(selId, rowId)") >= 0
   && js.indexOf('paintChips("dmode","dmodeRow")') >= 0
   && js.indexOf('paintChips("space","spaceRow")') >= 0);

ok("R1.4.1 canvas click no longer hijacks the open tool",
   js.indexOf("if (curTool) return;") >= 0);
// R1.4.0：留白 = 盖在照片上的一层白（蒙版），不是缩画布 —— 改特效不再动取景框
ok("R1.4.5 templates are overlay masks only, crop untouched",
   js.indexOf("function tplMaskOut") >= 0
   && js.indexOf("drawTpl(ctx, cw, ch)") >= 0
   && /function contentRect\(\)\{ return \{ x:0, y:0, w:EW, h:EH \}; \}/.test(js)
   && js.slice(js.indexOf("function tplApply("), js.indexOf("function tplApply(") + 600)
        .indexOf("clampCrop()") < 0
   && page.indexOf('id="cropPadMask"') >= 0);
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
  /* R1.4.0：面板顺序 = 构图 → 调色 → 特效 → 保存（与底栏一致） */
  const o1 = page.indexOf('data-pane="compose"'), o2 = page.indexOf('data-pane="color"'),
        o3 = page.indexOf('data-pane="fx"'),      o4 = page.indexOf('data-pane="save"');
  ok("pane order compose < color < fx < save", o1 >= 0 && o1 < o2 && o2 < o3 && o3 < o4);
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
ok("R1.3.6 固件侧：自锁改由供电判据决定 + /api/reboot + 无 a1_mode",
   mainC.indexOf("power_lock_gpio_init();") >= 0
   && mainC.indexOf("power_lock_boot();") >= 0
   && mainC.indexOf("gpio_set_level((gpio_num_t)PIN_SELF_LOCK, 1);") < 0
   && mainC.indexOf('"/api/reboot"') >= 0 && mainC.indexOf("epd_set_a1_mode") < 0);
ok("R1.3.6 固件侧：冷启动只认按键（判据内不读电压）+ 轮询 4.5 V/3 次去抖",
   mainC.indexOf("power_usb_monitor_start();") >= 0
   && powerC.slice(powerC.indexOf("bool power_lock_boot"),
                   powerC.indexOf("void power_lock_release")).indexOf("power_vsys_mv") < 0
   && powerC.indexOf("#define USB_MV_THRESHOLD  4500") >= 0
   && powerC.indexOf("#define USB_HITS_NEED     3") >= 0
   && powerC.indexOf("gpio_set_level((gpio_num_t)PIN_SELF_LOCK, s_lock_want ? 1 : 0);") >= 0);
ok("R1.3.6/R1.4.0 固件侧：只有 FPC 老排线轮询 + 老排线电池态禁休眠",
   powerC.split("!(st->gpio_preset == GPIO_PRESET_LINE && st->line_ver == LINE_VER_OLD)").length - 1 === 2
   && mainC.indexOf("st->line_ver == LINE_VER_OLD") >= 0
   && mainC.indexOf("power_self_locked()") >= 0
   && settingsC.indexOf('read_u8("line_v"') >= 0
   && settingsH.indexOf("#define LINE_VER_NEW      1") >= 0);
ok("R1.3.6 页面：排线版本勾选 + line_v 提交 + 仅排线档显示",
   page.indexOf('id="lineNew"') >= 0
   && page.indexOf("syncLineVer") >= 0
   && page.indexOf('line_v: $("lineNew").checked ? 1 : 0') >= 0
   && page.indexOf('(v === "1") ? "" : "none"') >= 0);
// R1.2.2：升级不再全量重置设置，只清理本版已废弃的键（a1_mode / a11_var）。
const rfu = settingsC.slice(settingsC.indexOf("void settings_reset_for_upgrade"));
ok("R1.2.2 固件侧：升级只清废弃键、不重置用户设置",
   rfu.indexOf("DROP_KEYS") >= 0 && rfu.indexOf('"a1_mode"') >= 0
   && rfu.indexOf('"a11_var"') >= 0 && rfu.indexOf("s_cfg = DEFAULTS") < 0
   && rfu.indexOf('"sleep_s"') < 0);
// R1.2.0（FB-015）：版本号由 fw/page 两套合并为 MOINK_VERSION 一套；
//   固件与控制页合并到同一入口 /api/upload，由固件按请求体首块内容嗅探分流。
ok("R1.2.0/R1.4.0 统一升级入口 UI (upFile/upGo/upmsg，只收 .bin)",
   page.includes('id="upFile"') && page.includes('id="upGo"')
   && page.includes('class="savestate" id="upmsg"')
   && page.includes('accept=".bin"') && !page.includes('accept=".bin,.html,.htm"')
   && !page.includes('id="webClear"'));   /* R1.4.0：页面热更整体移除 */
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
   && js.indexOf("var p = packIdx(rotateCW(renderComposite(EW, EH), EW, EH));") >= 0);
ok("R1.2.1 上传前显示 loading",
   page.indexOf('id="workLoading"') >= 0 && page.indexOf('id="workLoadingText"') >= 0
   && js.indexOf("function afterLoadingPaint(fn)") >= 0
   && js.indexOf('showWorkLoading("正在生成上传数据…")') >= 0
   && js.indexOf('afterLoadingPaint(function(){ buildAndUpload("show"); })') >= 0);
ok("R1.4.0 取景框松手后才重算预览",
   /function cropUp\(\)\{[^}]*cropInvalid\(\);\s*schedulePreview\(false\);/.test(js));
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
   && js.indexOf('if (!o){ txtEl.value = "";') >= 0);
ok("文字拖动缓存静态画布、文字度量和缩放，并保留对象叠放顺序",
   js.indexOf("liveBase = renderLiveBase(EW, EH, od ? od.i : -1)") >= 0
   && js.indexOf("function ensureObjHandles(el)") >= 0
   && js.indexOf('if (el.querySelector(".hnd")) return') >= 0
   /* R1.4.10：改用手柄布局比例 od.fs（不含画布显示缩放），位移用 od.scale */
   && js.includes('if (od) relayoutOne(od.i, od.act === "m" || od.act === "r", od.fs || od.scale)')
   && js.includes('ctx.drawImage(liveBase, 0, 0)')
   && js.includes('if (liveAbove) ctx.drawImage(liveAbove, 0, 0)')
   && js.includes('liveMetric = o ? objMetrics(o, 1) : null')
   && js.includes('scale:dragScale') && js.includes('var s = od.scale')
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
   && frameC.indexOf("bool want_save = false, want_show = true, want_remote = false;") >= 0);

/* ---- R1.4.0：远程图槽 + 实验 120Hz ---- */
ok("R1.4.0 固件侧：远程图槽（net_fetch.c / /api/remote / save=remote）",
   fs.existsSync(path.join(__dirname, "..", "src", "net_fetch.c"))
   && fs.existsSync(path.join(__dirname, "..", "src", "net_fetch.h"))
   && mainC.indexOf('"/api/remote"') >= 0
   && frameC.indexOf('"remote"') >= 0
   && mainC.indexOf("net_fetch_display()") >= 0
   && mainC.indexOf("net_upload_remote(") === -1 /* 只在 frame.c 调，main 不该直接调 */);

ok("R1.4.0 固件侧：远程失败仍回退本地轮播",
   mainC.indexOf("carousel: remote failed") >= 0
   && mainC.indexOf("fall back to local") >= 0);

// 2026-11-16 实测定案：120 Hz 档（0x07 / 0x0F）与动态档整屏刷新都是 ~15 s，
// 没有收益还惹过 WiFi 事故 → 功能整体移除，PLL 固定原厂动态档。这条断言防止它复活。
ok("R1.4.0 固件侧：120Hz 实验项已整体移除，PLL 固定动态档",
   epdDrvH.indexOf("EPD_PLL_DYNAMIC  0x08") >= 0
   && epdDrvH.indexOf("EPD_PLL_120HZ") < 0
   && epdDrvC.indexOf("epd_set_pll") < 0
   && epdDrvC.indexOf("s_pll") < 0
   && epdDrvC.indexOf("EPD_C1(0x30, EPD_PLL_DYNAMIC)") >= 0
   && mainC.indexOf("exp_pll") < 0
   && settingsH.indexOf("exp_pll") < 0);

ok("R1.4.0 页面：远程图槽卡片（120Hz 勾选已移除）",
   page.indexOf('id="rMode"') >= 0 && page.indexOf('id="rUrl"') >= 0
   && page.indexOf('id="rSync"') >= 0 && page.indexOf('id="rPush"') >= 0
   && page.indexOf('id="exp120"') < 0
   && page.indexOf("save=remote") >= 0);

ok("R1.4.0 契约：§4.4 帧率 / §6.4 远程图槽 / §7 r_* 键已记录",
   contract.indexOf("### 4.4 帧率") >= 0
   && contract.indexOf("### 6.4 远程图槽") >= 0
   && contract.indexOf("`r_mode`") >= 0
   && contract.indexOf("120 Hz 已移除") >= 0);
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
ok("R1.4.0-3 电源默认：关机 + 3 分钟（含一次性迁移）",
   settingsC.indexOf(".timeout_action = SETT_ACTION_OFF,") >= 0
   && settingsC.indexOf(".sleep_s     = SETT_SLEEP_3MIN,") >= 0
   && settingsC.indexOf('read_u8("def2", &def2);') >= 0
   && settingsC.indexOf("defaults migrated") >= 0
   && settingsC.indexOf("s_cfg.hflip = 0;") >= 0);
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
   && page.indexOf('id="wakeShow"') >= 0 && page.indexOf("自锁电路") >= 0
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
   && contract.indexOf("version = " + VER_BASE) >= 0);

ok("R1.3.4 固件：删除改为 NVS alive 位图（O(1)，搬移循环已删除）",
   storeC.indexOf("#define KEY_ALIVE") >= 0
   && storeC.indexOf("static int st_idx2phys(int idx)") >= 0
   && storeC.indexOf("int store_slot_phys(int idx)") >= 0
   && storeC.indexOf("int nc = st_popcount8(nav);") >= 0
   && storeC.indexOf("for (int j = slot + 1;") < 0);
// 2026-11-16：删掉无引用的 store_load_thumb() 后，这里由 4 处变 3 处。
ok("R1.3.4 固件：读取路径全部经逻辑→物理换算（不再直算偏移）",
   (storeC.match(/int phys = st_idx2phys\(slot\);/g) || []).length === 3
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

// R1.4.4：表情输入框默认空白，且只收表情（打进文字会被剔掉）
ok("R1.4.4 emoji box starts empty and only takes emoji",
   page.indexOf('placeholder="这里只收表情符号"') >= 0
   && page.indexOf('placeholder="😀"') < 0
   && js.indexOf("function isEmojiCode") >= 0
   && js.indexOf("function filterEmoji") >= 0
   && js.indexOf("function firstGraphemes") >= 0
   && js.indexOf('这里只放表情，文字请用「文字」') >= 0
   && js.indexOf('$("stkEmoIn").addEventListener("input"') >= 0
   && js.indexOf("var v = filterEmoji(raw.replace(") >= 0
   && js.indexOf("addStkEmoji(firstGraphemes(v, 2))") >= 0
   && js.indexOf("Array.from(v).slice(0, 2).join") < 0);

// R1.4.4：表情 / 上传图片这类位图贴纸和照片走同一条流水线（风格化 + 抖动）
ok("R1.4.4 bitmap stickers share the photo dither pipeline",
   js.indexOf("function isStkRaster") >= 0
   && js.indexOf("function drawStkRaster") >= 0
   && js.indexOf("function stkBox") >= 0
   && js.indexOf("function stkCfg") >= 0
   && js.indexOf("var mapped = warmMap(buf, w, h, stkCfg())") >= 0
   && js.indexOf("c.autoLevels = 1") >= 0
   && js.indexOf("c.coolDesat = 0") >= 0 && js.indexOf("c.coolPull = 0") >= 0
   && js.indexOf("quantize(comp, w, h, cfg, mask)") >= 0
   && js.indexOf("function quantize(mapped, w, h, cfg, mask)") >= 0
   && js.indexOf("function drawObjs(ctx, objs, cw, ch, raster)") >= 0
   && js.indexOf("drawObjs(ctx, objs, cw, ch, true)") >= 0
   && js.indexOf("quantize(warmMap(toBuf(cc)") >= 0);


// R1.4.6：六种边框全部现场绘制；细边框只剩白边、拼图错位、票据邮票孔、胶片竖版
ok("R1.4.6 frames drawn in code (line = white only, ticket no border, film holes landscape)",
   js.indexOf("function tplArtLine") >= 0
   && js.indexOf("function tplArtPolaroid") >= 0
   && js.indexOf("function tplArtFlower") < 0
   && js.indexOf("function tplArtPuzzle") >= 0
   && js.indexOf("function tplArtTicket") >= 0
   && js.indexOf("function tplArtFilm") >= 0
   && js.indexOf("function tplMaskOut") >= 0
   && js.indexOf("var TPL_ART = {") >= 0
   /* 细边框：只遮白，不描边 */
   && js.slice(js.indexOf("function tplArtLine"), js.indexOf("function tplArtPolaroid"))
        .indexOf("stroke") < 0
   /* 拼图：错位横缝（0.40 / 0.62）；白边与缝宽都减半（rect x 边距 0.0225） */
   && js.indexOf("h*0.40") >= 0 && js.indexOf("h*0.62") >= 0
   && js.indexOf("rect:[0.0225, 0.016, 0.955, 0.968]") >= 0
   /* 拍立得：左右上白边减半（x 0.029 / y 0.025），底白保持 0.160 */
   && js.indexOf("rect:[0.029, 0.025, 0.942, 0.815]") >= 0
   /* 票据：四角 1/4 圆挖白 + 黑色半圆齿孔；**不描黑框**，齿孔半径 k*22 */
   && js.slice(js.indexOf("function tplArtTicket"), js.indexOf("function tplArtFilm"))
        .indexOf("stroke") < 0
   && js.indexOf("ctx.arc(cx, 0, pr, 0, Math.PI)") >= 0
   && js.indexOf("k * 22") >= 0
   /* 胶片：正方形轮廓+圆角齿孔（11-17 二次反馈）+ 间距 ph*2.275（前后平均）+ 上 MOINK 下日期 */
   && js.indexOf("bandL") >= 0
   && js.indexOf("var pw = Math.max(8, Math.round(bandW * 0.52))") >= 0
   && js.indexOf("var ph = pw;") >= 0 && js.indexOf("var pitch = Math.round(ph * 2.275)") >= 0
   && js.indexOf("var rad = Math.max(2, Math.round(pw * 0.22))") >= 0
   && js.slice(js.indexOf("function tplArtFilm"), js.indexOf("var TPL_ART"))
        .indexOf("strokeRect") < 0
   && js.indexOf("function tplSeedText") >= 0
   && js.indexOf('text:"MOINK"') >= 0
   && js.slice(js.indexOf("function tplSeedText"), js.indexOf("function tplDropText"))
        .indexOf('type:"date"') >= 0
   && page.indexOf('data-l3="胶片"') >= 0);

ok("R1.4.6 date control: 5x7 round dots / classic 7-segment blocks / fallback font",
   js.indexOf('var DATE_STYLE = { dot:"点阵", seg:"数码管", txt:"普通" }') >= 0
   && js.indexOf("var DOT5 = {") >= 0
   && js.indexOf("function drawSeg7") >= 0
   && js.indexOf("SEG_SLANT") >= 0
   /* 数码管 = 标准 7 段块：只有 a..g 七段，没有斜段、没有 16 段表 */
   && js.indexOf("var SEG7 = {") >= 0
   && js.indexOf("var SEG_PT = {") < 0 && js.indexOf("var SEG_DEF = {") < 0
   && js.indexOf("var SEG_GLYPH = {") < 0
   && js.indexOf("function segGlyph") >= 0
   /* 段块 = 两端斜切的六边形（用户定下的形状，改字形时不许动它） */
   && js.indexOf("function hseg(x1, x2, yc){") >= 0
   && js.indexOf("function vseg(y1, y2, xc){") >= 0
   && js.indexOf("ctx.lineTo(a + half, yc - half)") >= 0
   && js.indexOf("ctx.lineTo(xc + half, a + half)") >= 0
   && js.indexOf("var t = Math.max(2, Math.round(h * 0.145));") >= 0
   && js.indexOf("var g = Math.max(1, Math.round(t * 0.18));") >= 0
   && js.indexOf("var SEG_ASPECT = 0.62;") >= 0
   /* 按需斜切的半成品实现必须不存在 */
   && js.indexOf("cutL") < 0 && js.indexOf("cutT") < 0
   /* 七段字形表抽查：8 = 全七段，0 缺 g，1 = 只有 b c，字母走七段字母表 */
   && js.indexOf('"8":"abcdefg"') >= 0
   && js.indexOf('"0":"abcdef"') >= 0
   && js.indexOf('"1":"bc"') >= 0
   && js.indexOf('"2":"abdeg"') >= 0
   && js.indexOf('"A":"abcefg"') >= 0
   && js.indexOf('"Z":"adg"') >= 0
   /* 同形字必须靠不同段区分（参考表逐格取值，不许回退成「最接近字形」）：
      1=bc 对 I=e；O=cdeg 对 0=abcdef；R=eg 对 K=bdefg 对 H=bcefg；
      V=bfg / W=bdfg 有各自段组合，不再三者同为 U 形 */
   && js.indexOf('"I":"e"') >= 0 && js.indexOf('"J":"bcd"') >= 0
   && js.indexOf('"K":"bdefg"') >= 0 && js.indexOf('"R":"eg"') >= 0
   && js.indexOf('"M":"aceg"') >= 0 && js.indexOf('"O":"cdeg"') >= 0
   && js.indexOf('"Q":"abcfg"') >= 0 && js.indexOf('"S":"cfg"') >= 0
   && js.indexOf('"V":"bfg"') >= 0 && js.indexOf('"W":"bdfg"') >= 0
   && js.indexOf('"X":"bcef"') >= 0
   && js.indexOf("var GLYPH_SRC = {") < 0
   && js.indexOf("function segH") < 0
   && js.indexOf("function dateLayout") >= 0
   && js.indexOf("function dateMetrics") >= 0
   && js.indexOf("function drawDate") >= 0
   && js.indexOf("function addDateObj") >= 0
   && js.indexOf('type:"date"') >= 0
   && js.indexOf('o.type === "date"') >= 0
   /* 手写体与内嵌字库已取消（老存档里的 ink 只留一行迁移） */
   && js.indexOf("INK_FONT") < 0 && js.indexOf("DOT_FONT") < 0
   && js.indexOf('ink:"手写"') < 0
   && js.indexOf('o.style === "ink"') >= 0
   /* 逐字回退：样式里没有的字走回退字体 */
   && js.indexOf("function dateFB") >= 0);

// R1.4.7：日期面板的胶囊行是隐藏 select 的镜像，改完必须回填面板。
// 只写对象、只重绘预览而不 syncSel，胶囊会停在旧值 —— 用户报过
// 「选了数码管，预览框已经改了，但样式选项里还是普通」。
ok("R1.4.7 date style/format changes repaint the chips row",
   /* 窗口放宽到 1200：setDateFmt 里多了「自定义」分支，函数体变长了 */
   /function setDateStyle\(v\)\{[\s\S]{0,1200}?syncSel\(\)/.test(js)
   && /function setDateFmt\(v\)\{[\s\S]{0,1600}?syncSel\(\)/.test(js)
   && /function paintChips\(selId, rowId\)\{/.test(js));

// R1.4.8：日期也是文字控件，文字有的「底色 / 描边（宽度 + 颜色）」它也要有。
// 描边的实现是「同一字形整体外扩」（先描边色放大画一遍，再画本色），
// 不是给每个图元 ctx.stroke() —— 点阵圆点 / 数码管段块贴得太近，描边会把缝糊死。
ok("R1.4.8 date control supports bg + stroke like a text object",
   /* 对象字段（R1.4.9 起改成按样式套预设，字段本体仍是这四个） */
   /type:"date", style:style,/.test(js)
   && /fd:"ymd", ft:"", fmt:""/.test(js)
   && /color:pre\.color, stroke:pre\.stroke, strokeC:pre\.strokeC, bg:pre\.bg/.test(js)
   /* 底色：与文字同一套四色，1白 2黑 3黄 4红 */
   && /if \(\+o\.bg >= 1\)\{[\s\S]{0,320}?ctx\.fillRect\(-lay\.w\/2 - pX/.test(js)
   /* 描边：dot 整数方块外扩一圈（11-17 像素点阵）、seg 沿圆周膨胀、txt strokeText */
   && /var ps = side \+ 2 \* Math\.max\(0, Math\.round\(pen\.w\)\)/.test(js)
   && /ctx\.fillRect\(sx \+ p\*cx \+ ppo, sy \+ p\*ry \+ ppo, ps, ps\)/.test(js)
   /* 数码管描边 = 沿圆周位移重画（膨胀）；绝对不能再用「绕中心放大整字」，那是重影 */
   && /var SE = 12;/.test(js)
   && /ctx\.translate\(Math\.cos\(ag\) \* pen\.w, Math\.sin\(ag\) \* pen\.w\)/.test(js)
   && js.indexOf("(sz + pen.w*2) / sz") < 0
   && js.indexOf("ctx.scale(k, k)") < 0
   && /ctx\.strokeText\(it\.ch, x, yTop \+ sz\/2\)/.test(js)
   /* 面板：滑块的 disabled 规则里日期放行 大小/方向/描边 */
   && /var DATE_OK = \{ tSize:1, tRot:1, tStroke:1 \};/.test(js)
   && /bindSel\("tStroke","stroke","input", true\)/.test(js)
   /* 色点行不能再把日期挡掉 */
   && js.indexOf('if (isDate(o) && key !== "color") return;') < 0
   /* 段块形状仍是用户定下的六边形；11-17 只把段厚量化成整数像素（比例仍是 0.145h） */
   && /function hseg\(x1, x2, yc\)\{/.test(js)
   && /var t = Math\.max\(2, Math\.round\(h \* 0\.145\)\);/.test(js));

// R1.4.9：日期从「文字」里提出来，和模板 / 文字 / 贴纸并列；点选项即加，没有「添加日期」按钮。
// 预设配色：点阵=黑字白底，数码管=红字中粗白描边。
// 另：面板高度固定（画布不再随选项跳变）、状态条空闲隐藏。
ok("R1.4.9 date is its own menu group (tap-to-add, presets, custom text)",
   /* 二级菜单「日期」存在，且日期控件在它下面（在「贴纸」之前） */
   /data-l2="日期"/.test(page)
   && page.indexOf('id="dateStyleRow"') > page.indexOf('data-l2="日期"')
   && page.indexOf('id="dateStyleRow"') < page.indexOf('data-l2="贴纸"')
   /* 「添加日期」按钮已删除 */
   && page.indexOf("dateAdd") < 0
   /* 点样式 / 点格式 → 没选中日期就现场新建 */
   && /function setDateStyle\(v\)\{[\s\S]{0,400}?addDateObj\(/.test(js)
   && /function setDateFmt\(v\)\{[\s\S]{0,400}?addDateObj\(/.test(js)
   /* 预设：点阵黑字白底 / 数码管红字中粗白描边 / 普通不铺底 */
   && /if \(style === "seg"\) return \{ color:3, stroke:3, strokeC:1, bg:0 \};/.test(js)
   && /if \(style === "dot"\) return \{ color:0, stroke:0, strokeC:1, bg:1 \};/.test(js)
   /* 日期 / 时间两张表 + 自定义模式 */
   && /var DATE_FDATE = \{ "":"无", ymd:/.test(js)
   && /var DATE_FTIME = \{ "":"无", s12:/.test(js)
   /* R1.4.11：自定义改成独立三级页，日期格式行里不再有它 */
   && page.indexOf('<option value="custom">自定义</option>') < 0
   && /data-l3="自定义"/.test(page)
   /* 自定义收 字母 / 数字 / 空格 / . - 和回车 */
   && /\[\^A-Za-z0-9 \.\\-\\n\]/.test(js)
   /* 日期自己有描边 / 填充 / 底色三页，且共用同一批字段 */
   && /id="dStroke"/.test(page) && /id="dStrokeCRow"/.test(page)
   && /id="dColorRow"/.test(page) && /id="dBgRow"/.test(page)
   && /function syncDatePanel\(o\)\{/.test(js)
   /* 面板高度固定：画布不跟着选项跳 */
   && /#sheet\.up\{[\s\S]{0,120}?height:auto;[\s\S]{0,60}?max-height:38%;/.test(page)
   /* 画布可缩放 / 平移（只影响显示） */
   && /var stageView = \{ z:1, x:0, y:0 \};/.test(js)
   && /function zoomStageAt\(/.test(js)
   && /function resetStageView\(/.test(js)
   /* 状态条空闲时不占画布：初始就是 hid */
   && /<div id="statusLine" class="hid">/.test(page));

// R1.4.10：日期 / 时间各自单选、可同时选（日期在前）；文本可按宽度折行；
// 文本框宽度可拖（o.wrap）；票据齿孔从角落排 + 下方留白加大字；拖动比例拆开。
ok("R1.4.10 date+time compose, wrap by width, ticket holes from corners",
   /* 面板两行独立 select */
   /id="dateTime"/.test(page) && /id="dateFmtRow"/.test(page) && /id="dateTimeRow"/.test(page)
   /* 组合：日期在前、时间在后，中间一个空格 */
   && /a \+ \(a && b \? " " : ""\) \+ b/.test(js)
   && /function setDateTime\(v\)\{/.test(js)
   /* R1.4.11：日期不再有「宽度」——分行只看回车，框宽 = 最宽那一行 */
   && /var raw = text\.split\("\\n"\)/.test(js)
   && js.indexOf("+o.wrap * s") < 0
   /* 票据：齿孔首末贴角、下方白边更大、种子大字 */
   && /cx = pr \+ span \* \(i \/ \(n - 1\)\)/.test(js)
   && js.indexOf("rect:[0.034, 0.062, 0.932, 0.790]") >= 0
   && /name === "ticket"/.test(js)
   /* 风格预设与三级选项同一套观感 */
   && /button\.preset\{[^}]*flex:1 1 0/.test(page)
   && /button\.preset\.on\{ background:var\(--acc\); color:#fff; \}/.test(page)
   /* 拖动：布局比例与位移比例分开 */
   && /var baseS = objScale\(\);/.test(js)
   && /scale:dragScale, fs:baseS/.test(js));

// R1.4.11：图标可输入（仅符号）＋ 只有图标收输入；日期自定义独立三级页；
// 日期去掉宽度手柄；设置菜单重排；控件外观统一。
ok("R1.4.11 icon input cell, date custom page, no date width handle, settings regroup",
   /* 图标页也有「＋」，只收符号（彩色 emoji 归表情页） */
   /function icoAddCell\(\)\{/.test(js)
   && /id = "stkIcoAdd"/.test(js)
   && /function isIconCode\(cp\)\{/.test(js)
   && /if \(cp >= 0x1F000 && cp <= 0x1FAFF\) return false;/.test(js)
   && /id="stkIcoIn"/.test(page)
   /* 日期三级顺序：日期 → 自定义 → 描边 → 填充 → 底色 */
   && (function(g){
        var a = g.indexOf('data-l3="日期"'), b = g.indexOf('data-l3="自定义"');
        var c = g.indexOf('data-l3="描边"');
        return a >= 0 && a < b && b < c;
      })(page.slice(page.indexOf('data-l2="日期"'), page.indexOf('data-l2="贴纸"')))
   && /id="dateAlignRow"/.test(page) && /id="dateCustom"[^>]*rows="2"/.test(page)
   && /function enterDateCustom\(focus\)\{/.test(js)
   && /function setDateAlign\(v\)\{/.test(js)
   /* 对齐真的参与绘制 */
   && /lay\.align === "l"\).*lay\.w\/2/.test(js)
   /* 日期没有宽度手柄 */
   && /\.tobj\.nowrap \.hnd\.h-w\{ display:none; \}/.test(page)
   && /el\.classList\.toggle\("nowrap", isDate\(o\)\)/.test(js)
   /* 设置：设备设置下全是第 2 栏下拉；屏幕与 GPIO 分开 */
   && /<h3>设备设置<\/h3>/.test(page)
   && /<summary>\s*屏幕<\/summary>/.test(page)
   && /<summary>\s*GPIO<\/summary>/.test(page)
   && !/屏幕与 GPIO/.test(page)
   /* 统一选项外观：底 #f7f3ea、选中橙底白字 */
   && /\.chips span\{[\s\S]{0,180}?background:#f7f3ea/.test(page)
   && /\.chips span\.on\{ border-color:var\(--acc\); color:#fff; background:var\(--acc\); \}/.test(page)
   && /button\{?[\s\S]{0,120}?border-radius:9px/.test(page));

// R1.4.0：便签从「没有照片的拍立得」重构成结构化文档 + 六种四色版式。
// 底栏按 MODE 换一组工具；渲染只在 drawBase 的便签分支加一层 noteRender，
// 帧格式 / 打包 / 固件一行不动。
ok("R1.4.0 note mode: own dock, doc model, six layouts, four-color themes",
   /* 便签态三个工具 + 保存共用 */
   /data-tool="ncontent" data-mode="1"/.test(page)
   && /data-tool="nlayout" data-mode="1"/.test(page)
   && /data-tool="ntheme" data-mode="1"/.test(page)
   && /data-tool="compose" data-mode="0"/.test(page)
   && /data-pane="ncontent"/.test(page) && /data-pane="nlayout"/.test(page)
   && /data-pane="ntheme"/.test(page)
   /* 文档模型：六种版式、六个主题、五个色板 token */
   && /var NOTE_LAYOUTS = \{/.test(js) && /var NOTE_THEMES = \{/.test(js)
   && /var NOTE_TOKENS = \["bg", "ink", "rule", "accent", "alert"\]/.test(js)
   && /function noteParse\(raw\)\{/.test(js)
   && /function noteNorm\(d\)\{/.test(js)
   && /function noteTokens\(d\)\{/.test(js)
   /* 六个布局器都挂上了 */
   && /var NOTE_DRAW = \{/.test(js) && /poster:ntPoster, dark:ntStub/.test(js)
   /* 只走纯四色：ntBox/ntText 全部经 ntRGB(PAL[idx]) */
   && /function ntRGB\(c\)\{[\s\S]{0,120}?PAL\[/.test(js)
   && /ctx\.fillText\(str, x, y\);\s*ctx\.fillText\(str, x, y\);/.test(js)
   /* 接入点：drawBase 便签分支 + 存档 + 底栏显隐 + 启动接线 */
   && /noteRender\(ctx, cw, ch\);/.test(js)
   && /cfg\.noteDoc = noteNorm\(cfg\.noteDoc\);/.test(js)
   && /function dockVisible\(b\)\{/.test(js)
   && /var TOOL_MODE = \{ compose:0, color:0, fx:0, ncontent:1/.test(js)
   && /noteInit\(\);/.test(js)
   && /function noteInit\(\)\{/.test(js)
   /* 旧的整屏单色底绘制已下线 */
   && js.indexOf("nbp = PAL") < 0);

// R1.4.0：便签先版式后内容；排版选项按版式显隐；过时 DOM 与重复控件生成下线。
ok("R1.4.0 note workflow: layout first, layout-scoped options, slim DOM",
   page.indexOf('data-tool="nlayout" data-mode="1"') < page.indexOf('data-tool="ncontent" data-mode="1"')
   && /data-l3="栏数" data-only="kanban"/.test(page)
   && /data-l3="密度" data-skip="kanban"/.test(page)
   && /function boxUsable\(el\)\{/.test(js)
   && /function noteBuildControls\(\)\{/.test(js)
   && /data-tok="bg"/.test(page) && /data-tok="alert"/.test(page)
   && page.indexOf('id="noteBgRow"') < 0 && js.indexOf("noteBgRow") < 0);

// R1.4.0 编译修复：IDF 6.1 的 httpd_err_code_t 没有 409；数字状态码会落到
// send_err 的 default 变成 500。两处改用显式状态行，守住 CONTRACT 的 409 / 507。
ok("R1.4.0 firmware: explicit 409/507 status lines (IDF 6.1)",
   mainC.indexOf('httpd_resp_set_status(req, "409 Conflict")') >= 0
   && mainC.indexOf("HTTPD_409_CONFLICT") < 0
   && frameC.indexOf('httpd_resp_set_status(req, "507 Insufficient Storage")') >= 0
   && frameC.indexOf("httpd_resp_send_err(req, 507") < 0);
// 成品页零注释、测试页保留注释，两份 meta 版本号与 version.h 一致
ok("R1.4.0 build: comment-free prod page + commented dev page, single version",
   prod.indexOf("<!--") < 0 && !/\/\*[\s\S]*?\*\//.test(prod) /* MIME 通配符不算注释 */
   && page.indexOf("/* ====") >= 0
   && /moink-page-version" content="R1\.4\.0(-\d+)?"/.test(prod)
   && /moink-page-version" content="R1\.4\.0(-\d+)?"/.test(page)
   && /#define MOINK_VERSION\s+"R1\.4\.0(-\d+)?"/.test(versionH));

// 2026-11-16 根因：TIME_WAIT 120 s + 13 条并发连接把 ~39 KB 堆榨干 → 网页打不开。
// 这几项是当时的修复，改回去会立刻复发。
ok("R1.4.0 内存：TIME_WAIT 缩短 / 降并发 / 页面 gzip",
   /^CONFIG_LWIP_TCP_MSL=2000$/m.test(sdkconfig)
   && /^CONFIG_LWIP_TCP_SND_BUF_DEFAULT=4320$/m.test(sdkconfig)
   && mainC.indexOf("cfg.max_open_sockets = 4;") >= 0
   && mainC.indexOf("Content-Encoding\", \"gzip") >= 0
   && mainC.indexOf("index_html_gz") >= 0);

// 2026-11-17 页面调整：圆角 / 拍立得装饰对象 / 日期右下 / 图标单色 / 贴纸变形
ok("2026-11-17 圆角：细边框与拍立得 3mm、拼图 5mm、胶片方形齿孔",
   js.indexOf("function tplRound(ctx, x, y, w, h, R, col)") >= 0
   && js.indexOf("Math.round(32*tplK(cw))") >= 0
   && js.indexOf("Math.round(53*tplK(cw))") >= 0
   && js.indexOf("tplRound(ctx, x, y, w, h, rad") >= 0
   && js.indexOf("tplRRect(ctx, Math.round(bandL/2 - pw/2), yy, pw, ph, rad); ctx.fill();") >= 0);

ok("2026-11-17 拍立得留白：可编辑的红心/黄星/黑纸飞机 + 文字",
   js.indexOf('name !== "polaroid"') >= 0
   && js.indexOf('var chs = ["\u2665", "\u2605", "\u2708"]') >= 0
   && js.indexOf('var cls = [3, 2, 0]') >= 0
   && js.indexOf('text:"RECORD EVERY DAY OF LIFE"') >= 0
   && js.indexOf('tpl:"polaroid"') >= 0
   && js.indexOf("var left = Math.round(TPL.polaroid.rect[0] * EW) + 24") >= 0
   && js.indexOf("var xs = [left + 22, left + 66, left + 110]") >= 0
   && js.indexOf('text:"MEMO"') >= 0 && js.indexOf('bg:3, wrap:0, tpl:"polaroid"') >= 0);

ok("2026-11-17 日期默认右下角、小字、像素对齐点阵/数码管",
   js.indexOf("x:EW - 90, y:EH - 34, size:20") >= 0
   && js.indexOf("o.x = EW - 24 - Math.round(lm.mw/2)") >= 0
   && js.indexOf("sz = Math.max(8, Math.round(sz))") >= 0
   && js.indexOf("var side = Math.max(1, Math.min(p - 1, Math.round(p * 0.62)))") >= 0
   && js.indexOf("ctx.fillRect(sx + p*cx + o2, sy + p*ry + o2, side, side)") >= 0);

ok("2026-11-17 图标强制文本呈现（不混彩色 emoji）+ 贴纸宽度变形",
   js.indexOf("function icoEmoPres(cp)") >= 0
   && js.indexOf('ch + "\\uFE0E"') >= 0
   && js.indexOf('a[j] = c + "\\uFE0E"') >= 0
   && js.indexOf("var sx = w / Math.max(1, h);") >= 0
   && js.indexOf("ctx.scale(sx, 1);") >= 0);

ok("2026-11-17 贴纸色彩与照片一致（不再明显发灰）",
   js.indexOf("c.autoLevels = 1") >= 0
   && js.indexOf("c.coolDesat = 0") >= 0
   && js.indexOf("c.coolPull = 0") >= 0);

console.log(failed === 0 ? "SMOKE: ALL PASS" : ("SMOKE: " + failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
