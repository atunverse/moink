/* ==================================================================
   12-render.js —— 合成渲染（文字 / 底图 / 实时拖动）
   ================================================================== */
/* ==================================================================
   渲染与打包（与固件帧契约一致）
   ================================================================== */
function isCJK(ch){
  var c = ch.charCodeAt(0);
  return (c >= 0x2E80 && c <= 0x9FFF) || (c >= 0x3000 && c <= 0x303F) ||
         (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF00 && c <= 0xFFEF);
}
function wrapText(ctx, text, maxW){
  var out = [];
  var paras = String(text).split(/\r?\n/);
  for (var p = 0; p < paras.length; p++){
    var s = paras[p];
    if (!s.length){ out.push(""); continue; }
    var line = "";
    for (var i = 0; i < s.length; i++){
      var ch = s.charAt(i);
      var test = line + ch;
      if (line.length && ctx.measureText(test).width > maxW){
        var sp = -1;
        if (!isCJK(ch)){
          for (var k = line.length - 1; k > 0 && (line.length - k) < 16; k--){
            if (line.charAt(k) === " "){ sp = k; break; }
          }
        }
        if (sp > 0){ out.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
        else { out.push(line); line = ch; }
      } else { line = test; }
    }
    if (line.length) out.push(line);
  }
  return out;
}
/* R1.4.5：照片恒按**整张相纸**渲染，模板只是叠加在上面的蒙版图层。
   模板会盖白白边、画边框，但**一律不碰取景框几何** ——
   换模板时构图纹丝不动，不会出现「切一次模板框就变小」。
   所以这里恒等于相纸，contentAR 也恒定，裁剪逻辑完全不用改。 */
function contentRect(){ return { x:0, y:0, w:EW, h:EH }; }
function contentAR(){ return EW / EH; }
/* 文字对象绘制：坐标/字号按逻辑屏 768x552 存储，s 为当前画布缩放；
   透明底 + 可选描边（默认白边）保证图上可读；只画调色板色，读回时 snapIdx 吸附。 */
/* 文字实测度量（R1.0.15 Fabric 模式）：wrapText + measureText 得出实际渲染包围盒，
   画布绘制与 DOM 手柄框共用同一几何，手柄永远紧贴文字。
   度量画布惰性创建（smoke 纯函数段无 document，顶层不能碰 DOM）。 */
var _mCtx = null;
function measureCtx2(){
  if (!_mCtx) _mCtx = document.createElement("canvas").getContext("2d");
  return _mCtx;
}
function objMetrics(o, s){
  if (o && o.type === "stk")
    return { lines:[], mw:(+o.w||0)*s, blockH:(+o.h||0)*s, lh:0, pX:0, pY:0, stk:true };
  if (o && o.type === "date" && typeof dateMetrics === "function")
    return dateMetrics(o, s);
  var t = String(o.text == null ? "" : o.text);
  var f = FONTS[clamp(+o.font|0, 0, FONTS.length-1)];
  var sz = Math.max(6, (+o.size||48)*s);
  var mc = measureCtx2();
  mc.font = f.w + " " + sz + "px " + f.css;
  var maxW = (+o.wrap ? +o.wrap*s : EW*0.94*s);
  var lines = t.replace(/\s+$/, "") ? wrapText(mc, t, maxW) : [];
  var lh = Math.round(sz*1.35), blockH = lines.length*lh, mw = 0, j;
  for (j = 0; j < lines.length; j++) mw = Math.max(mw, mc.measureText(lines[j]).width);
  /* 设了固定宽度就以设定值为框宽：短文字也能看见并拖动宽度手柄 */
  if (+o.wrap) mw = Math.max(mw, +o.wrap*s);
  return { lines:lines, mw:mw, blockH:blockH, lh:lh, pX:sz*0.28, pY:sz*0.18 };
}
/* 贴纸位图缓存：同一张图只解码一次；解码完成再重排一次预览，
   否则首帧画不到图，用户会以为「点了没反应」。 */
var _stkImg = {};
function stkImg(src){
  if (!src) return null;
  if (!_stkImg[src]){
    var im = new Image();
    im.onload = function(){ if (typeof schedulePreview === "function") schedulePreview(false); };
    im.src = src;
    _stkImg[src] = im;
  }
  return _stkImg[src];
}
/* 贴纸三种来源：
     img   = 上传的图片（原色，不跟调色板）
     glyph = 图标字形（跟四色调色板，所以能换颜色）
     emoji = 输入法表情（系统彩色 emoji 字体，本身就是彩色，不选色） */
var EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif';
function drawObj(ctx, o, cw, measured){
  if (o && o.type === "date" && typeof drawDate === "function"){
    drawDate(ctx, o, cw);
    return;
  }
  if (o && o.type === "stk"){
    var ss = cw / EW;
    var w = (+o.w || 0) * ss, h = (+o.h || 0) * ss;
    if (!w || !h) return;
    ctx.save();
    ctx.translate((+o.x||0)*ss, (+o.y||0)*ss);
    ctx.rotate((+o.rot||0)*Math.PI/180);
    if (o.kind === "img" || o.src){
      var im = stkImg(o.src);
      if (!im || !im.complete || !im.naturalWidth){ ctx.restore(); return; }
      ctx.drawImage(im, -w/2, -h/2, w, h);
    } else {
      var ch = String(o.ch || "★");
      var emo = (o.kind === "emoji");
      /* 字形按 w / h 分别缩放（用户要求宽度手柄能把贴纸拉变形）。
         基准字号用 h，再在 x 方向乘 w/h —— 等比时和原来一样，
         拖宽度柄后只改 w，字就被横向拉伸，不再被 Math.min 吃掉。 */
      var sz = h * (emo ? 0.82 : 0.9);
      var sx = w / Math.max(1, h);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = sz + "px " + (emo ? EMOJI_FONT : 'system-ui,-apple-system,"Segoe UI Symbol",sans-serif');
      /* 只有图标（字形）跟四色调色板；表情是彩色字体，给黑也不会上色，
         万一设备没有彩色 emoji 字体，也只是画成黑色轮廓，不会变成红/黄一坨。 */
      if (emo){
        ctx.fillStyle = "#000";
      } else {
        var fg = PAL[clamp(+o.color|0, 0, 3)];
        ctx.fillStyle = "rgb(" + fg[0] + "," + fg[1] + "," + fg[2] + ")";
      }
      ctx.save();
      ctx.scale(sx, 1);
      ctx.fillText(ch, 0, h * 0.02);
      ctx.restore();
    }
    ctx.restore();
    return;
  }
  var t = String(o.text == null ? "" : o.text);
  if (!t.replace(/\s+$/, "")) return;
  var s = cw / EW;
  var m = measured || objMetrics(o, s);
  if (!m.lines.length) return;
  ctx.save();
  ctx.translate((+o.x||0)*s, (+o.y||0)*s);
  ctx.rotate((+o.rot||0)*Math.PI/180);
  var f = FONTS[clamp(+o.font|0, 0, FONTS.length-1)];
  var sz = Math.max(6, (+o.size||48)*s);
  ctx.font = f.w + " " + sz + "px " + f.css;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  if (+o.bg >= 1){
    var bgp = PAL[[1, 0, 2, 3][+o.bg - 1]];   /* R1.0.19 四色底：1白 2黑 3黄 4红 */
    ctx.fillStyle = "rgb(" + bgp[0] + "," + bgp[1] + "," + bgp[2] + ")";
    ctx.fillRect(-m.mw/2 - m.pX, -m.blockH/2 - m.pY, m.mw + m.pX*2, m.blockH + m.pY*2);
  }
  var fg = PAL[clamp(+o.color|0, 0, 3)];
  var sw = clamp(+o.stroke||0, 0, 10) * s;
  for (var j = 0; j < m.lines.length; j++){
    var yy = -m.blockH/2 + m.lh/2 + j*m.lh;
    if (sw > 0){
      ctx.lineWidth = sw*2; ctx.lineJoin = "round";
      var sp = PAL[clamp(+o.strokeC|0, 0, 3)];   /* R1.0.19 四色描边 */
      ctx.strokeStyle = "rgb(" + sp[0] + "," + sp[1] + "," + sp[2] + ")";
      ctx.strokeText(m.lines[j], 0, yy);
    }
    ctx.fillStyle = "rgb("+fg[0]+","+fg[1]+","+fg[2]+")";
    ctx.fillText(m.lines[j], 0, yy);
  }
  ctx.restore();
}
/* ---------- 位图贴纸：走照片同一条流水线（风格化 + 抖动） ----------
   表情和上传图片本身就是连续色调，直接 snapIdx 到四色会碎成一堆红黄黑斑点
   （实测「噪点一堆、很不好看」）。所以它们和照片一样过 warmMap + quantize，
   区别只有一处：渲染范围锁在贴纸自己的包围盒里，只有它覆盖到的像素参与，
   包围盒内的背景一个像素都不动 —— 否则贴纸边上会多出一圈脏点。 */
function isStkRaster(o){
  return !!(o && o.type === "stk" && (o.kind === "img" || o.kind === "emoji" || o.src));
}
/* 贴纸的局部 cfg：颜色处理与照片**完全一致**（用户 11-17 反馈：贴纸明显比背景灰）。
   ★ 关键两处：
     ① autoLevels 打开 —— 和照片共用同一条暖色映射（含 0.005 裁剪），
        颜色才不会显得低一档。透明区在调用方已垫平均色，不会带偏直方图。
     ② coolDesat / coolPull 归零 —— 这两个参数会把偏冷的颜色拉灰，
        照片上是为了统一暖色调，贴纸上只会让彩色贴纸失色。 */
function stkCfg(){
  var c = {};
  for (var k in cfg) c[k] = cfg[k];
  c.autoLevels = 1;
  c.coolDesat = 0;
  c.coolPull = 0;
  return c;
}
/* 贴纸包围盒（含旋转后的外接矩形），外扩 3px 给误差扩散留余量 */
function stkBox(o, cw, ch){
  var s = cw / EW;
  var w = Math.abs(+o.w || 0) * s, h = Math.abs(+o.h || 0) * s;
  if (!w || !h) return null;
  var r = (+o.rot || 0) * Math.PI / 180;
  var ca = Math.abs(Math.cos(r)), sa = Math.abs(Math.sin(r));
  var bw = w*ca + h*sa, bh = w*sa + h*ca;
  var cx = (+o.x || 0) * s, cy = (+o.y || 0) * s;
  var pad = 3;
  var x0 = Math.max(0, Math.floor(cx - bw/2) - pad);
  var y0 = Math.max(0, Math.floor(cy - bh/2) - pad);
  var x1 = Math.min(cw, Math.ceil(cx + bw/2) + pad);
  var y1 = Math.min(ch, Math.ceil(cy + bh/2) + pad);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x:x0, y:y0, w:x1-x0, h:y1-y0 };
}
function drawStkRaster(ctx, o, cw, ch){
  var bb = stkBox(o, cw, ch);
  if (!bb) return;
  var w = bb.w, h = bb.h, n = w*h, i;
  /* 1) 先把贴纸画到一张透明小画布上（坐标平移进包围盒） */
  var tk = document.createElement("canvas");
  tk.width = w; tk.height = h;
  var tx = tk.getContext("2d", { willReadFrequently:true });
  tx.save(); tx.translate(-bb.x, -bb.y);
  drawObj(tx, o, cw);
  tx.restore();
  var td = tx.getImageData(0, 0, w, h).data;
  /* 2) 透明区垫成「平均不透明色」，免得一堆 0（黑）混进风格化统计 */
  var sr = 0, sg = 0, sb = 0, cnt = 0;
  for (i = 0; i < n; i++){
    if (td[i*4+3] > 8){
      sr += td[i*4]; sg += td[i*4+1]; sb += td[i*4+2]; cnt++;
    }
  }
  if (!cnt) return;
  sr /= cnt; sg /= cnt; sb /= cnt;
  var buf = new Float64Array(n*3), mask = new Uint8Array(n);
  for (i = 0; i < n; i++){
    if (td[i*4+3] > 8){
      buf[i*3] = td[i*4]; buf[i*3+1] = td[i*4+1]; buf[i*3+2] = td[i*4+2];
      mask[i] = 1;
    } else {
      buf[i*3] = sr; buf[i*3+1] = sg; buf[i*3+2] = sb;
    }
  }
  /* 3) 风格化 → 与底下画面按 alpha 合成 → 带 mask 的抖动量化 */
  var mapped = warmMap(buf, w, h, stkCfg());
  var bgd = ctx.getImageData(bb.x, bb.y, w, h).data;
  var comp = new Float64Array(n*3);
  for (i = 0; i < n; i++){
    var aa = mask[i] ? td[i*4+3]/255 : 0, ia = 1 - aa;
    comp[i*3]   = mapped[i*3]   * aa + bgd[i*4]   * ia;
    comp[i*3+1] = mapped[i*3+1] * aa + bgd[i*4+1] * ia;
    comp[i*3+2] = mapped[i*3+2] * aa + bgd[i*4+2] * ia;
  }
  var qi = quantize(comp, w, h, cfg, mask);
  /* 4) 只写回贴纸覆盖的像素；其余原样搬回，避免一次 getImageData 就丢了 */
  var im = ctx.createImageData(w, h), dd = im.data;
  for (i = 0; i < n; i++){
    if (mask[i]){
      var p = PAL[qi[i] & 3];
      dd[i*4] = p[0]; dd[i*4+1] = p[1]; dd[i*4+2] = p[2]; dd[i*4+3] = 255;
    } else {
      dd[i*4] = bgd[i*4]; dd[i*4+1] = bgd[i*4+1];
      dd[i*4+2] = bgd[i*4+2]; dd[i*4+3] = bgd[i*4+3];
    }
  }
  ctx.putImageData(im, bb.x, bb.y);
}
/* raster=true：位图贴纸逐张走上面的流水线（只在最终合成时用）；
   缩略图与拖动预览用原色直画 —— 图太小 / 帧太密，抖动反而看不清。 */
function drawObjs(ctx, objs, cw, ch, raster){
  if (!objs || !objs.length) return;
  for (var i = 0; i < objs.length; i++){
    if (raster && isStkRaster(objs[i])) drawStkRaster(ctx, objs[i], cw, ch);
    else drawObj(ctx, objs[i], cw);
  }
}
function toBuf(canvas){
  var w = canvas.width, h = canvas.height;
  var d = canvas.getContext("2d").getImageData(0,0,w,h).data;
  var n = w*h, buf = new Float64Array(n*3);
  for (var i = 0; i < n; i++){
    buf[i*3] = d[i*4]; buf[i*3+1] = d[i*4+1]; buf[i*3+2] = d[i*4+2];
  }
  return buf;
}
/* 文字不参与风格化：图像层单独走 warmMap + quantize（抖动/色调只作用于图像），
   文字以纯调色板色最后叠加，读回时就近吸附调色板（文字边缘干净、无抖动）。 */
function snapIdx(r, g, b){
  var best = 0, bd = Infinity;
  for (var i = 0; i < PAL.length; i++){
    var p = PAL[i];
    var dr = r - p[0], dg = g - p[1], db = b - p[2];
    var d = dr*dr + dg*dg + db*db;
    if (d < bd){ bd = d; best = i; }
  }
  return best;
}
/* FB-007：cropCache 双槽 LRU。预览与输出两种画布尺寸交替时单槽会互相冲掉，
   双槽让两路签名同时保活（t = 最近使用序号，淘汰最久未用的一槽）。 */
var cropCache = [ { sig:"", cv:null, t:0 }, { sig:"", cv:null, t:0 } ];
var cropCacheTick = 0;
/* 取帧签名：只要取景框（图像像素坐标 + 角度）或目标尺寸变了，缓存就失效。 */
function cropSig(cw, ch){
  if (!cropReady || !crop) return "";
  return [cw, ch, imgQ, Math.round(crop.cx), Math.round(crop.cy),
          Math.round(crop.w), Math.round(crop.h),
          Math.round(crop.rot * 10)].join(",");
}
function getCropCanvas(cw, ch){
  var sig = cropSig(cw, ch);
  if (sig){
    for (var i = 0; i < cropCache.length; i++){
      if (cropCache[i].sig === sig && cropCache[i].cv){
        cropCache[i].t = ++cropCacheTick;
        return cropCache[i].cv;
      }
    }
  }
  var cv = cropRender(cw, ch);
  if (sig){
    var slot;
    if (!cropCache[0].sig)      slot = 0;
    else if (!cropCache[1].sig) slot = 1;
    else slot = (cropCache[0].t <= cropCache[1].t) ? 0 : 1;
    cropCache[slot].sig = sig; cropCache[slot].cv = cv;
    cropCache[slot].t = ++cropCacheTick;
  }
  return cv;
}
/* 底图（L0+L1，无文字）：拍立得 = 白底+留白+风格化图像层；便签 = 纯底色。
   R1.0.15 拖动实时重绘：底图量化只在手势开始做一次（renderLiveBase 缓存画布），
   文字每帧矢量重画 —— 画布是唯一视觉源，拖动中每帧即最终合成效果。 */
function drawBase(ctx, cw, ch){
  if (MODE === 0){
    /* L0 白底（含留白区）→ L1 图像层（风格化+抖动只作用此层） */
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
    if (img && cropReady){
      var sc = cw / EW;
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
    drawTpl(ctx, cw, ch);       /* 边框：照片之上、文字之下，全部现场绘制 */
  } else {
    /* 便签：结构化文档直接排成四色画面（36-note.js）。纯色直出不抖动，
       仍然走 renderComposite → snapIdx，帧格式与固件一行不动。 */
    noteRender(ctx, cw, ch);
  }
}
function renderComposite(cw, ch){
  var cv = document.createElement("canvas");
  cv.width = cw; cv.height = ch;
  var ctx = cv.getContext("2d", { willReadFrequently: true });
  var objs = (MODE === 0) ? cfg.objsImg : cfg.objsNote;
  drawBase(ctx, cw, ch);
  drawObjs(ctx, objs, cw, ch, true);   /* 位图贴纸在这里与照片同算法抖动 */
  var d = ctx.getImageData(0, 0, cw, ch).data;
  var idx = new Uint8Array(cw * ch);
  for (var i2 = 0; i2 < cw*ch; i2++){
    idx[i2] = snapIdx(d[i2*4], d[i2*4+1], d[i2*4+2]);
  }
  return idx;
}
function renderTo(cv, cw, ch){
  var idx = renderComposite(cw, ch);
  cv.width = cw; cv.height = ch;
  var ctx = cv.getContext("2d");
  var im = ctx.createImageData(cw, ch), dd = im.data;
  for (var i = 0; i < cw*ch; i++){
    var p = PAL[idx[i]];
    dd[i*4] = p[0]; dd[i*4+1] = p[1]; dd[i*4+2] = p[2]; dd[i*4+3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return idx;
}
/* ---------- 拖动实时重绘（缓存图片与未选中文字，每帧只画当前文字） ---------- */
var liveBase = null, liveAbove = null, liveMetric = null, liveRaf = 0;
function renderLiveBase(cw, ch, skipIndex){
  var cv = document.createElement("canvas");
  cv.width = cw; cv.height = ch;
  var ctx = cv.getContext("2d");
  drawBase(ctx, cw, ch);
  var objs = curObjs();
  /* 保留对象叠放顺序：当前文字之前的对象烤入底层，之后的对象缓存为透明上层。 */
  liveAbove = null;
  var aboveCtx = null;
  for (var i = 0; i < objs.length; i++){
    if (i === skipIndex) continue;
    if (skipIndex >= 0 && i > skipIndex){
      if (!liveAbove){
        liveAbove = document.createElement("canvas");
        liveAbove.width = cw; liveAbove.height = ch;
        aboveCtx = liveAbove.getContext("2d");
      }
      drawObj(aboveCtx, objs[i], cw);
    } else drawObj(ctx, objs[i], cw);
  }
  return cv;
}
function liveDraw(){
  liveRaf = 0;
  if (!liveBase) return;
  /* 指针事件可能高于屏幕刷新率；DOM 几何与画布统一在 RAF 中各更新一次。 */
  /* 用布局比例（od.fs），不是位移比例（od.scale）：后者含画布显示缩放 */
  if (od) relayoutOne(od.i, od.act === "m" || od.act === "r", od.fs || od.scale);
  var ctx = prevEl.getContext("2d");
  ctx.drawImage(liveBase, 0, 0);
  if (od){
    var o = curObjs()[od.i];
    if (o){
      if (od.act === "s" || od.act === "wl") liveMetric = objMetrics(o, prevEl.width / EW);
      drawObj(ctx, o, prevEl.width, liveMetric);
    }
  }
  if (liveAbove) ctx.drawImage(liveAbove, 0, 0);   /* 边框在底图里，拖动中也在 */
}
function scheduleLive(){
  if (!liveRaf && liveBase) liveRaf = requestAnimationFrame(liveDraw);
}
function startLive(){
  clearTimeout(previewTimer); previewWant = null;  /* 挂起排队的预览，拖动期间画布归实时重绘管 */
  try {
    prevEl.width = EW; prevEl.height = EH;
    liveBase = renderLiveBase(EW, EH, od ? od.i : -1);
    var o = od && curObjs()[od.i];
    liveMetric = o ? objMetrics(o, 1) : null;
    liveDraw();
  } catch(e){ liveBase = null; liveAbove = null; liveMetric = null; }
}

/* 竖屏桥接：编辑空间(552x768 或 600x800)顺时针转 90° → 设备帧(768x552 或 800x600)。
   方向上机用非对称测试图核对；若相反，把 (W-1-y) 换成 y、x*W 换成 (H-1-x) 即逆时针。 */
function rotateCW(idx, w, h){
  var W = h, out = new Uint8Array(w*h);
  for (var y = 0; y < h; y++){
    for (var x = 0; x < w; x++){
      out[x*W + (W-1-y)] = idx[y*w + x];
    }
  }
  return out;
}
function packIdx(idx){
  var W = PANEL.w, H = PANEL.h, RB = W >> 2;
  var out = new Uint8Array(RB*H);
  for (var r = 0; r < H; r++){
    var ro = (H - 1 - r) * W, bo = r * RB;
    for (var xb = 0; xb < RB; xb++){
      var xa = W - 4 - (xb << 2);
      out[bo + xb] = (idx[ro+xa+3] << 6) | (idx[ro+xa+2] << 4) |
                     (idx[ro+xa+1] << 2) | idx[ro+xa];
    }
  }
  return out;
}
/* 通用几何打包（缩略图用）：契约同 packIdx，几何由参数给出 */
function packIdxGeom(idx, W, H){
  var RB = W >> 2;
  var out = new Uint8Array(RB*H);
  for (var r = 0; r < H; r++){
    var ro = (H - 1 - r) * W, bo = r * RB;
    for (var xb = 0; xb < RB; xb++){
      var xa = W - 4 - (xb << 2);
      out[bo + xb] = (idx[ro+xa+3] << 6) | (idx[ro+xa+2] << 4) |
                     (idx[ro+xa+1] << 2) | idx[ro+xa];
    }
  }
  return out;
}
/* R1.4.0-3：屏幕上下颠倒安装时的 180° 输出旋转。
   packIdx 已内含一次「180° 预旋转」（与固件驱动的底→上行序 + 行内镜像相抵，
   抵消后屏上是正向的）；这里再转一次，屏上画面就整体倒过来，正好补偿倒装。
   只作用于输出帧：预览、图库缩略图仍按正向，避免用户看到「倒着的缩略图」。
   W/H 是设备帧几何（PANEL.w/h，768x552），与编辑空间 EW/EH 无关。 */
function rot180Payload(buf, W, H){
  var RB = W >> 2, out = new Uint8Array(buf.length);
  for (var r = 0; r < H; r++){
    var so = (H - 1 - r) * RB, bo = r * RB;
    for (var i = 0; i < RB; i++){
      var b = buf[so + RB - 1 - i];
      /* 字节内 4 个 2bit 组整体倒序 = 行内左右翻转 */
      out[bo + i] = ((b & 0x03) << 6) | ((b & 0x0C) << 2) |
                    ((b & 0x30) >> 2) | ((b & 0xC0) >> 6);
    }
  }
  return out;
}
function packFull(){
  var p = packIdx(rotateCW(renderComposite(EW, EH), EW, EH));
  if (cfg.vrot) p = rot180Payload(p, PANEL.w, PANEL.h);
  return p;
}
/* R1.3.6：缩略图直接在缩略尺寸（EW/8 × EH/8 = 69x96）上合成——裁剪、
   warmMap、文字全部在小画布完成，不再全尺寸合成再降采样。
   计算量降 ~64 倍（42万像素 → ~6.6千像素），JPEG 缩到 ~2-3KB，
   上传/存储/图库传输同步变快。UI 已是 8 列小格子，69x96 足够清晰。 */
function composeThumbRgb(){
  var tw = Math.max(1, Math.round(EW/8)), th = Math.max(1, Math.round(EH/8));
  var cv = document.createElement("canvas");
  cv.width = tw; cv.height = th;
  var ctx = cv.getContext("2d", { willReadFrequently: true });
  if (MODE === 0){
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, tw, th);
    if (img && cropReady){
      var r0 = contentRect();
      var r = { x:Math.round(r0.x*tw/EW), y:Math.round(r0.y*th/EH),
                w:Math.max(1, Math.round(r0.w*tw/EW)),
                h:Math.max(1, Math.round(r0.h*th/EH)) };
      var cc = getCropCanvas(r.w, r.h);
      if (cc && cc.width && cc.height){
        var mapped = warmMap(toBuf(cc), r.w, r.h, cfg);   /* 彩色风格化，不量化 */
        var im = ctx.createImageData(r.w, r.h), dd = im.data;
        for (var i = 0; i < r.w*r.h; i++){
          dd[i*4] = clamp(mapped[i*3], 0, 255);
          dd[i*4+1] = clamp(mapped[i*3+1], 0, 255);
          dd[i*4+2] = clamp(mapped[i*3+2], 0, 255);
          dd[i*4+3] = 255;
        }
        ctx.putImageData(im, r.x, r.y);
      }
    }
    drawTpl(ctx, tw, th);
  } else {
    /* 图库缩略图也必须和真机同一张便签版式，否则存进图槽后看到的是纯色块。
       tw/th 与 EW/EH 等比，noteRender 内部按 cw/EW 缩放即可。 */
    noteRender(ctx, tw, th);
  }
  var objs = (MODE === 0) ? cfg.objsImg : cfg.objsNote;
  drawObjs(ctx, objs, tw, th);
  return cv;
}
function buildThumbJpeg(){
  var cv = composeThumbRgb();   /* 已是 69x96 小画布，直接编码 */
  var tw = cv.width, th = cv.height;
  var b64 = cv.toDataURL("image/jpeg", 0.72).split(",")[1];
  var bin = atob(b64);
  var body = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) body[i] = bin.charCodeAt(i);
  var hdr = new Uint8Array(16);
  var L = body.length;
  hdr[0] = 0xA5; hdr[1] = 0x5A; hdr[2] = 2; hdr[3] = 0;   /* fmt=2: 彩色 JPEG */
  hdr[4] = (tw >> 8) & 0xFF; hdr[5] = tw & 0xFF;
  hdr[6] = (th >> 8) & 0xFF; hdr[7] = th & 0xFF;
  hdr[8] = (L >>> 24) & 0xFF; hdr[9] = (L >>> 16) & 0xFF;
  hdr[10] = (L >>> 8) & 0xFF; hdr[11] = L & 0xFF;
  hdr[12] = 0; hdr[13] = 0; hdr[14] = 0; hdr[15] = 0;
  var out = new Uint8Array(16 + L);
  out.set(hdr, 0); out.set(body, 16);
  return out;
}
