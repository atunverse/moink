/* ==================================================================
   11-algo.js —— 图像算法【冻结】
   已验证基线的逐像素实现，check_algo.py 会逐像素比对，
   任何改动都必须先在门禁里说明原因，禁止顺手重构。
   ================================================================== */
/* ==================================================================
   std 标准档（FB-002 Stage A 定稿，基线 B2，2026-09-22）
   分通道 decode γ=1.75 + 黄 (255,230,0) / 红 (230,0,0) 目标色（FB-016：原 220 在屏上出现杂点，调整为 230 以消除杂点）。
   参数为真机定稿值，写死不可调（samples/FB-002/校准表-StageA-final.md）；
   check_algo B2：quantize 的 std 注入块剥离后须与 M7 冻结版逐字一致。
   ================================================================== */
var STD_LUT = (function(){
  var lut = [];
  for (var c = 0; c < 3; c++){
    var t = new Float64Array(256);
    for (var i = 0; i < 256; i++) t[i] = 255 * Math.pow(i / 255, 1.75);
    lut.push(t);
  }
  return lut;
})();
var STD_PAL = [
  [0, 0, 0],
  [255, 255, 255],
  [255, STD_LUT[1][230], 0],
  [STD_LUT[0][230], 0, 0]
];

var RAMPS = {
  sunset: [[0,[0,0,0]],[0.10,[26,6,4]],[0.26,[92,18,12]],[0.42,[168,40,16]],
           [0.56,[214,86,18]],[0.70,[236,140,26]],[0.84,[248,200,60]],
           [0.93,[255,235,150]],[1,[255,255,255]]],
  ember:  [[0,[0,0,0]],[0.12,[40,4,0]],[0.28,[120,10,4]],[0.44,[196,28,6]],
           [0.58,[232,74,6]],[0.72,[246,140,10]],[0.86,[252,204,26]],
           [0.95,[255,240,110]],[1,[255,255,255]]],
  duotone:[[0,[0,0,0]],[0.30,[150,20,10]],[0.55,[235,80,10]],
           [0.78,[250,190,20]],[1,[255,255,255]]],
  sepia:  [[0,[22,14,8]],[0.25,[92,66,38]],[0.50,[150,116,72]],
           [0.72,[202,172,124]],[0.88,[232,212,172]],[1,[255,250,236]]]
};

var KERN = {
  fs:     [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]],
  atkinson:[[1,0,1/8],[2,0,1/8],[-1,1,1/8],[0,1,1/8],[1,1,1/8],[0,2,1/8]],
  burkes: [[1,0,8/32],[2,0,4/32],[-2,1,2/32],[-1,1,4/32],[0,1,8/32],[1,1,4/32],[2,1,2/32]],
  sierra: [[1,0,2/4],[-1,1,1/4],[0,1,1/4]],
  stucki: [[1,0,8/42],[2,0,4/42],[-2,1,2/42],[-1,1,4/42],[0,1,8/42],[1,1,4/42],[2,1,2/42],
           [-2,2,1/42],[-1,2,2/42],[0,2,4/42],[1,2,2/42],[2,2,1/42]],
  jarvis: [[1,0,7/48],[2,0,5/48],[-2,1,3/48],[-1,1,5/48],[0,1,7/48],[1,1,5/48],[2,1,3/48],
           [-2,2,1/48],[-1,2,3/48],[0,2,5/48],[1,2,3/48],[2,2,1/48]]
};
var BAYER8 = [ 0,32, 8,40, 2,34,10,42, 48,16,56,24,50,18,58,26,
              12,44, 4,36,14,46, 6,38, 60,28,52,20,62,30,54,22,
               3,35,11,43, 1,33, 9,41, 51,19,59,27,49,17,57,25,
              15,47, 7,39,13,45, 5,37, 63,31,55,23,61,29,53,21];

var WARM_SAT_K = 0.75;
var DEF = {
  mode: "natural",
  brightness: 0, contrast: 0, gamma: 1.00, saturation: 1.00,
  warmCast: 0.40, castRamp: "sunset", warmCenter: 30, warmSpan: 58,
  warmBoost: 0.60, coolPull: 0.25, coolCap: 60, coolDesat: 0.25,
  warmPull: 0.12, warmPullCap: 18,
  autoLevels: 1, sharpen: 0.30,
  dither: "fs", ditherStrength: 0.85, space: "std",
  lastMode: 0, text: "", textFont: 0, textSize: 100,
  textColor: 0, textBg: 0,
  cropRot: 0, tpl: "none",
  objsImg: null, objsNote: null,
  noteDoc: null        /* R1.4.0 便签文档（结构化内容 / 版式 / 主题） */
};

var CORE = {
  natural:  { key: "warmBoost", def: 0.60, lab: "色彩强度",
              hint: "只提亮画面里本来就是暖色的部分，冷色区域保持干净的黑白。" },
  adaptive: { key: "warmCast",  def: 0.40, lab: "暖色浓度",
              hint: "把整圈色相压进红→黄这一段，红黄最多，但照片会明显偏暖。" },
  gray:     { key: null, lab: "色彩强度", hint: "纯灰度，只做明暗抖动。适合文档、线条画。" },
  naive:    { key: null, lab: "色彩强度", hint: "不做任何色彩映射，直接四色抖动。" }
};

var CTRL = [
  { id:"bright",      key:"brightness",     sc:1,   unit:"",  dec:0 },
  { id:"contrast",    key:"contrast",       sc:1,   unit:"",  dec:0 },
  { id:"gamma",       key:"gamma",          sc:100, unit:"×",  dec:2 },
  { id:"sat",         key:"saturation",     sc:100, unit:"%", dec:0 },
  { id:"wcenter",     key:"warmCenter",     sc:1,   unit:"°", dec:0 },
  { id:"wspan",       key:"warmSpan",       sc:1,   unit:"°", dec:0 },
  { id:"coolpull",    key:"coolPull",       sc:100, unit:"%", dec:0 },
  { id:"coolcap",     key:"coolCap",        sc:1,   unit:"°", dec:0 },
  { id:"cooldesat",   key:"coolDesat",      sc:100, unit:"%", dec:0 },
  { id:"warmpull",    key:"warmPull",       sc:100, unit:"%", dec:0 },
  { id:"warmpullcap", key:"warmPullCap",    sc:1,   unit:"°", dec:0 },
  { id:"sharpen",     key:"sharpen",        sc:100, unit:"%", dec:0 },
  { id:"dstr",        key:"ditherStrength", sc:100, unit:"%", dec:0 }
];

function fmtCtrl(c, v){
  /* R1.0.20：纯数值显示（不带 °/%/× 单位）；百分比类 cfg 存 0~1，显示乘 100 */
  var d = (c.unit === "%") ? v * 100 : v;
  var s = c.dec ? d.toFixed(c.dec) : String(Math.round(d));
  if (c.key === "brightness" || c.key === "contrast") s = (d > 0 ? "+" : "") + s;
  return s;
}
/* R1.0.19 抖动算法一句话说明 */
var DMODE_HINT = {
  fs:       "最细腻的误差扩散，通用首选，速度中等。",
  stucki:   "细节与边缘保留更干净，质感接近 Floyd。",
  jarvis:   "颗粒更平滑柔和，过渡自然。",
  burkes:   "轻量快速，颗粒略粗。",
  sierra:   "轻量误差扩散，速度快，质感自然。",
  atkinson: "对比清爽、保留高光，很适合照片。",
  bayer:    "速度最快，带规则网点纹理感。",
  none:     "不做抖动，色块硬边，仅适合纯色图形。"
};
function syncDmodeHint(){
  var el = document.getElementById("dmodeHint");
  if (el) el.textContent = DMODE_HINT[cfg.dither] || "";
}
/* 字体表：前四款的索引固定（存档里的 font 是下标，重排会让老工程换字）。
   之后由 33-text.js 在启动时补上本机探测到的字体和用户临时加载的字体文件。 */
var FONTS = [
  { name:"系统默认", css:"-apple-system,'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif", w:600 },
  { name:"宋体",     css:"'Songti SC','SimSun','Noto Serif CJK SC','Source Han Serif SC',serif",        w:600 },
  { name:"楷体",     css:"'Kaiti SC','KaiTi','STKaiti','SimKai',serif",                                 w:600 },
  { name:"等宽",     css:"ui-monospace,Menlo,Consolas,'Courier New',monospace",                         w:500 }
];

var _rampCache = {};
function rampLut(name){
  if (_rampCache[name]) return _rampCache[name];
  var stops = RAMPS[name] || RAMPS.sunset;
  var N = 256, out = new Float64Array(N*3);
  var xs = [], cs = [[],[],[]];
  for (var s = 0; s < stops.length; s++){
    xs.push(stops[s][0]);
    cs[0].push(stops[s][1][0]); cs[1].push(stops[s][1][1]); cs[2].push(stops[s][1][2]);
  }
  for (var i = 0; i < N; i++){
    var t = i/(N-1), k = 0;
    while (k < xs.length-2 && t >= xs[k+1]) k++;
    for (var c = 0; c < 3; c++){
      var slope = (cs[c][k+1]-cs[c][k])/(xs[k+1]-xs[k]);
      out[i*3+c] = slope*(t-xs[k]) + cs[c][k];
    }
  }
  _rampCache[name] = out;
  return out;
}

function rgb2hsl(r,g,b){
  var mx = Math.max(r,g,b), mn = Math.min(r,g,b), l = (mx+mn)*0.5, d = mx-mn, s, h;
  var den = (l > 0.5) ? (2-mx-mn) : (mx+mn);
  s = (d > 1e-12) ? d/Math.max(den,1e-12) : 0;
  s = clamp(s,0,1);
  if (d > 1e-12){
    var rc = (mx-r)/d, gc = (mx-g)/d, bc = (mx-b)/d, hh;
    if (mx === r) hh = bc-gc; else if (mx === g) hh = 2+rc-bc; else hh = 4+gc-rc;
    h = mod(hh/6, 1);
  } else h = 0;
  return [h,s,l];
}
function hue2rgb(p,q,t){
  t = mod(t,1);
  if (t < 1/6) return p+(q-p)*6*t;
  if (t < 0.5) return q;
  if (t < 2/3) return p+(q-p)*(2/3-t)*6;
  return p;
}
function hsl2rgb(h,s,l){
  var q = (l < 0.5) ? l*(1+s) : l+s-l*s, p = 2*l-q;
  return [hue2rgb(p,q,h+1/3), hue2rgb(p,q,h), hue2rgb(p,q,h-1/3)];
}
function warmAffinity(hd){
  var t_hi = clamp((hd-300)/50, 0, 1);
  var t_lo = clamp((hd-60)/50, 0, 1);
  if (hd > 300) return t_hi*t_hi*(3-2*t_hi);
  if (hd < 110) return 1 - t_lo*t_lo*(3-2*t_lo);
  return 0;
}

function autoLevels(buf, n, clipv){
  var hist = new Float64Array(256), i, L;
  for (i = 0; i < n; i++){
    L = luma(buf[i*3], buf[i*3+1], buf[i*3+2]);
    hist[clamp(Math.floor(L+0.5),0,255)]++;
  }
  var target = clipv*n, c = 0, lo = 0, hi = 255;
  for (i = 0; i < 256; i++){ c += hist[i]; if (c >= target){ lo = i; break; } }
  c = 0;
  for (i = 0; i < 256; i++){ c += hist[i]; if (c >= (1-clipv)*n){ hi = i; break; } }
  if (hi-lo < 8) return;
  var scale = (246-18)/(hi-lo);
  for (i = 0; i < n*3; i++) buf[i] = (buf[i]-lo)*scale + 18;
}

function blur3(src, w, h){
  var tmp = new Float64Array(w*h*3), out = new Float64Array(w*h*3);
  var x, y, c, o, xm, xp, ym, yp;
  for (y = 0; y < h; y++) for (x = 0; x < w; x++){
    xm = (x-1 < 0) ? 0 : x-1; xp = (x+1 >= w) ? w-1 : x+1;
    o = (y*w+x)*3;
    for (c = 0; c < 3; c++)
      tmp[o+c] = src[(y*w+xm)*3+c] + 2*src[(y*w+x)*3+c] + src[(y*w+xp)*3+c];
  }
  for (y = 0; y < h; y++) for (x = 0; x < w; x++){
    ym = (y-1 < 0) ? 0 : y-1; yp = (y+1 >= h) ? h-1 : y+1;
    o = (y*w+x)*3;
    for (c = 0; c < 3; c++)
      out[o+c] = (tmp[(ym*w+x)*3+c] + 2*tmp[(y*w+x)*3+c] + tmp[(yp*w+x)*3+c])*0.0625;
  }
  return out;
}

function warmMap(buf, w, h, cfg){
  var n = w*h, i, v;
  var out = new Float64Array(n*3);
  for (i = 0; i < n*3; i++){
    v = buf[i];
    if (cfg.brightness) v += cfg.brightness;
    if (cfg.contrast)   v = (v-128)*(1+cfg.contrast/100) + 128;
    if (cfg.gamma !== 1) v = 255*Math.pow(clamp(v,0,255)/255, cfg.gamma);
    buf[i] = clamp(v,0,255);
  }
  if (cfg.autoLevels){
    autoLevels(buf, n, 0.005);
    for (i = 0; i < n*3; i++) buf[i] = clamp(buf[i],0,255);
  }
  if (cfg.sharpen > 0){
    var bl = blur3(buf, w, h);
    for (i = 0; i < n*3; i++) buf[i] = clamp(buf[i] + cfg.sharpen*(buf[i]-bl[i]), 0, 255);
  }
  var mode = cfg.mode;
  if (mode === "naive" || mode === "gray"){
    for (i = 0; i < n; i++){
      var Lg = clamp(luma(buf[i*3], buf[i*3+1], buf[i*3+2]), 0, 255);
      if (mode === "gray"){ out[i*3] = out[i*3+1] = out[i*3+2] = Lg; }
      else { out[i*3] = buf[i*3]; out[i*3+1] = buf[i*3+1]; out[i*3+2] = buf[i*3+2]; }
    }
    return out;
  }
  if (mode === "natural"){
    for (i = 0; i < n; i++){
      var hsl = rgb2hsl(buf[i*3]/255, buf[i*3+1]/255, buf[i*3+2]/255);
      var hd = hsl[0]*360, s = hsl[1], l = hsl[2];
      var wa = warmAffinity(hd);
      var g = clamp(cfg.warmBoost*wa, 0, 1);
      var s2 = Math.pow(s, 1 - WARM_SAT_K*g);
      s2 = s2 * (1 - clamp(cfg.coolDesat*(1-wa), 0, 1));
      s2 = clamp(s2 * cfg.saturation, 0, 1);
      var drift = -cfg.coolPull*(1-wa)*(hd-60);
      drift = clamp(drift, -cfg.coolCap, 0);
      var d2 = mod(cfg.warmCenter - hd + 540, 360) - 180;
      var pull = clamp(cfg.warmPull*d2, -cfg.warmPullCap, cfg.warmPullCap);
      var h2 = mod(hd + drift + wa*pull, 360);
      var fin = hsl2rgb(h2/360, s2, l);
      out[i*3]   = clamp(fin[0]*255, 0, 255);
      out[i*3+1] = clamp(fin[1]*255, 0, 255);
      out[i*3+2] = clamp(fin[2]*255, 0, 255);
    }
    return out;
  }
  /* adaptive：整圈色相压进暖色带，再叠一层暖色渐变 */
  var lut = rampLut(cfg.castRamp), cast = cfg.warmCast;
  for (i = 0; i < n; i++){
    var hs = rgb2hsl(buf[i*3]/255, buf[i*3+1]/255, buf[i*3+2]/255);
    var hda = mod(cfg.warmCenter + (hs[0]-0.5)*cfg.warmSpan, 360);
    var ya = hsl2rgb(hda/360, hs[1], hs[2]);
    var r0 = ya[0]*255, g0 = ya[1]*255, b0 = ya[2]*255;
    var lm = clamp(Math.floor(clamp(luma(r0,g0,b0),0,255)+0.5), 0, 255);
    r0 = r0*(1-cast) + lut[lm*3]*cast;
    g0 = g0*(1-cast) + lut[lm*3+1]*cast;
    b0 = b0*(1-cast) + lut[lm*3+2]*cast;
    var h3 = rgb2hsl(clamp(r0,0,255)/255, clamp(g0,0,255)/255, clamp(b0,0,255)/255);
    var s3 = clamp(h3[1]*cfg.saturation, 0, 1);
    var f3 = hsl2rgb(h3[0], s3, h3[2]);
    out[i*3]   = clamp(f3[0]*255, 0, 255);
    out[i*3+1] = clamp(f3[1]*255, 0, 255);
    out[i*3+2] = clamp(f3[2]*255, 0, 255);
  }
  return out;
}

/* mask（可选）：1 = 参与量化，0 = 原样保留。
   位图贴纸（表情 / 上传图片）只在自己覆盖的像素上做抖动，
   包围盒里的背景一个像素都不碰，否则贴纸边上会出现一圈脏点。 */
function quantize(mapped, w, h, cfg, mask){
  var n = w*h, i;
  var out = new Uint8Array(n);
  var flat = new Float64Array(mapped);
  var mode = cfg.dither, strength = cfg.ditherStrength;
  var lin = (cfg.space === "linear");
  var pal = lin ? PAL_LIN : PAL;
  var CDEC = null;
  if (cfg.space === "std"){ CDEC = STD_LUT; pal = STD_PAL; }
  if (CDEC){
    for (i = 0; i < n*3; i++){
      var v = clamp(flat[i], 0, 255);
      flat[i] = CDEC[i % 3][(v + 0.5) | 0];
    }
  } else if (lin){
    for (i = 0; i < n*3; i++){
      var v = clamp(flat[i], 0, 255);
      flat[i] = S2L_LUT[(v + 0.5) | 0];
    }
  }
  function nearest(o){
    var r = flat[o], g = flat[o+1], b = flat[o+2], bi = 0, bd = Infinity;
    for (var kk = 0; kk < 4; kk++){
      var p = pal[kk], dr = r-p[0], dg = g-p[1], db = b-p[2];
      var d = dr*dr + dg*dg + db*db;
      if (d < bd){ bd = d; bi = kk; }
    }
    return bi;
  }
  if (mode === "none"){
    for (i = 0; i < n; i++){
      if (mask && !mask[i]) continue;
      out[i] = nearest(i*3);
    }
    return out;
  }
  if (mode === "bayer"){
    var amp = strength*128;
    for (var y = 0; y < h; y++){
      var rowb = (y&7)*8;
      for (var x = 0; x < w; x++){
        if (mask && !mask[y*w+x]) continue;
        var o = (y*w+x)*3;
        var off = (BAYER8[rowb+(x&7)]/64 - 0.5)*amp;
        flat[o]   = clamp(flat[o]+off,0,255);
        flat[o+1] = clamp(flat[o+1]+off,0,255);
        flat[o+2] = clamp(flat[o+2]+off,0,255);
        out[y*w+x] = nearest(o);
      }
    }
    return out;
  }
  var kernel = KERN[mode] || KERN.fs;
  for (var yy = 0; yy < h; yy++){
    var ltr = (yy%2 === 0), base = yy*w*3;
    for (var ii = 0; ii < w; ii++){
      var xx = ltr ? ii : (w-1-ii);
      if (mask && !mask[yy*w+xx]) continue;
      var oo = base + xx*3;
      var k = nearest(oo);
      out[yy*w+xx] = k;
      if (strength <= 0) continue;
      var pp = pal[k];
      var er = (flat[oo]-pp[0])*strength, eg = (flat[oo+1]-pp[1])*strength,
          eb = (flat[oo+2]-pp[2])*strength;
      for (var m = 0; m < kernel.length; m++){
        var nx = xx + (ltr ? kernel[m][0] : -kernel[m][0]), ny = yy + kernel[m][1];
        if (nx >= 0 && nx < w && ny < h){
          if (mask && !mask[ny*w+nx]) continue;
          var no = (ny*w+nx)*3, wg = kernel[m][2];
          flat[no] += er*wg; flat[no+1] += eg*wg; flat[no+2] += eb*wg;
        }
      }
    }
  }
  return out;
}
