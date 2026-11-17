/* ==================================================================
   30-crop.js —— 构图：固定照片 + 可移动 / 可旋转的取景框
   ------------------------------------------------------------------
   R1.4.0 换了交互模型。旧模型是 Cropper 的「在相纸上取景」：图像可以拖动、
   捏合缩放，裁剪框也能拖 —— 两条路都能改构图，重复且容易互相打架
   （缩放图 ≠ 缩放框，用户说不清自己在改哪个）。

   新模型：照片是一张钉在相纸上的相片。
     · 上传后按原始比例完整显示（横图横、竖图竖，四周留白，不裁不缩）
     · 照片不动：不缩放、不平移；方向不对就整格转 90°（rotateQuarter）
     · 编辑只动取景框：拖动移动、拖四角改大小、滑块微调角度
     · 预览与输出都从「取景框内的那块像素」重采样

   同一版后续：取景框恒为**相纸比例**。「特效 → 白边」不再缩画布，
   而是盖在照片上的一层白 —— 改特效只影响像素，不会把框弄小。

   坐标一律用**原图像素**（cx/cy = 框中心，w/h = 框尺寸，rot = 角度）。
   照片转过整格后宽高互换（世界尺寸 = worldW/worldH），坐标活在「世界」里，
   与屏幕尺寸、相纸尺寸彻底解耦，窗口怎么变、面板开合多少次都不会漂。
   ================================================================== */
var crop = null;              /* { cx, cy, w, h, rot }，单位 = 原图像素 */
var cropReady = false;        /* 照片已就位，可以画预览 */
var autoCompose = false;      /* 新图上传后自动进构图 */
var imgW0 = 0, imgH0 = 0;     /* 原图自然尺寸 */
var imgQ = 0;                 /* 照片整格旋转：0/1/2/3 = 0° / 90° / 180° / 270° */
var CROP_MIN = 40;            /* 取景框最小边（原图像素） */
var CROP_MAX_ROT = 45;        /* 取景框微调角度上限（整格旋转走 imgQ，见 rotateQuarter） */

/* 照片转过 90° 的奇数倍后，宽高互换 —— 这叫「世界尺寸」，
   取景框坐标全部活在世界里，所以转 90° 只需要换这两个数。 */
function worldW(){ return (imgQ & 1) ? imgH0 : imgW0; }
function worldH(){ return (imgQ & 1) ? imgW0 : imgH0; }

/* ---------- 几何 ---------- */

/* 照片在世界里的显示位置与缩放。
   照片按 contain 完整显示：k = min(可用宽/图宽, 可用高/图高)。
   #cropStage 现在恒等于整张相纸（留白不再缩它），所以这里的可用区就是相纸。 */
function cropMetrics(){
  var cs = $("cropStage");
  if (!cs || !imgW0 || !imgH0) return null;
  var cw = cs.clientWidth, ch = cs.clientHeight;
  if (cw < 8 || ch < 8) return null;
  var w0 = worldW(), h0 = worldH();
  var k = Math.min(cw / w0, ch / h0);
  return { k: k, w: w0 * k, h: h0 * k,
           x: (cw - w0 * k) / 2, y: (ch - h0 * k) / 2 };
}

/* 当前角度下，框最多能开多大（保证旋转后的外接矩形仍落在图内） */
function cropMaxW(){
  var a = (crop ? crop.rot : 0) * Math.PI / 180;
  var ac = Math.abs(Math.cos(a)), as = Math.abs(Math.sin(a));
  var ar = contentAR();
  return Math.min(worldW() / (ac + as / ar), worldH() / (as + ac / ar));
}

/* 把框夹回图内：先限尺寸，再限中心（旋转后按外接矩形判断）。
   框比图还大时干脆居中，否则会左右跳。 */
function clampCrop(){
  if (!crop || !imgW0 || !imgH0) return;
  var cap = Math.max(CROP_MIN, cropMaxW());
  crop.w = clamp(crop.w, Math.min(CROP_MIN, cap), cap);
  crop.h = crop.w / contentAR();

  var a = crop.rot * Math.PI / 180;
  var ac = Math.abs(Math.cos(a)), as = Math.abs(Math.sin(a));
  var hw = (crop.w * ac + crop.h * as) / 2;
  var hh = (crop.w * as + crop.h * ac) / 2;
  var WW = worldW(), WH = worldH();
  crop.cx = (hw * 2 >= WW) ? WW / 2 : clamp(crop.cx, hw, WW - hw);
  crop.cy = (hh * 2 >= WH) ? WH / 2 : clamp(crop.cy, hh, WH - hh);
}

/* 把状态画到 DOM：照片位置 + 取景框位置/尺寸/角度 */
function layoutCrop(){
  var m = cropMetrics();
  if (!m) return;
  var ib = $("cropImg");
  /* 转了 90°/270° 时，元素自身宽高互换再 CSS 旋转 —— 视觉上正好填满世界矩形，
     但 <img> 里的像素没被动过，取帧那步（cropRender）用同样的角度重画。 */
  var sw = m.w, sh = m.h;
  if (imgQ & 1){ sw = m.h; sh = m.w; }
  ib.style.left   = Math.round(m.x + (m.w - sw) / 2) + "px";
  ib.style.top    = Math.round(m.y + (m.h - sh) / 2) + "px";
  ib.style.width  = Math.round(sw) + "px";
  ib.style.height = Math.round(sh) + "px";
  ib.style.transform = "rotate(" + (imgQ * 90) + "deg)";

  layoutPadMask();

  if (!crop || !cropReady) return;
  var bx = $("cropBox");
  bx.style.width  = Math.round(crop.w * m.k) + "px";
  bx.style.height = Math.round(crop.h * m.k) + "px";
  bx.style.left   = Math.round(m.x + crop.cx * m.k) + "px";
  bx.style.top    = Math.round(m.y + crop.cy * m.k) + "px";
  bx.style.transform = "translate(-50%,-50%) rotate(" + crop.rot.toFixed(2) + "deg)";
}

/* 留白蒙版（真实输出会盖白的那几块）在构图区里也画出来，
   否则用户不知道「白边会挡掉哪一部分」。它纯展示：不吃事件、不改取景框。 */
function layoutPadMask(){
  var el = $("cropPadMask");
  if (!el) return;
  var cs = $("cropStage");
  var p = padSides();
  var on = (MODE === 0) && (p.t || p.b || p.l || p.r) && cs && cs.clientWidth > 8;
  if (!on){ el.style.display = "none"; return; }
  var sx = cs.clientWidth / EW, sy = cs.clientHeight / EH;
  var k = el.children;
  el.style.display = "block";
  var px = [
    [0, 0, cs.clientWidth, p.t * sy],
    [0, cs.clientHeight - p.b * sy, cs.clientWidth, p.b * sy],
    [0, p.t * sy, p.l * sx, cs.clientHeight - (p.t + p.b) * sy],
    [cs.clientWidth - p.r * sx, p.t * sy, p.r * sx, cs.clientHeight - (p.t + p.b) * sy]
  ];
  for (var i = 0; i < k.length && i < px.length; i++){
    var d = px[i];
    k[i].style.left   = Math.round(d[0]) + "px";
    k[i].style.top    = Math.round(d[1]) + "px";
    k[i].style.width  = Math.max(0, Math.round(d[2])) + "px";
    k[i].style.height = Math.max(0, Math.round(d[3])) + "px";
    k[i].style.display = (d[2] > 0.5 && d[3] > 0.5) ? "block" : "none";
  }
}

/* ---------- 取帧 ---------- */

function cropInvalid(){
  for (var i = 0; i < cropCache.length; i++){ cropCache[i].sig = ""; cropCache[i].cv = null; }
}

/* 从原图取「取景框内的那块」，重采样到 cw×ch。
   做法：把世界先转正（-rot），再把框中心挪到画布中心，最后按 cw/框宽 缩放。
   框外的部分（旋转后露出的角）填白 —— 与旧的 Cropper fillColor 一致。 */
function cropRender(cw, ch){
  var cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(cw));
  cv.height = Math.max(1, Math.round(ch));
  var x = cv.getContext("2d");
  x.fillStyle = "#fff";
  x.fillRect(0, 0, cv.width, cv.height);
  if (!img || !crop || !crop.w) return cv;

  var s = cv.width / crop.w;
  x.save();
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = "high";
  x.translate(cv.width / 2, cv.height / 2);
  x.rotate(-crop.rot * Math.PI / 180);
  x.scale(s, s);
  x.translate(-crop.cx, -crop.cy);
  /* 整格旋转：绕照片自身中心转 imgQ×90°。
     q=0 时就是原来那句 drawImage(img,0,0)（世界 = 图片坐标）。 */
  try {
    if (imgQ){
      x.translate(worldW() / 2, worldH() / 2);
      x.rotate(imgQ * Math.PI / 2);
      x.drawImage(img, -imgW0 / 2, -imgH0 / 2);
    } else {
      x.drawImage(img, 0, 0);
    }
  } catch(e){}
  x.restore();
  return cv;
}

/* ---------- 生命周期 ---------- */

function initCrop(){
  if (!img || MODE !== 0) return;
  var w0 = img.naturalWidth || img.width || 0;
  var h0 = img.naturalHeight || img.height || 0;
  if (!w0 || !h0) return;
  imgW0 = w0; imgH0 = h0;
  imgQ = 0;                  /* 换图 = 方向从零开始，不继承上一张的 90° */

  $("rotRange").value = curRot;
  $("o-rot").textContent = curRot;
  cropImgEl.src = img.src;
  cropReady = true;
  cropMax();                 /* 默认铺满 + 居中；内部会重画预览 */

  /* 新图上传后自动弹出构图面板（照片已就位，直接切视图即可） */
  if (autoCompose){
    autoCompose = false;
    if (MODE === 0 && img) openTool("compose");
  }
}

function destroyCrop(){
  cropReady = false;
  crop = null;
  imgW0 = imgH0 = 0;
  imgQ = 0;
  cropInvalid();
  layoutPadMask();
}

function syncRotUI(){
  $("rotRange").value = curRot;
  $("o-rot").textContent = curRot;
}

/* 滑块 / 按钮改角度：只转取景框，照片不动 */
function setRot(a){
  if (!crop) return;
  a = clamp(Math.round(a), -CROP_MAX_ROT, CROP_MAX_ROT);
  if (Math.abs(a) <= 2) a = 0;          /* 贴着 0 就归零，方便摆正 */
  if (a === crop.rot){ syncRotUI(); return; }
  crop.rot = a; curRot = a; cfg.cropRot = a; syncRotUI(); saveCfg();
  clampCrop(); layoutCrop(); cropInvalid(); schedulePreview(true);
}

/* 铺满：当前角度下最大可能框，居中 */
function cropMax(){
  if (!imgW0 || !imgH0) return;
  if (!crop) crop = { cx: 0, cy: 0, w: 1, h: 1, rot: 0 };
  crop.rot = clamp(Math.round(curRot), -CROP_MAX_ROT, CROP_MAX_ROT);
  crop.w = Math.max(CROP_MIN, cropMaxW());
  crop.h = crop.w / contentAR();
  crop.cx = worldW() / 2; crop.cy = worldH() / 2;
  clampCrop(); layoutCrop(); cropInvalid(); schedulePreview(false);
}

/* 居中：尺寸不变，只把框挪到图中心 */
function cropCenter(){
  if (!crop) return;
  crop.cx = worldW() / 2; crop.cy = worldH() / 2;
  clampCrop(); layoutCrop(); cropInvalid(); schedulePreview(false);
}

/* 整格 90°：动的是**照片**，不是取景框。
   dir = +1 顺时针 / -1 逆时针。取景框是相纸窗口，尺寸和角度都不变；
   框心跟着「它底下那块照片内容」一起转，所以转完看到的是同一处取景，
   只是照片方向摆正了（横拍竖拍都归位）。 */
function rotateQuarter(dir){
  if (!crop || !cropReady || !imgW0 || !imgH0) return;
  var atMax = crop.w >= cropMaxW() - 1;        /* 转前是「铺满」就转完还铺满 */
  var c0 = { x: worldW() / 2, y: worldH() / 2 };
  var dx = crop.cx - c0.x, dy = crop.cy - c0.y;
  imgQ = mod(imgQ + (dir > 0 ? 1 : -1), 4);
  var c1 = { x: worldW() / 2, y: worldH() / 2 };
  /* 世界坐标随内容顺时针转 90°：(dx,dy) → (-dy,dx)；逆时针取反 */
  if (dir > 0){ crop.cx = c1.x - dy; crop.cy = c1.y + dx; }
  else        { crop.cx = c1.x + dy; crop.cy = c1.y - dx; }
  if (atMax) crop.w = Math.max(CROP_MIN, cropMaxW());
  clampCrop(); layoutCrop(); cropInvalid(); schedulePreview(false);
}

/* 回正：照片回到上传时的方向（imgQ=0），取景框跟着铺满复位。
   转错方向时点这个比再点三次 90° 快，也比连点三次少三次全量重绘。 */
function imgUpright(){
  if (!cropReady) return;
  imgQ = 0;
  cropMax();
  layoutCrop();
}

/* ---------- 拖动取景框 ---------- */
var cropDrag = null;

function cropDown(ev){
  if (!cropReady || !crop) return;
  var m = cropMetrics();
  if (!m) return;
  var t = ev.target;
  var hh = (t && t.dataset && t.dataset.h) || "";
  cropDrag = {
    hx: hh ? (hh.indexOf("w") >= 0 ? -1 : 1) : 0,
    hy: hh ? (hh.indexOf("n") >= 0 ? -1 : 1) : 0,
    sx: ev.clientX, sy: ev.clientY, k: m.k,
    c0: { cx: crop.cx, cy: crop.cy, w: crop.w, h: crop.h }
  };
  if (cropBoxEl.setPointerCapture && ev.pointerId != null){
    try { cropBoxEl.setPointerCapture(ev.pointerId); } catch(e){}
  }
  ev.preventDefault();
}

function cropMove(ev){
  if (!cropDrag || !crop) return;
  var dx = (ev.clientX - cropDrag.sx) / cropDrag.k;
  var dy = (ev.clientY - cropDrag.sy) / cropDrag.k;
  var a = crop.rot * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  var c0 = cropDrag.c0;

  if (!cropDrag.hx && !cropDrag.hy){
    /* 整体移动 */
    crop.cx = c0.cx + dx;
    crop.cy = c0.cy + dy;
  } else {
    /* 指针位移投影到取景框自身的两条轴上（框转过角度时必须这么算） */
    var lx =  dx * cs + dy * sn;
    var ly = -dx * sn + dy * cs;
    /* 比例锁定：取「相对变化更大」的那根轴当主导，避免斜着拖发涩 */
    var k1 = (c0.w + cropDrag.hx * lx) / c0.w;
    var k2 = (c0.h + cropDrag.hy * ly) / c0.h;
    var kk = Math.abs(k1 - 1) > Math.abs(k2 - 1) ? k1 : k2;
    var w1 = clamp(c0.w * kk, CROP_MIN, Math.max(CROP_MIN, cropMaxW()));
    var h1 = w1 / contentAR();

    /* 对角点不动：先从旧框推出锚点，再从锚点推新中心 */
    var ax = c0.cx - cropDrag.hx * c0.w / 2 * cs + cropDrag.hy * c0.h / 2 * sn;
    var ay = c0.cy - cropDrag.hx * c0.w / 2 * sn - cropDrag.hy * c0.h / 2 * cs;
    crop.w = w1; crop.h = h1;
    crop.cx = ax + cropDrag.hx * w1 / 2 * cs - cropDrag.hy * h1 / 2 * sn;
    crop.cy = ay + cropDrag.hx * w1 / 2 * sn + cropDrag.hy * h1 / 2 * cs;
  }
  clampCrop();
  layoutCrop();
  ev.preventDefault();
}

function cropUp(){
  if (!cropDrag) return;
  cropDrag = null;
  cropInvalid();
  schedulePreview(false);
}

/* ---------- 模板遮挡区（构图区里的提示） ---------- */
/* 模板只画一层蒙版，**不缩照片、不动取景框** —— 这里把「模板会盖掉的四块」
   四边宽度算出来，构图区用它画一层半透明遮罩，让人看得见哪一块会被挡掉。
   R1.4.5 起不再有可调白边，四边宽度完全由模板决定。 */
function padSides(){
  var r = (typeof tplRect === "function") ? tplRect() : [0, 0, 1, 1];
  return {
    t: Math.round(r[1] * EH),
    b: Math.round((1 - r[1] - r[3]) * EH),
    l: Math.round(r[0] * EW),
    r: Math.round((1 - r[0] - r[2]) * EW)
  };
}

/* 铺满 / 居中 / 90° / 回正 现在都是「三级选项里的动作」，
   由 50-ui.js 的 lvlAct 调用；这里只留滑块自己的接线。 */
$("rotRange").addEventListener("input", function(){
  $("o-rot").textContent = $("rotRange").value;
});
$("rotRange").addEventListener("change", function(){ setRot(+$("rotRange").value); });

var cropBoxEl = $("cropBox");
cropBoxEl.addEventListener("pointerdown", cropDown);
window.addEventListener("pointermove", cropMove, { passive: false });
window.addEventListener("pointerup", cropUp);
window.addEventListener("pointercancel", cropUp);
