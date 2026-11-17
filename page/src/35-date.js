/* ==================================================================
   35-date.js —— 「文字 → 日期」控件
   ------------------------------------------------------------------
   日期是一个独立对象（type:"date"），加进画布后就是**一个文字控件**：
   能拖、能缩放、能旋转、能删，也能直接在文字框里改字。
   三种样式全部用代码画，不内嵌任何字库文件：
     · dot 点阵   —— 5×7 圆点阵（自带字形表，不靠系统字体降采样）
     · seg 数码管 —— 标准 7 段块（a..g），斜体，像真的 LED 数码管
     · txt 普通   —— 系统字体（FONTS[0]）
   ★ 点阵 / 数码管里没有的字（中文、生僻符号）**逐字回退**到普通字体，
     不会整串消失，也不会画出空白格。
   ================================================================== */

var DATE_STYLE = { dot:"点阵", seg:"数码管", txt:"普通" };
/* 格式拆成「日期」「时间」两部分，面板两行各选一个：
   只选日期 / 只选时间 / 两个都选（日期在前、时间跟在后）都允许。
   「自定义」是第三种模式，直接吃用户敲的字，覆盖这两部分。 */
var DATE_FDATE = { "":"无", ymd:"2026.11.13", ymd2:"2026-11-13", mdy:"Nov.13 2026" };
var DATE_FTIME = { "":"无", s12:"AM/PM hh:mm:ss", s24:"hh:mm:ss",
                   m12:"AM/PM hh:mm", hm:"hh:mm", iso:"THH:MM:SS±HH:MM" };
var DATE_MON = ["Jan.","Feb.","Mar.","Apr.","May","Jun.",
                "Jul.","Aug.","Sep.","Oct.","Nov.","Dec."];

/* 拍摄时间优先（EXIF），读不到就用本机当前时间。日期和时间共用同一基准。 */
function dateBase(){
  return (typeof shotDate !== "undefined" && shotDate) ? shotDate : new Date();
}
/* 一次算出全部候选串，按 key 取用 */
function dateParts(d){
  d = d || dateBase();
  function p2(v){ return (v < 10 ? "0" : "") + v; }
  var h = d.getHours(), m = d.getMinutes(), sec = d.getSeconds();
  var h12 = h % 12; if (!h12) h12 = 12;
  var ap = (h < 12) ? "AM" : "PM";
  /* ISO 那档要带本地时区：+08:00 这种；跨时区看照片时不会认错时间 */
  var off = -d.getTimezoneOffset();
  var tz = (off < 0 ? "-" : "+") + p2(Math.floor(Math.abs(off) / 60)) + ":" + p2(Math.abs(off) % 60);
  return {
    ymd:  d.getFullYear() + "." + p2(d.getMonth()+1) + "." + p2(d.getDate()),
    ymd2: d.getFullYear() + "-" + p2(d.getMonth()+1) + "-" + p2(d.getDate()),
    ymd3: d.getFullYear() + "/" + p2(d.getMonth()+1) + "/" + p2(d.getDate()),
    mdy:  DATE_MON[d.getMonth()] + d.getDate() + " " + d.getFullYear(),
    s12:  ap + " " + p2(h12) + ":" + p2(m) + ":" + p2(sec),
    s24:  p2(h) + ":" + p2(m) + ":" + p2(sec),
    m12:  ap + " " + p2(h12) + ":" + p2(m),
    hm:   p2(h) + ":" + p2(m),
    iso:  "T" + p2(h) + ":" + p2(m) + ":" + p2(sec) + tz
  };
}
/* 单 key 取值（老存档 / 模板种子还在用） */
function dateText(fmt, d){
  var p = dateParts(d);
  return (p[fmt] != null) ? p[fmt] : p.ymd;
}
function datePartOf(k, d){ return (k && DATE_FDATE[k]) ? dateText(k, d) : ""; }
function timePartOf(k, d){ return (k && DATE_FTIME[k]) ? dateText(k, d) : ""; }
/* 老对象只有 o.fmt（单值），读的时候反推它属于日期还是时间 */
function datePartsOf(o){
  if (o.fd === undefined && o.ft === undefined){
    var f = String(o.fmt || "");
    if (DATE_FTIME[f]) return { fd:"", ft:f };
    if (DATE_FDATE[f]) return { fd:f, ft:"" };
    return { fd:"", ft:"" };
  }
  return { fd:String(o.fd || ""), ft:String(o.ft || "") };
}
/* 对象当前的显示串：自定义 > 日期+时间 > 老 text */
function dateTextOf(o, d){
  if (!o) return "";
  if (o.fmt === "custom") return String(o.text || "");
  var pp = datePartsOf(o);
  var a = datePartOf(pp.fd, d), b = timePartOf(pp.ft, d);
  if (a || b) return a + (a && b ? " " : "") + b;
  return String(o.text || "");
}

/* 回退字体 = 文字控件的默认字（FONTS[0]，索引 0 永远存在） */
function dateFB(sz){ return "600 " + sz + "px " + FONTS[0].css; }

/* ---------- 5×7 圆点点阵字形 ----------
   一行一个字符串，1 = 画点。5 列 × 7 行；字母只做大写，小写自动转大写。 */
function dotDef(s){ return s.split("/"); }
var DOT5 = {
  "0": dotDef("01110/10001/10011/10101/11001/10001/01110"),
  "1": dotDef("00100/01100/00100/00100/00100/00100/01110"),
  "2": dotDef("01110/10001/00001/00010/00100/01000/11111"),
  "3": dotDef("11111/00010/00100/00010/00001/10001/01110"),
  "4": dotDef("00010/00110/01010/10010/11111/00010/00010"),
  "5": dotDef("11111/10000/11110/00001/00001/10001/01110"),
  "6": dotDef("00110/01000/10000/11110/10001/10001/01110"),
  "7": dotDef("11111/00001/00010/00100/01000/01000/01000"),
  "8": dotDef("01110/10001/10001/01110/10001/10001/01110"),
  "9": dotDef("01110/10001/10001/01111/00001/00010/01100"),
  "A": dotDef("01110/10001/10001/11111/10001/10001/10001"),
  "B": dotDef("11110/10001/10001/11110/10001/10001/11110"),
  "C": dotDef("01110/10001/10000/10000/10000/10001/01110"),
  "D": dotDef("11110/10001/10001/10001/10001/10001/11110"),
  "E": dotDef("11111/10000/10000/11110/10000/10000/11111"),
  "F": dotDef("11111/10000/10000/11110/10000/10000/10000"),
  "G": dotDef("01110/10001/10000/10111/10001/10001/01111"),
  "H": dotDef("10001/10001/10001/11111/10001/10001/10001"),
  "I": dotDef("01110/00100/00100/00100/00100/00100/01110"),
  "J": dotDef("00111/00010/00010/00010/00010/10010/01100"),
  "K": dotDef("10001/10010/10100/11000/10100/10010/10001"),
  "L": dotDef("10000/10000/10000/10000/10000/10000/11111"),
  "M": dotDef("10001/11011/10101/10101/10001/10001/10001"),
  "N": dotDef("10001/10001/11001/10101/10011/10001/10001"),
  "O": dotDef("01110/10001/10001/10001/10001/10001/01110"),
  "P": dotDef("11110/10001/10001/11110/10000/10000/10000"),
  "Q": dotDef("01110/10001/10001/10001/10101/10010/01101"),
  "R": dotDef("11110/10001/10001/11110/10100/10010/10001"),
  "S": dotDef("01111/10000/10000/01110/00001/00001/11110"),
  "T": dotDef("11111/00100/00100/00100/00100/00100/00100"),
  "U": dotDef("10001/10001/10001/10001/10001/10001/01110"),
  "V": dotDef("10001/10001/10001/10001/10001/01010/00100"),
  "W": dotDef("10001/10001/10001/10101/10101/11011/10001"),
  "X": dotDef("10001/10001/01010/00100/01010/10001/10001"),
  "Y": dotDef("10001/10001/01010/00100/00100/00100/00100"),
  "Z": dotDef("11111/00001/00010/00100/01000/10000/11111"),
  " ": dotDef("00000/00000/00000/00000/00000/00000/00000"),
  ".": dotDef("00000/00000/00000/00000/00000/01100/01100"),
  ":": dotDef("00000/01100/01100/00000/01100/01100/00000"),
  "-": dotDef("00000/00000/00000/11111/00000/00000/00000"),
  "/": dotDef("00001/00010/00010/00100/01000/01000/10000"),
  "+": dotDef("00000/00100/00100/11111/00100/00100/00000")
};
function dotGlyph(ch){
  if (DOT5[ch]) return DOT5[ch];
  var up = String(ch).toUpperCase();
  return DOT5[up] || null;
}

/* ---------- 七段数码管（标准 7 段块） ----------
   ★ 每个字符只用 a..g 这 7 个段块，段块画成两端斜切的六边形 —— 这就是数码管的样子。
        --a--
       |     |
       f     b
       |     |
        --g--
       |     |
       e     c
       |     |
        --d--
   数字 0–9 完整；字母按用户参考表（数码管显示英文字母）逐格取段，核心原则是
   **靠不同的段把同形字分开**，而不是用最接近的字形硬凑：
     1 = bc（右侧两竖）  I = e（左下竖）  7 = abc（顶+右两竖）
     O = cdeg（下半 o）  Q = abcfg（9 无底横）  0 = abcdef（整圈）
     R = eg（中横+左下）  K = bdefg（H 加底横）  H = bcefg（无顶无底）
     V = bfg（两上竖+中横）  W = bdfg（两上竖+中横+底横）  U = bcdef（整 U）
     Z = adg（三横）  2 = abdeg（带斜段错觉）  S = cfg 与 5 = acdfg 分开
   小写自动转大写。 */
var SEG7 = {
  "0":"abcdef", "1":"bc",     "2":"abdeg",  "3":"abcdg",  "4":"bcfg",
  "5":"acdfg",  "6":"acdefg", "7":"abc",    "8":"abcdefg","9":"abcdfg",
  "A":"abcefg", "B":"cdefg",  "C":"adef",   "D":"bcdeg",  "E":"adefg",
  "F":"aefg",   "G":"acdef",  "H":"bcefg",  "I":"e",      "J":"bcd",
  "K":"bdefg",  "L":"def",    "M":"aceg",   "N":"ceg",    "O":"cdeg",
  "P":"abefg",  "Q":"abcfg",  "R":"eg",     "S":"cfg",    "T":"defg",
  "U":"bcdef",  "V":"bfg",    "W":"bdfg",   "X":"bcef",   "Y":"bcdfg",
  "Z":"adg",
  " ":"",
  ".":"",
  ":":"",
  "-":"g",
  "/":"beg"
};

var SEG_SLANT = -0.15;                 /* 整体斜体：对 x 方向剪切 */
var SEG_ASPECT = 0.62;                 /* 字形宽 / 字号高（七段标准比例） */
function segGlyphW(sz){ return sz * SEG_ASPECT; }
function segGlyph(ch){
  var s = SEG7[ch];
  if (s == null) s = SEG7[String(ch).toUpperCase()];
  return (s == null) ? null : s;
}

/* 一个七段字符：左上角 (x,y)，字形宽 w、高 h */
function drawSeg7(ctx, ch, x, y, w, h, color){
  var s = segGlyph(ch);
  if (s == null) return;
  /* ★ 段厚 / 缝 / 所有坐标量化到整数像素（11-17）：
     非整数段厚加 SEG_SLANT 斜切会产生亚像素边，四色 snapIdx 后成锯齿。
     整数化后每条段都贴齐像素网格，边界干净、放大缩小一致。
     形状不变：仍是两端 45° 斜切的六边形，段厚/缝比例仍是 0.145h / 0.18t。 */
  var t = Math.max(2, Math.round(h * 0.145));   /* 段厚：整数像素 */
  var g = Math.max(1, Math.round(t * 0.18));    /* 缝：整数像素，至少 1 */
  x = Math.round(x); y = Math.round(y);
  w = Math.round(w); h = Math.round(h);
  var xL = x + Math.round(t/2), xR = x + w - Math.round(t/2);
  var yT = y + Math.round(t/2), yM = y + Math.round(h/2), yB = y + h - Math.round(t/2);
  var half = Math.round(t/2);
  ctx.save();
  ctx.fillStyle = color;
  /* 横段：两端斜切的六边形 */
  function hseg(x1, x2, yc){
    var a = x1 + g, b = x2 - g;
    if (b - a < t) return;
    ctx.beginPath();
    ctx.moveTo(a, yc);
    ctx.lineTo(a + half, yc - half);
    ctx.lineTo(b - half, yc - half);
    ctx.lineTo(b, yc);
    ctx.lineTo(b - half, yc + half);
    ctx.lineTo(a + half, yc + half);
    ctx.closePath();
    ctx.fill();
  }
  /* 竖段：同上，转 90° */
  function vseg(y1, y2, xc){
    var a = y1 + g, b = y2 - g;
    if (b - a < t) return;
    ctx.beginPath();
    ctx.moveTo(xc, a);
    ctx.lineTo(xc + half, a + half);
    ctx.lineTo(xc + half, b - half);
    ctx.lineTo(xc, b);
    ctx.lineTo(xc - half, b - half);
    ctx.lineTo(xc - half, a + half);
    ctx.closePath();
    ctx.fill();
  }
  if (s.indexOf("a") >= 0) hseg(xL, xR, yT);
  if (s.indexOf("g") >= 0) hseg(xL, xR, yM);
  if (s.indexOf("d") >= 0) hseg(xL, xR, yB);
  if (s.indexOf("f") >= 0) vseg(yT, yM, xL);
  if (s.indexOf("e") >= 0) vseg(yM, yB, xL);
  if (s.indexOf("b") >= 0) vseg(yT, yM, xR);
  if (s.indexOf("c") >= 0) vseg(yM, yB, xR);
  /* 标点：右下角小方块（真数码管的小数点也在右下） */
  if (ch === "." || ch === ":"){
    var dq = Math.max(2, t * 1.05);
    if (ch === "."){
      ctx.fillRect(xR - dq/2, yB - dq/2, dq, dq);
    } else {
      ctx.fillRect(xR - dq/2, yM - h*0.21 - dq/2, dq, dq);
      ctx.fillRect(xR - dq/2, yM + h*0.21 - dq/2, dq, dq);
    }
  }
  ctx.restore();
}

/* ---------- 逐字排版（三种样式混排 + 回退） ----------
   分行只看用户敲的换行（\\n）：日期控件不再有「宽度」这个属性 ——
   想换行就在自定义里按回车，这样所见即所得，不用再猜宽度折在哪。 */
function dateLayout(o, sz){
  /* ★ 像素对齐（11-17）：字号与步进全部量化到整数像素。
     设备帧与逻辑画布 1:1，非整数坐标经四色 snapIdx 会变成锯齿/发虚；
     量化到整数网格后，点阵每个点落在同一像素格、线段边界贴齐像素。 */
  sz = Math.max(8, Math.round(sz));
  var style = DATE_STYLE[o.style] ? o.style : "dot";
  var text = String(o.text == null ? "" : o.text).replace(/\r\n?/g, "\n");
  var mc = measureCtx2();
  var raw = text.split("\n"), lines = [], i, j;
  for (j = 0; j < raw.length; j++){
    var seg = raw[j], items = [], total = 0;
    for (i = 0; i < seg.length; i++){
      var ch = seg.charAt(i), kind = "txt", w = 0, gw = 0;
      if (style === "dot"){
        var g = dotGlyph(ch);
        if (g){
          kind = "dot";
          ch = (DOT5[ch] ? ch : String(ch).toUpperCase());
          w = Math.round((ch === " ") ? sz*4/7 : sz*6/7);  /* 5 点 + 1 间距，整数像素 */
          gw = w;
        }
      } else if (style === "seg"){
        if (segGlyph(ch) !== null){
          kind = "seg";
          /* 字形宽 gw ≠ 步进宽 w：留足字距（用户反馈：数码管字距要拉大） */
          gw = Math.round(segGlyphW(sz));
          w = Math.round((ch === " ") ? gw * 0.62
            : (ch === "." || ch === ":") ? gw * 0.72
            : gw * 1.36);
        }
      }
      if (kind === "txt"){
        mc.font = dateFB(sz);
        w = mc.measureText(ch).width;
        gw = w;
      }
      items.push({ ch:ch, kind:kind, w:w, gw:gw });
      total += w;
    }
    lines.push({ items:items, w:total });
  }
  if (!lines.length) lines.push({ items:[], w:0 });

  var mw = 0;
  for (i = 0; i < lines.length; i++) mw = Math.max(mw, lines[i].w);
  var lh = sz * 1.24;
  /* 对齐只决定多行时各行水平落在哪；整块仍以对象中心为原点（手柄框不变形） */
  var al = (o.align === "l" || o.align === "r") ? o.align : "c";
  return { lines:lines, w:mw, h:lines.length * lh, lh:lh,
           style:style, size:sz, align:al };
}

/* 单字绘制：在 (x, yTop) 处画，字号 sz
   pen = 描边（{c:"rgb(..)", w:px}），null 就是不描边。
   描边的做法是「同一字形整体外扩」：先用描边色画一遍放大 w 的，再画本色。
   为什么不直接 ctx.stroke()：点阵的圆点和数码管的段块都是贴在一起的图元，
   给每个图元描边会把缝糊死（段厚 0.145h、缝只有 0.18t），太丑；
   等比放大则缝跟着放大，字形还是那个字形。 */
function drawDateChar(ctx, it, x, yTop, sz, color, pen){
  if (it.kind === "dot"){
    var g = dotGlyph(it.ch);
    /* ★ 每个点固定为同样大小的整数像素方块，整点对齐：
       不再用非整数的 p/rr 画圆 —— 四色 snapIdx 会把亚像素圆切成锯齿，
       放大缩小都发虚。方块 + 整数坐标在设备上就是干净的点阵。
       方块边长 = 步距的 0.62，留 38% 点距；最小 2px 保证缩小后仍可见。 */
    var p = Math.max(3, Math.round(sz / 7));
    /* 点边长最多 p-1，永远留 ≥1px 点距，避免小字号糊成实心块 */
    var side = Math.max(1, Math.min(p - 1, Math.round(p * 0.62)));
    var sx = Math.round(x), sy = Math.round(yTop);   /* 整点起点 */
    var ry, cx;
    if (pen){                                    /* 1) 先用描边色铺一圈 */
      var ps = side + 2 * Math.max(0, Math.round(pen.w));
      var ppo = Math.round((p - ps) / 2);
      ctx.fillStyle = pen.c;
      for (ry = 0; ry < 7; ry++){
        var row0 = g[ry];
        for (cx = 0; cx < 5; cx++){
          if (row0.charAt(cx) !== "1") continue;
          ctx.fillRect(sx + p*cx + ppo, sy + p*ry + ppo, ps, ps);
        }
      }
    }
    var o2 = Math.round((p - side) / 2);
    ctx.fillStyle = color;
    for (ry = 0; ry < 7; ry++){
      var row = g[ry];
      for (cx = 0; cx < 5; cx++){
        if (row.charAt(cx) !== "1") continue;
        ctx.fillRect(sx + p*cx + o2, sy + p*ry + o2, side, side);
      }
    }
    return;
  }
  if (it.kind === "seg"){
    var gw = it.gw || it.w;
    if (pen){
      /* 描边 = 把同一字形沿圆周平移 w 反复重画（膨胀），再画本色。
         ★ 不能用 ctx.scale 放大整字：那是「绕中心等比放大」，段的坐标和字距
         会一起散开，看着像一个放大的副本叠在后面（用户原话：像放大阴影）。
         位移重画则是每个段原地长胖一圈，笔画位置、字距、斜切角度全不变。 */
      var SE = 12;                                  /* 圆周采样数：12 段时半径误差 3.4% */
      for (var a = 0; a < SE; a++){
        var ag = a * Math.PI * 2 / SE;
        ctx.save();
        ctx.translate(Math.cos(ag) * pen.w, Math.sin(ag) * pen.w);
        drawSeg7(ctx, it.ch, x, yTop, gw, sz, pen.c);
        ctx.restore();
      }
    }
    drawSeg7(ctx, it.ch, x, yTop, gw, sz, color);
    return;
  }
  ctx.save();
  ctx.font = dateFB(sz);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (pen){
    ctx.lineWidth = pen.w * 2;
    ctx.lineJoin = "round";
    ctx.strokeStyle = pen.c;
    ctx.strokeText(it.ch, x, yTop + sz/2);
  }
  ctx.fillStyle = color;
  ctx.fillText(it.ch, x, yTop + sz/2);
  ctx.restore();
}

/* 整串绘制：以 (0,0) 为中心（调用方已 translate / rotate） */
function drawDateRuns(ctx, lay, color, pen){
  var y0 = -lay.h/2, li, i;
  ctx.save();
  if (lay.style === "seg"){
    /* 斜体：整串一起切，字距不歪 */
    ctx.transform(1, 0, SEG_SLANT, 1, 0, 0);
  }
  for (li = 0; li < lay.lines.length; li++){
    var line = lay.lines[li];
    var x = (lay.align === "l") ? -lay.w/2
          : (lay.align === "r") ? (lay.w/2 - line.w)
          : -line.w/2;
    var yTop = y0 + li * lay.lh;
    for (i = 0; i < line.items.length; i++){
      var it = line.items[i];
      /* 数码管字形比步进窄，居中放进自己的格子；点阵左边留一格当字距 */
      var off = (it.kind === "seg") ? (it.w - it.gw) / 2 : 0;
      drawDateChar(ctx, it, x + off, yTop, lay.size, color, pen);
      x += it.w;
    }
  }
  ctx.restore();
}

/* 度量：对象手柄用同一个几何，框永远贴住内容 */
function dateMetrics(o, s){
  var sz = Math.max(8, (+o.size || 60) * s);
  var lay = dateLayout(o, sz);
  /* padding 与底色块用的是同一对值：手柄框住的就是底色块本身。
     框宽 = 最宽那一行，不跟任何「设定宽度」走 —— 日期没有宽度手柄了。 */
  var pX = Math.max(2, sz * 0.14), pY = Math.max(2, sz * 0.10);
  return { lines:[String(o.text || "")], mw:lay.w, blockH:lay.h, lh:lay.lh,
           pX:pX, pY:pY, date:true, style:lay.style, size:sz };
}

/* 画布绘制入口（drawObj 里分派过来）
   日期也是文字控件，所以文字有的「底色 / 描边（宽度 + 颜色）」它也有。 */
function drawDate(ctx, o, cw){
  var s = cw / EW;
  var sz = Math.max(8, (+o.size || 60) * s);
  var lay = dateLayout(o, sz);
  var p = PAL[clamp(+o.color|0, 0, 3)];
  var color = "rgb(" + p[0] + "," + p[1] + "," + p[2] + ")";
  var pen = null;
  var sw = clamp(+o.stroke||0, 0, 8) * s;
  if (sw > 0.05){
    var sp = PAL[clamp(+o.strokeC|0, 0, 3)];
    pen = { c:"rgb(" + sp[0] + "," + sp[1] + "," + sp[2] + ")", w:sw };
  }
  ctx.save();
  ctx.translate((+o.x||0)*s, (+o.y||0)*s);
  ctx.rotate((+o.rot||0)*Math.PI/180);
  if (+o.bg >= 1){
    var bgp = PAL[[1, 0, 2, 3][+o.bg - 1]];    /* 1白 2黑 3黄 4红（与文字底色同一套） */
    var pX = Math.max(2, sz*0.14), pY = Math.max(2, sz*0.10);
    ctx.fillStyle = "rgb(" + bgp[0] + "," + bgp[1] + "," + bgp[2] + ")";
    ctx.fillRect(-lay.w/2 - pX, -lay.h/2 - pY, lay.w + pX*2, lay.h + pY*2);
  }
  drawDateRuns(ctx, lay, color, pen);
  ctx.restore();
}

/* ---------- 增删与面板接线 ---------- */
/* 三种样式的「默认长相」：用户定下的 —— 点阵黑字白底、数码管红字中粗白描边。 */
function datePreset(style){
  if (style === "seg") return { color:3, stroke:3, strokeC:1, bg:0 };
  if (style === "dot") return { color:0, stroke:0, strokeC:1, bg:1 };
  return { color:0, stroke:0, strokeC:1, bg:0 };
}
/* 点「点阵 / 数码管 / 普通」或任一格式胶囊 = 直接往画布上加一个日期（没有「添加日期」按钮）。
   已经选中某个日期时，这些点击改的是那个对象，不会再叠一个新的。 */
function addDateObj(opt){
  opt = opt || {};
  var style = opt.style || ($("dateStyle") ? $("dateStyle").value : "dot");
  if (!DATE_STYLE[style]) style = "dot";
  var pre = datePreset(style);
  var o = {
    type:"date", style:style,
    fd:"ymd", ft:"", fmt:"",          /* fd/时间分开，fmt 只给「自定义」用 */
    text:"", align:"c",              /* 多行时的对齐：l / c / r */
    /* 默认右下角、小字：像老照片右下角的日期戳。
       位置按字号和时间串长度定，先给个安全初值，下面按实测宽度右对齐。 */
    x:EW - 90, y:EH - 34, size:20, rot:0,
    color:pre.color, stroke:pre.stroke, strokeC:pre.strokeC, bg:pre.bg
  };
  /* 面板上已经选了时间的话，新加的日期就带上它 */
  if ($("dateTime") && $("dateTime").value && DATE_FTIME[$("dateTime").value]){
    o.ft = $("dateTime").value;
  }
  o.text = dateTextOf(o);
  /* 右对齐到距右边 24px、距底边 24px（用实测包围盒，不猜字宽） */
  var lm = dateMetrics(o, 1);
  o.x = EW - 24 - Math.round(lm.mw/2);
  o.y = EH - 24 - Math.round(lm.blockH/2);
  curObjs().push(o);
  selIdx = curObjs().length - 1;
  saveCfg(); layoutObjs(); syncSel(); schedulePreview(false);
  if (!opt.silent) msg("已添加日期，直接在画布上拖就行", "ok", 1600);
  return o;
}
/* 换样式：面板上的值写进当前日期对象；没选中日期就新建一个 */
function setDateStyle(v){
  if (!DATE_STYLE[v]) v = "dot";
  var o = curObjs()[selIdx];
  if (!o || !isDate(o)){
    addDateObj({ style: v, silent: true });
    return;
  }
  /* 配色跟不跟着预设走：用户没动过就切（点阵→黑字白底、数码管→红字白描边），
     动过就尊重他的调整 —— 切个字形把辛苦调好的颜色冲掉，比不切更烦。 */
  var was = datePreset(o.style);
  var untouched = ((+o.color || 0) === was.color && (Math.round(+o.stroke) || 0) === was.stroke
                   && (+o.strokeC || 0) === was.strokeC && (+o.bg || 0) === was.bg);
  o.style = v;
  if (untouched){
    var now = datePreset(v);
    o.color = now.color; o.stroke = now.stroke; o.strokeC = now.strokeC; o.bg = now.bg;
  }
  relayoutOne(selIdx, true, objScale());
  /* ★ 换样式后必须回填面板：chips 是 select 的镜像，不同步就会停在旧值 */
  saveCfg(); syncSel(); schedulePreview(false);
}
/* 日期部分 / 时间部分各自一个 change；两者互不排斥，都选就是「日期 + 时间」。
   这里的点击同时承担「没有日期对象就新建」——和贴纸一样，点一下就上画布。 */
function setDateFmt(v){
  var o = curObjs()[selIdx];
  if (!o || !isDate(o)){
    o = addDateObj({ style: $("dateStyle") ? $("dateStyle").value : "dot", silent: true });
  }
  o.fmt = "";                                   /* 从「自定义」切回组合格式 */
  o.fd = DATE_FDATE.hasOwnProperty(v) ? v : "";
  var pp = datePartsOf(o);
  /* 两边都空 = 什么都没了；这种情况下把日期这半留住 */
  if (!pp.fd && !pp.ft) o.fd = "ymd";
  o.text = dateTextOf(o);
  relayoutOne(selIdx, true, objScale());
  saveCfg(); syncSel(); schedulePreview(false);
}
function setDateTime(v){
  var o = curObjs()[selIdx];
  if (!o || !isDate(o)){
    o = addDateObj({ style: $("dateStyle") ? $("dateStyle").value : "dot", silent: true });
  }
  o.fmt = "";                                   /* 从自定义切回组合格式 */
  o.ft = DATE_FTIME.hasOwnProperty(v) ? v : "";
  var pp = datePartsOf(o);
  if (!pp.fd && !pp.ft) o.fd = "ymd";
  o.text = dateTextOf(o);
  relayoutOne(selIdx, true, objScale());
  saveCfg(); syncSel(); schedulePreview(false);
}

/* ---------- 自定义：独立的三级页 ----------
   点三级「自定义」就进来（没有日期对象就当场新建一个），把当前显示串带进输入框，
   用户在这上面改；回车就是换行，三种样式都按行画。 */
function enterDateCustom(focus){
  var o = curObjs()[selIdx];
  if (!o || !isDate(o)){
    o = addDateObj({ style: $("dateStyle") ? $("dateStyle").value : "dot", silent: true });
  }
  if (o.fmt !== "custom"){
    var t = dateTextOf(o);          /* 带过来的就是画布上现在这串，不用重打 */
    o.fmt = "custom"; o.fd = ""; o.ft = "";
    o.text = t;
    relayoutOne(selIdx, true, objScale());
    saveCfg(); schedulePreview(false);
  }
  var box = $("dateCustom");
  if (box) box.value = o.text || "";
  if (typeof paintChips === "function") paintChips("dateAlign", "dateAlignRow");
  if (focus && box) setTimeout(function(){
    try { box.focus(); var n = box.value.length; box.setSelectionRange(n, n); } catch(e){}
  }, 40);
}
/* 对齐：只影响多行时各行的左右位置，块本身还是以中心定位 */
function setDateAlign(v){
  var o = curObjs()[selIdx];
  if (!o || !isDate(o)) return;
  o.align = (v === "l" || v === "r") ? v : "c";
  relayoutOne(selIdx, true, objScale());
  saveCfg(); syncSel(); schedulePreview(false);
}
/* 只收字母 / 数字 / 空格 / . - 和回车（用户要求）；其余字符输进来就被抹掉 */
function cleanCustom(v){
  return String(v == null ? "" : v)
    .replace(/\r\n?/g, "\n")
    .replace(/[^A-Za-z0-9 .\-\n]/g, "");
}

/* 日期面板的全部回填：样式 / 日期 / 时间 / 对齐 四行胶囊 + 描边填充底色 + 自定义框。
   文字面板也有一套同名功能的控件，两套都指向「当前选中对象」的同一批字段。 */
function syncDatePanel(o){
  var r = $("dStroke");
  if (!r) return;
  var d = (o && isDate(o)) ? o : null;
  r.value = d ? Math.round(+d.stroke || 0) : 0;
  if ($("dStrokeV")) $("dStrokeV").textContent = r.value;
  if (typeof paintRange === "function") paintRange(r);
  if (typeof paintSw === "function"){
    paintSw("dStrokeCRow", d ? (+d.strokeC | 0) : 1);
    paintSw("dColorRow",   d ? (+d.color   | 0) : 0);
    paintSw("dBgRow",      d ? (+d.bg      | 0) : 0);
  }
  var pp = d ? datePartsOf(d) : { fd:"", ft:"" };
  if ($("dateStyle") && d) $("dateStyle").value = d.style || "dot";
  if ($("dateFmt"))  $("dateFmt").value  = pp.fd;
  if ($("dateTime")) $("dateTime").value = pp.ft;
  if ($("dateAlign")) $("dateAlign").value = d ? (d.align || "c") : "c";
  if (typeof paintChips === "function"){
    paintChips("dateStyle", "dateStyleRow");
    paintChips("dateFmt", "dateFmtRow");
    paintChips("dateTime", "dateTimeRow");
    paintChips("dateAlign", "dateAlignRow");
  }
  /* 自定义框跟着当前对象走；值没变就不写，免得打断正在输入的光标 */
  var box = $("dateCustom");
  if (box){
    var t = d ? String(d.text || "") : "";
    if (box.value !== t) box.value = t;
  }
}

(function wireDate(){
  if (!$("dateStyle")) return;
  paintChips("dateStyle", "dateStyleRow");
  paintChips("dateFmt", "dateFmtRow");
  paintChips("dateTime", "dateTimeRow");
  paintChips("dateAlign", "dateAlignRow");
  $("dateStyle").addEventListener("change", function(){ setDateStyle(this.value); });
  $("dateFmt").addEventListener("change", function(){ setDateFmt(this.value); });
  if ($("dateTime")) $("dateTime").addEventListener("change", function(){ setDateTime(this.value); });
  if ($("dateAlign")) $("dateAlign").addEventListener("change", function(){ setDateAlign(this.value); });

  var r = $("dStroke");
  if (r) r.addEventListener("input", function(){
    var o = curObjs()[selIdx];
    if (!o || !isDate(o)) return;
    o.stroke = +this.value;
    if ($("dStrokeV")) $("dStrokeV").textContent = this.value;
    paintRange(this);
    saveCfg(); relayoutOne(selIdx, true, objScale()); schedulePreview(false);
  });
  function bindD(id, key){
    bindSw(id, function(v){
      var o = curObjs()[selIdx];
      if (!o || !isDate(o)) return;
      o[key] = v;
      saveCfg(); relayoutOne(selIdx, true, objScale()); schedulePreview(false);
      paintSw(id, v);
    });
  }
  bindD("dStrokeCRow", "strokeC");
  bindD("dColorRow",   "color");
  bindD("dBgRow",      "bg");

  /* 自定义输入：回车换行原样保留（textarea），非法字符当场抹掉并把光标放回原处 */
  var inp = $("dateCustom");
  if (inp) inp.addEventListener("input", function(){
    var o = curObjs()[selIdx];
    if (!o || !isDate(o)) return;
    var raw = this.value, v = cleanCustom(raw);
    if (v !== raw){
      var pos = this.selectionStart || 0;
      this.value = v;
      try { var at = Math.min(pos, v.length); this.setSelectionRange(at, at); } catch(e){}
    }
    o.text = v; o.fmt = "custom"; o.fd = ""; o.ft = "";
    saveCfg(); relayoutOne(selIdx, true, objScale()); schedulePreview(false);
  });
})();
