# -*- coding: utf-8 -*-
"""page R1.0.12 手术脚本：Cropper.js 内嵌裁剪 + 留白 + 文字对象系统。
每处替换断言命中次数，异常立即中止（绝不半改）。运行前页面已备份至 backups/。
"""
import io, os, sys

ROOT = r"C:\Users\pcing\WorkBuddy\2026-09-15-15-28-42\moink"
PAGE = os.path.join(ROOT, "page", "index.html")
V_JS = os.path.join(ROOT, "page", "vendor", "cropper.min.js")
V_CSS = os.path.join(ROOT, "page", "vendor", "cropper.min.css")

html = io.open(PAGE, encoding="utf-8").read()
cropper_js = io.open(V_JS, encoding="utf-8").read()
cropper_css = io.open(V_CSS, encoding="utf-8").read()

# 安全前提：库内无字面量 </script>
assert "</script>" not in cropper_js, "cropper.min.js contains literal </script>!"
assert "</script>" not in cropper_css, "cropper.min.css contains literal </script>!"

def rep(s, old, new, n=1):
    c = s.count(old)
    assert c == n, "EXACT MATCH=%d (want %d): %r" % (c, n, old[:70])
    return s.replace(old, new)

def span(s, start, end, new, incl_end=False):
    assert s.count(start) == 1, "SPAN START not unique: %r" % start[:70]
    i = s.index(start)
    j = s.index(end, i + len(start))
    assert s.count(end) >= 1
    if incl_end:
        j = j + len(end)
    return s[:i] + new + s[j:]

# ---------- 1. 版本号 ----------
html = rep(html,
    '<meta name="moink-page-version" content="R1.0.11">',
    '<meta name="moink-page-version" content="R1.0.12">')

# ---------- 2. Cropper CSS 内联 ----------
html = rep(html, "<style>\n:root{",
    "<style>\n/* ===== Cropper.js v1.6.2 | MIT | https://github.com/fengyuanchen/cropperjs ===== */\n"
    + cropper_css + "\n:root{")

# ---------- 3. 旧裁剪舞台 CSS -> 新 CSS ----------
html = span(html, "#stage{ position:relative", "cursor:se-resize; }",
"""#cropWrap{ margin:10px 0; border-radius:12px; overflow:hidden; background:#eee6da; }
#cropImg{ display:block; max-width:100%; }
#prevWrap{ position:relative; width:fit-content; max-width:100%; margin:10px auto; }
#objLayer{ position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; }
.tobj{ position:absolute; pointer-events:auto; cursor:move; white-space:pre-wrap;
       text-align:center; line-height:1.35; transform-origin:center center; touch-action:none; }
.tobj.sel{ outline:1.5px dashed var(--acc); outline-offset:2px; }
.tobj .hnd{ position:absolute; width:26px; height:26px; border-radius:50%;
            background:var(--acc); border:2px solid #fff; box-sizing:border-box;
            touch-action:none; }
.tobj .h-s{ right:-13px; bottom:-13px; cursor:nwse-resize; }
.tobj .h-r{ right:-13px; top:-13px; cursor:grab; }
.tobj .hnd::after{ content:""; position:absolute; inset:0; margin:auto; width:10px; height:10px;
                   border-radius:50%; background:#fff; opacity:.85; }
.padGrid{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:6px 0; }
.padGrid label{ font-size:12.5px; color:var(--mut); }
.padGrid input{ width:64px; padding:6px; }""", incl_end=True)

# ---------- 4. #prev CSS ----------
html = rep(html,
"""#prev{ display:block; width:100%; max-width:420px; margin:10px auto; border:1px solid var(--line);
       border-radius:10px; background:#fff; }""",
"""#prev{ display:block; width:100%; max-width:420px; margin:0 auto; border:1px solid var(--line);
       border-radius:10px; background:#fff; }""")

# ---------- 5. 模式按钮与描述 ----------
html = rep(html,
"""    <div class="row" id="modes">
      <button class="mode on" data-m="0">整幅图像</button>
      <button class="mode" data-m="1">文字便签</button>
    </div>
    <div class="hint" id="modeDesc">图片铺满整块屏幕，可在画面上叠一行文字。</div>""",
"""    <div class="row" id="modes">
      <button class="mode on" data-m="0">拍立得</button>
      <button class="mode" data-m="1">便签</button>
    </div>
    <div class="hint" id="modeDesc">以图为主：裁剪 → 可选留白与文字叠加；风格只作用于图像。</div>""")

# ---------- 6. cropCard HTML ----------
html = rep(html,
"""      <div id="cropCard">
        <div id="stage"><canvas id="src"></canvas><div id="crop"></div></div>
        <div class="row">
          <button class="mini" id="rotStep">旋转 90°</button>
          <span id="rotVal" style="font-size:13px;color:var(--mut)">90°</span>
          <span style="flex:1"></span>
          <button class="mini" id="cropMax">铺满</button>
          <button class="mini" id="cropCenter">居中</button>
        </div>
        <div class="hint">拖动框移动，右下角缩放；比例固定为屏幕 768:552。</div>
      </div>""",
"""      <div id="cropCard">
        <div id="cropWrap"><img id="cropImg" alt=""></div>
        <div class="row">
          <button class="mini" id="rotL">&#8630; 90&deg;</button>
          <button class="mini" id="rotStep">&#8635; 90&deg;</button>
          <button class="mini" id="cropMax">铺满</button>
          <button class="mini" id="cropCenter">居中</button>
        </div>
        <div class="slider">
          <label>旋转</label>
          <input type="range" id="rotRange" min="-180" max="180" value="0" step="1">
          <output id="o-rot">0&deg;</output>
        </div>
        <div class="hint">双指捏合缩放、拖动移动图片；角度接近 90&deg; 整数倍自动贴合。</div>
      </div>
      <div id="padCard" style="display:none">
        <div class="row"><label><input type="checkbox" id="padOn"> 留白</label>
          <span class="hint" style="margin:0">按 px 在四边留白，裁剪框比例随动</span></div>
        <div class="padGrid" id="padGrid" style="display:none">
          <label>上 <input type="number" id="padT" min="0" max="300" value="0"></label>
          <label>右 <input type="number" id="padR" min="0" max="300" value="0"></label>
          <label>下 <input type="number" id="padB" min="0" max="300" value="0"></label>
          <label>左 <input type="number" id="padL" min="0" max="300" value="0"></label>
        </div>
      </div>""")

# ---------- 7. textCard HTML ----------
html = rep(html,
"""    <div id="textCard">
      <textarea id="txt" placeholder="写点文字（留空就是不叠字）…"></textarea>
      <div class="row">
        <label>字体</label>
        <select id="tFont"></select>
        <label>大小</label>
        <input type="range" id="tSize" min="40" max="260" value="100">
        <label>颜色</label>
        <select id="tColor"><option value="0">黑</option><option value="1">白</option><option value="2">黄</option><option value="3">红</option></select>
        <span id="tbgWrap"><label>底色</label>
        <select id="tBg"><option value="0">白底</option><option value="1">黑底</option></select></span>
      </div>
      <div class="row" id="autoPushRow" style="display:none">
        <label><input type="checkbox" id="autoPush"> 停止输入 3 秒自动上传</label>
      </div>
    </div>""",
"""      <div id="textCard">
        <div class="row" id="textOnRow" style="display:none">
          <label><input type="checkbox" id="textOn"> 添加文字</label>
        </div>
        <div id="textPanel" style="display:none">
          <div class="row">
            <button class="mini" id="objAdd">＋ 添加</button>
            <button class="mini" id="objDel">删除所选</button>
            <span class="hint" style="margin:0">点预览中文字框选中；右下柄缩放、右上柄旋转</span>
          </div>
          <textarea id="txt" placeholder="输入所选文字框的内容（可换行）…"></textarea>
          <div class="row">
            <label>字体</label>
            <select id="tFont"></select>
            <label>大小</label>
            <input type="range" id="tSize" min="16" max="220" value="48">
            <label>颜色</label>
            <select id="tColor"><option value="0">黑</option><option value="1">白</option><option value="2">黄</option><option value="3">红</option></select>
          </div>
          <div class="row">
            <label>方向</label>
            <input type="range" id="tRot" min="-180" max="180" value="0">
            <label>描边</label>
            <input type="range" id="tStroke" min="0" max="8" value="0">
            <select id="tStrokeC"><option value="1">白边</option><option value="0">黑边</option></select>
          </div>
          <div class="row" id="objBgRow" style="display:none">
            <label>文字底色</label>
            <select id="tObjBg"><option value="0">无（透明）</option><option value="1">白底</option><option value="2">黑底</option></select>
          </div>
          <div class="row" id="tbgRow" style="display:none">
            <label>屏幕底色</label>
            <select id="tBg"><option value="0">白底</option><option value="1">黑底</option></select>
          </div>
        </div>
        <div class="row" id="autoPushRow" style="display:none">
          <label><input type="checkbox" id="autoPush"> 停止输入 3 秒自动上传</label>
        </div>
      </div>""")

# ---------- 8. 预览画布 + 对象覆盖层 ----------
html = rep(html,
    '    <canvas id="prev" width="768" height="552"></canvas>',
    '    <div id="prevWrap"><canvas id="prev" width="768" height="552"></canvas>'
    '<div id="objLayer"></div></div>')

# ---------- 9. 风格卡标识 ----------
html = rep(html,
"""  <!-- ================= 风格 ================= -->
  <section class="card">
    <h2>风格<span class="tag">画面质感</span></h2>""",
"""  <!-- ================= 风格 ================= -->
  <section class="card" id="styleCard">
    <h2>风格<span class="tag">仅作用于图像</span></h2>""")

# ---------- 10. Cropper JS 内联（独立 script 块） ----------
html = rep(html, '<script>\n"use strict";',
"""<script>
/* ===== Cropper.js v1.6.2 | MIT | https://github.com/fengyuanchen/cropperjs ===== */
""" + cropper_js + """
</script>
<script>
"use strict";""")

# ---------- 11. MODE_DEF ----------
html = rep(html,
"""var MODE_DEF = [
  { name:"整幅图像", desc:"图片铺满整块屏幕，可在画面上叠一行文字。" },
  { name:"文字便签", desc:"不放图片，整块屏幕只显示文字。" }
];""",
"""var MODE_DEF = [
  { name:"拍立得", desc:"以图为主：裁剪 → 可选留白与文字叠加；风格只作用于图像。" },
  { name:"便签", desc:"以文字为主：自由摆放文字，可调字体/颜色/底色，无图像无抖动。" }
];""")

# ---------- 12. DEF 尾部 ----------
html = rep(html,
"""  angle: 90, lastMode: 0, text: "", textFont: 0, textSize: 100,
  textColor: 0, textBg: 0, autoPush: false
};""",
"""  lastMode: 0, text: "", textFont: 0, textSize: 100,
  textColor: 0, textBg: 0, autoPush: false,
  cropRot: 0, padOn: false, padT: 0, padR: 0, padB: 0, padL: 0,
  textOn: false, objsImg: null, objsNote: null
};""")

# ---------- 13. textMetrics/drawTextLayer -> contentRect/contentAR/drawObjs ----------
html = span(html, "function textMetrics(cw, ch){", "function toBuf(canvas){",
"""function contentRect(){
  var pl = cfg.padOn ? clamp(Math.round(+cfg.padL||0),0,300) : 0;
  var pr = cfg.padOn ? clamp(Math.round(+cfg.padR||0),0,300) : 0;
  var pt = cfg.padOn ? clamp(Math.round(+cfg.padT||0),0,300) : 0;
  var pb = cfg.padOn ? clamp(Math.round(+cfg.padB||0),0,300) : 0;
  var w = Math.max(60, PANEL.w - pl - pr), h = Math.max(60, PANEL.h - pt - pb);
  return { x:pl, y:pt, w:w, h:h };
}
function contentAR(){ var r = contentRect(); return r.w / r.h; }
/* 文字对象绘制：坐标/字号按逻辑屏 768x552 存储，s 为当前画布缩放；
   透明底 + 可选描边（默认白边）保证图上可读；只画调色板色，读回时 snapIdx 吸附。 */
function drawObjs(ctx, objs, cw, ch){
  if (!objs || !objs.length) return;
  var s = cw / PANEL.w, i;
  for (i = 0; i < objs.length; i++){
    var o = objs[i];
    var t = String(o.text == null ? "" : o.text);
    if (!t.replace(/\\s+$/, "")) continue;
    ctx.save();
    ctx.translate((+o.x||0)*s, (+o.y||0)*s);
    ctx.rotate((+o.rot||0)*Math.PI/180);
    var f = FONTS[clamp(+o.font|0, 0, FONTS.length-1)];
    var sz = Math.max(6, (+o.size||48)*s);
    ctx.font = f.w + " " + sz + "px " + f.css;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    var maxW = (+o.wrap ? +o.wrap*s : cw*0.94);
    var lines = wrapText(ctx, t, maxW);
    var lh = Math.round(sz*1.35), blockH = lines.length*lh, mw = 0, j;
    for (j = 0; j < lines.length; j++) mw = Math.max(mw, ctx.measureText(lines[j]).width);
    if (+o.bg === 1 || +o.bg === 2){
      ctx.fillStyle = (+o.bg === 2) ? "rgb(0,0,0)" : "rgb(255,255,255)";
      var pX = sz*0.28, pY = sz*0.18;
      ctx.fillRect(-mw/2 - pX, -blockH/2 - pY, mw + pX*2, blockH + pY*2);
    }
    var fg = PAL[clamp(+o.color|0, 0, 3)];
    var sw = clamp(+o.stroke||0, 0, 10) * s;
    for (j = 0; j < lines.length; j++){
      var yy = -blockH/2 + lh/2 + j*lh;
      if (sw > 0){
        ctx.lineWidth = sw*2; ctx.lineJoin = "round";
        ctx.strokeStyle = (+o.strokeC === 0) ? "rgb(0,0,0)" : "rgb(255,255,255)";
        ctx.strokeText(lines[j], 0, yy);
      }
      ctx.fillStyle = "rgb("+fg[0]+","+fg[1]+","+fg[2]+")";
      ctx.fillText(lines[j], 0, yy);
    }
    ctx.restore();
  }
}
""")

# ---------- 14. 删除 drawCropInto ----------
html = rep(html,
"""function drawCropInto(ctx, dx, dy, dw, dh){
  if (!img || !crop) return;
  var rad = angle * Math.PI / 180;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.translate(dx + dw/2, dy + dh/2);
  ctx.scale(dw/crop.w, dh/crop.h);
  ctx.rotate(-rad);
  ctx.translate(-crop.cx, -crop.cy);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
""", "")

# ---------- 15. renderComposite 重写 ----------
html = span(html, "function renderComposite(cw, ch){", "function renderTo(cv, cw, ch){",
"""var cropCache = { sig:"", cv:null };
function cropSig(cw, ch){
  if (!cr || !crReady) return "";
  var d;
  try { d = cr.getData(); } catch(e){ return ""; }
  if (!d) return "";
  return [cw, ch, Math.round(d.x), Math.round(d.y), Math.round(d.width),
          Math.round(d.height), Math.round(d.rotate||0), curRot].join(",");
}
function getCropCanvas(cw, ch){
  var sig = cropSig(cw, ch);
  if (sig && sig === cropCache.sig && cropCache.cv) return cropCache.cv;
  var cv = cr.getCroppedCanvas({ width:cw, height:ch, fillColor:"#fff",
                                 imageSmoothingQuality:"high" });
  if (sig){ cropCache.sig = sig; cropCache.cv = cv; }
  return cv;
}
function renderComposite(cw, ch){
  var cv = document.createElement("canvas");
  cv.width = cw; cv.height = ch;
  var ctx = cv.getContext("2d", { willReadFrequently: true });
  var objs = (MODE === 0) ? cfg.objsImg : cfg.objsNote;
  if (MODE === 0){
    /* L0 白底（含留白区）→ L1 图像层（风格化+抖动只作用此层）→ L2 文字对象 */
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
    if (img && cr && crReady){
      var sc = cw / PANEL.w;
      var r0 = contentRect();
      var r = { x:Math.round(r0.x*sc), y:Math.round(r0.y*sc),
                w:Math.round(r0.w*sc), h:Math.round(r0.h*sc) };
      var cc = getCropCanvas(r.w, r.h);
      if (cc && cc.width && cc.height){
        var idx0 = quantize(warmMap(toBuf(cc), r.w, r.h, cfg), r.w, r.h, cfg);
        var im = ctx.createImageData(r.w, r.h), dd = im.data;
        for (var i = 0; i < r.w*r.h; i++){
          var p = PAL[idx0[i]];
          dd[i*4] = p[0]; dd[i*4+1] = p[1]; dd[i*4+2] = p[2]; dd[i*4+3] = 255;
        }
        ctx.putImageData(im, r.x, r.y);
      }
    }
    drawObjs(ctx, objs, cw, ch);
  } else {
    /* 便签：底色 + 文字对象直出，不做风格化不抖动 */
    ctx.fillStyle = cfg.textBg ? "rgb(0,0,0)" : "rgb(255,255,255)";
    ctx.fillRect(0, 0, cw, ch);
    drawObjs(ctx, objs, cw, ch);
  }
  var d = ctx.getImageData(0, 0, cw, ch).data;
  var idx = new Uint8Array(cw * ch);
  for (var i2 = 0; i2 < cw*ch; i2++){
    idx[i2] = snapIdx(d[i2*4], d[i2*4+1], d[i2*4+2]);
  }
  return idx;
}
""")

# ---------- 16. 删除 imgSig ----------
html = rep(html,
"""function imgSig(){
  return JSON.stringify([
    PANEL.w, PANEL.h, MODE,
    crop ? [Math.round(crop.cx), Math.round(crop.cy), Math.round(crop.w), Math.round(crop.h)] : null,
    Math.round(angle),
    cfg.mode, cfg.brightness, cfg.contrast, cfg.gamma, cfg.saturation,
    cfg.warmCast, cfg.castRamp, cfg.warmCenter, cfg.warmSpan, cfg.warmBoost,
    cfg.coolPull, cfg.coolCap, cfg.coolDesat, cfg.warmPull, cfg.warmPullCap,
    cfg.autoLevels, cfg.sharpen, cfg.dither, cfg.ditherStrength, cfg.space
  ]);
}
""", "")

# ---------- 17. DOM 引用 ----------
html = rep(html,
    'var srcEl = $("src"), stageEl = $("stage"), cropEl = $("crop");',
    'var cropImgEl = $("cropImg"), objLayerEl = $("objLayer"), prevWrapEl = $("prevWrap");')

# ---------- 18. 状态变量 ----------
html = rep(html,
"""var img = null;
var crop = null;
var angle = DEF.angle;""",
"""var img = null;
var curRot = 0;   /* 裁剪旋转角（-180..180），Cropper 增量驱动 */""")

# ---------- 19. loadCfg + 迁移 ----------
html = span(html, "function loadCfg(){", "/* ---------- 预览 ---------- */",
"""function normObjs(a){
  if (!Array.isArray(a)) return [];
  return a.map(function(o){
    return { x:+o.x||0, y:+o.y||0, text:String(o.text==null?"":o.text),
             font:clamp(+o.font|0,0,FONTS.length-1), size:clamp(+o.size||48,16,240),
             color:clamp(+o.color|0,0,3), rot:clamp(+o.rot||0,-180,180),
             stroke:clamp(+o.stroke||0,0,10), strokeC:(+o.strokeC===0)?0:1,
             bg:clamp(+o.bg|0,0,3), wrap:+o.wrap||0 };
  });
}
function loadCfg(){
  try {
    var t = localStorage.getItem(LS_KEY) || localStorage.getItem(LS_KEY_OLD);
    if (t) Object.assign(cfg, JSON.parse(t));
  } catch(e){}
  /* 迁移：旧版单条 cfg.text → 单个文字对象（拍立得/便签各一份） */
  if (!Array.isArray(cfg.objsImg) && !Array.isArray(cfg.objsNote) &&
      String(cfg.text||"").replace(/\\s+$/, "")){
    var px = clamp(Math.round(45 * clamp(+cfg.textSize, 40, 260) / 100), 16, 240);
    var o = { x:PANEL.w/2, y:PANEL.h/2, text:cfg.text, font:cfg.textFont|0,
              size:px, color:cfg.textColor|0, rot:0, stroke:0,
              strokeC:(cfg.textColor === C_W) ? 0 : 1, bg:0, wrap:0 };
    cfg.objsImg = [JSON.parse(JSON.stringify(o))];
    cfg.objsNote = [JSON.parse(JSON.stringify(o))];
    cfg.textOn = true;
  }
  cfg.objsImg = normObjs(cfg.objsImg);
  cfg.objsNote = normObjs(cfg.objsNote);
  curRot = clamp(Math.round(+cfg.cropRot || 0), -180, 180);
}

""")

# ---------- 20. setMode 主体 ----------
html = span(html, "  var imageMode = (MODE === 0);", "  cfg.lastMode = MODE;",
"""  var imageMode = (MODE === 0);
  $("pickCard").style.display  = imageMode ? "" : "none";
  $("cropCard").style.display  = imageMode ? "" : "none";
  $("padCard").style.display   = imageMode ? "" : "none";
  $("styleCard").style.display = imageMode ? "" : "none";
  $("textOnRow").style.display = imageMode ? "" : "none";
  $("objBgRow").style.display  = imageMode ? "none" : "";
  $("tbgRow").style.display    = imageMode ? "none" : "";
  $("autoPushRow").style.display = imageMode ? "none" : "";
  if (!imageMode && cfg.objsNote.length === 0){ cfg.objsNote.push(newObj()); saveCfg(); }
  selIdx = -1;
  if (imageMode) initCrop(); else destroyCrop();
  refreshTextUI();
  goEl.disabled = imageMode ? !img : false;
  if (!silent) msg(imageMode ? "已切换到「拍立得」" : "便签模式：自由摆放文字");
""")

# ---------- 21. 裁剪区整体替换 ----------
html = span(html, "/* ---------- 裁剪", "/* ---------- 选图",
"""/* ---------- 裁剪（Cropper.js v1.6.2 内嵌：捏合缩放 / 自由旋转 / 90° 自动贴合） ---------- */
var cr = null, crReady = false;
function rotSnap(a){
  var m = mod(a, 90);
  if (m > 87) return a + (90 - m);
  if (m < 3)  return a - m;
  return a;
}
function cropInvalid(){ cropCache.sig = ""; cropCache.cv = null; }
function initCrop(){
  if (!img || cr || MODE !== 0) return;
  cropInvalid();
  $("rotRange").value = curRot;
  $("o-rot").textContent = curRot + "\\u00b0";
  cropImgEl.src = img.src;
  cr = new Cropper(cropImgEl, {
    aspectRatio: contentAR(), viewMode: 1, dragMode: "move",
    autoCropArea: 1, checkOrientation: true,
    rotatable: true, zoomable: true, zoomOnTouch: true, zoomOnWheel: true,
    cropBoxMovable: true, cropBoxResizable: true, toggleDragModeOnDblclick: false,
    ready: function(){
      crReady = true;
      if (curRot){ try { cr.rotate(curRot); } catch(e){} }
      crCropMax();
      schedulePreview(false);
    },
    crop: function(){ schedulePreview(true); },
    cropend: function(){ cropInvalid(); schedulePreview(false); }
  });
}
function destroyCrop(){
  if (!cr) return;
  try { cr.destroy(); } catch(e){}
  cr = null; crReady = false; cropInvalid();
}
function syncRotUI(){
  $("rotRange").value = curRot;
  $("o-rot").textContent = curRot + "\\u00b0";
}
function setRot(a){
  a = clamp(Math.round(a), -180, 180);
  a = rotSnap(a);
  if (a === curRot){ syncRotUI(); return; }
  var d = a - curRot;
  curRot = a; cfg.cropRot = a; syncRotUI(); saveCfg();
  if (cr && crReady){ try { cr.rotate(d); } catch(e){} }
  cropInvalid(); schedulePreview(true);
}
function crCropMax(){
  if (!cr || !crReady) return;
  cr.setAspectRatio(contentAR());
  cr.clear(); cr.crop();          /* autoCropArea=1 → 比例内最大裁剪框并居中 */
  cropInvalid(); schedulePreview(false);
}
function crCenter(){
  if (!cr || !crReady) return;
  var b = cr.getCropBoxData(), c = cr.getContainerData();
  cr.setCropBoxData({ left:(c.width - b.width)/2, top:(c.height - b.height)/2,
                      width:b.width, height:b.height });
  cropInvalid(); schedulePreview(false);
}
function applyPad(){
  cfg.padOn = !!$("padOn").checked;
  cfg.padT = clamp(Math.round(+$("padT").value || 0), 0, 300);
  cfg.padR = clamp(Math.round(+$("padR").value || 0), 0, 300);
  cfg.padB = clamp(Math.round(+$("padB").value || 0), 0, 300);
  cfg.padL = clamp(Math.round(+$("padL").value || 0), 0, 300);
  $("padGrid").style.display = cfg.padOn ? "flex" : "none";
  if (cr && crReady) cr.setAspectRatio(contentAR());
  cropInvalid(); saveCfg(); schedulePreview(false);
}
$("padOn").addEventListener("change", applyPad);
["padT","padR","padB","padL"].forEach(function(k){
  $(k).addEventListener("change", applyPad);
});
$("cropMax").addEventListener("click", crCropMax);
$("cropCenter").addEventListener("click", crCenter);
$("rotStep").addEventListener("click", function(){ setRot(mod(curRot + 90 + 180, 360) - 180); });
$("rotL").addEventListener("click", function(){ setRot(mod(curRot - 90 + 180, 360) - 180); });
$("rotRange").addEventListener("input", function(){
  $("o-rot").textContent = $("rotRange").value + "\\u00b0";
});
$("rotRange").addEventListener("change", function(){ setRot(+$("rotRange").value); });

""")

# ---------- 22. loadFile 内的旧裁剪调用 ----------
html = rep(html,
"""    renderStage();
    resetCrop();
    setMode(MODE, true);""",
"""    destroyCrop();
    setMode(MODE, true);""")

# ---------- 23. 文字区整体替换（含覆盖层交互） ----------
html = span(html, "/* ---------- 文字 ---------- */", "/* ---------- 上传 ---------- */",
"""/* ---------- 文字对象（拍立得叠加 + 便签主体共用） ---------- */
FONTS.forEach(function(f, i){
  var o = document.createElement("option");
  o.value = i; o.textContent = ["系统默认","宋体","楷体","等宽"][i];
  $("tFont").appendChild(o);
});
var selIdx = -1;
function curObjs(){ return (MODE === 0) ? cfg.objsImg : cfg.objsNote; }
function newObj(){
  return { x:PANEL.w/2, y:PANEL.h/2, text:"新文字",
           font:0, size:48, color:C_K, rot:0, stroke:0,
           strokeC:1, bg:(MODE === 1 ? 1 : 0), wrap:0 };
}
function refreshTextUI(){
  var editing = (MODE === 1) || (MODE === 0 && !!cfg.textOn);
  $("textPanel").style.display = editing ? "" : "none";
  if (MODE === 0) $("textOn").checked = !!cfg.textOn;
  layoutObjs();
}
$("textOn").addEventListener("change", function(){
  cfg.textOn = $("textOn").checked;
  if (cfg.textOn && cfg.objsImg.length === 0) cfg.objsImg.push(newObj());
  saveCfg(); refreshTextUI(); schedulePreview(false);
});
$("objAdd").addEventListener("click", function(){
  curObjs().push(newObj());
  selIdx = curObjs().length - 1;
  saveCfg(); refreshTextUI(); syncSel(); schedulePreview(false);
});
$("objDel").addEventListener("click", function(){
  if (selIdx < 0 || !curObjs()[selIdx]) return;
  curObjs().splice(selIdx, 1);
  selIdx = -1; saveCfg(); refreshTextUI(); syncSel(); schedulePreview(false);
});
function syncSel(){
  var o = curObjs()[selIdx];
  ["tFont","tSize","tColor","tRot","tStroke","tStrokeC","tObjBg","txt"].forEach(function(id){
    var el = $(id); if (el) el.disabled = !o;
  });
  if (!o){ txtEl.value = ""; return; }
  txtEl.value = o.text;
  $("tFont").value = String(o.font|0);
  $("tSize").value = Math.round(o.size);
  $("tColor").value = String(o.color|0);
  $("tRot").value = Math.round(o.rot||0);
  $("tStroke").value = Math.round(o.stroke||0);
  $("tStrokeC").value = String(+o.strokeC === 0 ? 0 : 1);
  $("tObjBg").value = String(clamp(+o.bg|0,0,3));
}
function bindSel(id, key, ev){
  $(id).addEventListener(ev, function(){
    var o = curObjs()[selIdx]; if (!o) return;
    o[key] = +$(id).value;
    saveCfg(); relayoutOne(selIdx); schedulePreview(false);
  });
}
bindSel("tFont","font","change");
bindSel("tSize","size","input");
bindSel("tColor","color","change");
bindSel("tRot","rot","input");
bindSel("tStroke","stroke","input");
bindSel("tStrokeC","strokeC","change");
bindSel("tObjBg","bg","change");
txtEl.addEventListener("input", function(){
  var o = curObjs()[selIdx];
  if (o){ o.text = txtEl.value; relayoutOne(selIdx); }
  saveCfg(); schedulePreview(false);
  if (cfg.autoPush && MODE === 1) scheduleAutoPush();
});
$("tBg").addEventListener("change", function(){ cfg.textBg = +$("tBg").value; saveCfg(); schedulePreview(false); });
$("autoPush").addEventListener("change", function(){ cfg.autoPush = $("autoPush").checked; saveCfg(); });
function scheduleAutoPush(){
  clearTimeout(pushTimer);
  pushTimer = setTimeout(function(){
    if (MODE === 1) upload();
  }, 3000);
}

/* ---------- 文字对象覆盖层（拖动 / 右下柄缩放 / 右上柄旋转） ---------- */
function objScale(){
  return (prevWrapEl.clientWidth || PANEL.w) / PANEL.w;
}
function relayoutOne(i){
  var objs = curObjs(), o = objs[i], el = objLayerEl.children[i];
  if (!o || !el) return;
  var s = objScale();
  var f = FONTS[clamp(+o.font|0, 0, FONTS.length-1)];
  el.style.left = (o.x * s) + "px";
  el.style.top  = (o.y * s) + "px";
  el.style.font = f.w + " " + Math.max(9, Math.round(o.size * s)) + "px " + f.css;
  el.style.color = ["rgb(0,0,0)","rgb(255,255,255)","rgb(255,255,0)","rgb(255,0,0)"][clamp(+o.color|0,0,3)];
  el.style.transform = "translate(-50%,-50%) rotate(" + (+o.rot||0) + "deg)";
  el.textContent = o.text;
  var hS = document.createElement("i"); hS.className = "hnd h-s"; hS.dataset.a = "s";
  var hR = document.createElement("i"); hR.className = "hnd h-r"; hR.dataset.a = "r";
  el.appendChild(hS); el.appendChild(hR);
  el.classList.toggle("sel", i === selIdx);
}
function layoutObjs(){
  var objs = curObjs(), i;
  while (objLayerEl.children.length > objs.length) objLayerEl.removeChild(objLayerEl.lastChild);
  while (objLayerEl.children.length < objs.length){
    var el = document.createElement("div");
    el.className = "tobj";
    objLayerEl.appendChild(el);
  }
  for (i = 0; i < objs.length; i++) relayoutOne(i);
  objLayerEl.style.display = ((MODE === 1) || (MODE === 0 && cfg.textOn)) ? "" : "none";
}
var od = null;
objLayerEl.addEventListener("pointerdown", function(e){
  var el = e.target.closest ? e.target.closest(".tobj") : null;
  if (!el) return;
  var i = Array.prototype.indexOf.call(objLayerEl.children, el);
  var o = curObjs()[i];
  if (!o) return;
  if (selIdx !== i){ selIdx = i; layoutObjs(); syncSel(); }
  var r = el.getBoundingClientRect();
  var cx = r.left + r.width/2, cy = r.top + r.height/2;
  od = { i:i, act:(e.target.dataset && e.target.dataset.a) || "m",
         sx:e.clientX, sy:e.clientY,
         x0:o.x, y0:o.y, size0:o.size, rot0:o.rot,
         cx:cx, cy:cy,
         d0:Math.hypot(e.clientX-cx, e.clientY-cy),
         a0:Math.atan2(e.clientY-cy, e.clientX-cx)*180/Math.PI };
  e.preventDefault();
  document.addEventListener("pointermove", odMove, { passive:false });
  document.addEventListener("pointerup", odUp);
  document.addEventListener("pointercancel", odUp);
});
function odMove(e){
  if (!od) return;
  var o = curObjs()[od.i]; if (!o) return;
  var s = objScale();
  if (od.act === "m"){
    o.x = od.x0 + (e.clientX - od.sx)/s;
    o.y = od.y0 + (e.clientY - od.sy)/s;
  } else if (od.act === "s"){
    var d = Math.hypot(e.clientX-od.cx, e.clientY-od.cy);
    o.size = clamp(Math.round(od.size0 * (od.d0 > 6 ? d/od.d0 : 1)), 16, 240);
    $("tSize").value = o.size;
  } else {
    var a = Math.atan2(e.clientY-od.cy, e.clientX-od.cx)*180/Math.PI;
    o.rot = clamp(Math.round(od.rot0 + (a - od.a0)), -180, 180);
    $("tRot").value = o.rot;
  }
  relayoutOne(od.i);
  e.preventDefault();
}
function odUp(){
  if (od){ saveCfg(); schedulePreview(false); }
  od = null;
  document.removeEventListener("pointermove", odMove);
  document.removeEventListener("pointerup", odUp);
  document.removeEventListener("pointercancel", odUp);
}

""")

# ---------- 24. 启动块 ----------
html = rep(html,
"""loadCfg();
applyMode(cfg.mode || DEF.mode);
setMode(cfg.lastMode ? 1 : 0, true);
txtEl.value = cfg.text || "";""",
"""loadCfg();
applyMode(cfg.mode || DEF.mode);
setMode(cfg.lastMode ? 1 : 0, true);
syncSel();
window.addEventListener("resize", function(){ layoutObjs(); });""")

# ---------- 终检 ----------
assert "</script>" in html
n_closer = html.count("</script>")
assert n_closer == 2, "script closer count=%d (want 2)" % n_closer
assert html.count('<meta name="moink-page-version" content="R1.0.12">') == 1
assert "window.Cropper" in html or "Cropper" in html
io.open(PAGE, "w", encoding="utf-8", newline="").write(html)
print("OK  new size:", os.path.getsize(PAGE), "bytes  closers:", n_closer)
