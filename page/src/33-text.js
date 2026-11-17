/* ==================================================================
   33-text.js —— 文字 / 贴纸对象（画在画布，手柄在 DOM 层）
   ------------------------------------------------------------------
   两类对象共用一套手柄与数组：
     文字 { type:"text", text, font, size, color, rot, stroke, strokeC, bg, wrap }
     贴纸 { type:"stk", src, x, y, w, h, rot }
   画布是唯一视觉源（.tobj 本身永远透明，只画一圈手柄），所以加一种对象
   不需要动渲染顺序，只要 objMetrics / drawObj 各认一个分支。
   ================================================================== */
/* ---------- 字体 ----------
   字体不是写死的一串名字：先摆上四款基础字体（索引 0..3 固定，老工程不会串），
   再把本机真的装了的字体探测出来补在后面，最后允许用「＋」临时加载字体文件。
   这样不增加页面体积，也永远不出现「选了一个其实不存在的字体」的情况。 */
var FONT_CAND = [
  { name:"仿宋", fam:["FangSong","STFangsong","FangSong_GB2312"], w:600, gen:"serif" },
  { name:"圆体", fam:["Yuanti SC","YouYuan","Hiragino Sans GB"], w:500, gen:"sans-serif" },
  { name:"隶书", fam:["STLiti","LiSu"], w:600, gen:"serif" },
  { name:"行楷", fam:["STXingkai","Xingkai SC","Xingkai"], w:600, gen:"serif" },
  { name:"报宋", fam:["STSong","Songti TC"], w:600, gen:"serif" },
  { name:"雅黑", fam:["Microsoft YaHei","PingFang SC"], w:500, gen:"sans-serif" }
];
var fontUpN = 0;
function fontAvail(fam){
  var mc = measureCtx2();
  var probe = "永和九年AaBbGg0123";
  mc.font = "40px monospace";
  var w0 = mc.measureText(probe).width;
  mc.font = '40px "' + fam + '", monospace';
  var w1 = mc.measureText(probe).width;
  return Math.abs(w1 - w0) > 0.5;      /* 名字不存在时整串落回 monospace，宽度一致 */
}
function addFontEntry(f){
  FONTS.push(f);
  var i = FONTS.length - 1;
  var o = document.createElement("option");
  o.value = i; o.textContent = f.name;
  $("tFont").appendChild(o);
  return i;
}
function renderFontChips(){
  var row = $("tFontRow");
  if (!row) return;
  var cur = clamp(+$("tFont").value || 0, 0, FONTS.length - 1);
  while (row.firstChild) row.removeChild(row.firstChild);
  FONTS.forEach(function(f, i){
    var s = document.createElement("span");
    s.textContent = f.name || ("字体" + i);
    s.style.fontFamily = f.css;        /* 胶囊自己就用这种字排，一眼能挑 */
    if (i === cur) s.className = "on";
    s.addEventListener("click", function(){ pickFont(i); });
    row.appendChild(s);
  });
}
function pickFont(i){
  i = clamp(i|0, 0, FONTS.length - 1);
  $("tFont").value = String(i);
  var o = curObjs()[selIdx];
  if (o && !isStk(o) && !isDate(o)){
    o.font = i; saveCfg(); relayoutOne(selIdx); schedulePreview(false);
  }
  renderFontChips();
}
(function initFonts(){
  var sel = $("tFont");
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  FONTS.forEach(function(f, i){
    var o = document.createElement("option");
    o.value = i; o.textContent = f.name || ("字体" + i);
    sel.appendChild(o);
  });
  FONT_CAND.forEach(function(c){
    for (var k = 0; k < c.fam.length; k++){
      if (!fontAvail(c.fam[k])) continue;
      addFontEntry({ name:c.name, w:c.w, css:'"' + c.fam[k] + '",' + c.gen });
      return;
    }
  });
  renderFontChips();
})();
$("tFontUp").addEventListener("click", function(){ $("fontFile").click(); });
$("fontFile").addEventListener("change", function(){
  var f = this.files && this.files[0];
  this.value = "";
  if (!f) return;
  if (typeof FontFace === "undefined"){ msg("这个浏览器不支持加载字体文件", "err"); return; }
  var nm = String(f.name || "").replace(/\.[^.]+$/, "").slice(0, 8) || "字体";
  var fam = "MoInkUp" + (++fontUpN);
  var fr = new FileReader();
  fr.onload = function(){
    var ff;
    try { ff = new FontFace(fam, fr.result); }
    catch(e){ msg("这个字体文件读不出来", "err"); return; }
    ff.load().then(function(loaded){
      document.fonts.add(loaded);
      pickFont(addFontEntry({ name:nm, w:500, css:'"' + fam + '",sans-serif' }));
      msg("已加载字体「" + nm + "」（只在本页有效）", "ok");
    })["catch"](function(){ msg("字体加载失败：文件可能损坏或不支持", "err"); });
  };
  fr.readAsArrayBuffer(f);
});

/* ---------- 色点行：描边色 / 文字色 / 文字底色 / 图标颜色 共用同一套 ----------
   data-v = 写进配置的值，data-c = 圆点画成什么颜色（显示与语义分开，
   所以「底色」里「无 / 白 / 黑 / 黄 / 红」也能用同一排圆点）。 */
function paintSw(id, v){
  var row = $(id);
  if (!row) return;
  var list = row.querySelectorAll(".sw");
  for (var i = 0; i < list.length; i++)
    list[i].classList.toggle("on", +list[i].dataset.v === +v);
}
function bindSw(id, apply){
  var row = $(id);
  if (!row) return;
  row.addEventListener("click", function(ev){
    var b = ev.target.closest ? ev.target.closest(".sw") : null;
    if (!b || !row.contains(b)) return;
    apply(+b.dataset.v, b);
  });
}
function bindObjSw(id, key){
  bindSw(id, function(v){
    var o = curObjs()[selIdx];
    if (!o || isStk(o)) return;        /* 没选中文字就不改，和滑块保持一致 */
    /* 日期也是文字控件：文字色 / 描边色 / 底色三者都能改 */
    o[key] = v;
    saveCfg(); relayoutOne(selIdx); schedulePreview(false);
    paintSw(id, v);
  });
}
bindObjSw("rowStrokeC", "strokeC");
bindObjSw("rowTextC", "color");
bindObjSw("objBgRow", "bg");
function syncSw(){
  var o = curObjs()[selIdx], isText = !!o && !isStk(o);
  paintSw("rowStrokeC", isText ? (+o.strokeC|0) : 1);
  paintSw("rowTextC",   isText ? (+o.color|0)   : C_K);
  paintSw("objBgRow",   isText ? (+o.bg|0)      : 0);
}

var selIdx = -1, selByMode = [-1, -1];
function curObjs(){ return (MODE === 0) ? cfg.objsImg : cfg.objsNote; }
function newObj(){
  return { type:"text", x:EW/2, y:EH/2, text:"",
           font:0, size:48, color:C_K, rot:0, stroke:0,
           strokeC:1, bg:0, wrap:0 };
}
function isStk(o){ return !!o && o.type === "stk"; }
function isDate(o){ return !!o && o.type === "date"; }

/* 拍立得不再有「显示文字层」开关：有对象就画，没有就空 —— 少一个要猜的勾。 */
function refreshTextUI(){
  layoutObjs();
}

/* ---------- 文字：一个输入框 + 一个「＋」 ---------- */
$("objAdd").addEventListener("click", function(){
  var t = txtEl.value, objs = curObjs();
  if (!t.replace(/\s+$/, "")){ msg("请先输入文字", "err"); return; }
  var o = objs[selIdx];
  /* 选中日期时，「＋」就是把框里的字写回它 —— 日期本身就是一个文字控件 */
  if (o && isDate(o)){
    o.text = t;
    o.fmt = "custom"; o.fd = ""; o.ft = "";    /* 同上：手工改写 = 自定义 */
    saveCfg(); relayoutOne(selIdx, true, objScale()); schedulePreview(false);
    return;
  }
  if (!o || isStk(o) || String(o.text || "").replace(/\s+$/, "")){
    objs.push(newObj()); selIdx = objs.length - 1; o = objs[selIdx];
  }
  o.text = t;
  selIdx = objs.indexOf(o);          /* 新加的就选中它，参数滑块立刻可用 */
  saveCfg(); refreshTextUI(); syncSel(); schedulePreview(false);
});

/* ---------- 参数回填 ---------- */
function syncSel(){
  var o = curObjs()[selIdx];
  var isText = !!o && !isStk(o) && !isDate(o);
  /* 文字参数只对文字对象有意义；选中贴纸时整排置灰，避免改了没反应。
     日期对象能调「大小 / 方向 / 描边」，没有字体与换行宽度。 */
  var DATE_OK = { tSize:1, tRot:1, tStroke:1 };
  ["tFont","tSize","tRot","tStroke","tWrap"].forEach(function(id){
    var el = $(id);
    if (!el) return;
    el.disabled = !(isText || (isDate(o) && DATE_OK[id]));
  });
  /* 日期面板的三行胶囊 / 自定义行由 syncDatePanel 统一回填（见 35-date.js） */
  /* 滑块的值是直接赋进去的，不会触发 input，右侧数字得手动同步，
     否则换一个对象后数字还停在上一个值上 */
  function syncNumOut(){
    ["tSize","tRot","tStroke"].forEach(function(id){
      var el = $(id), out = $(id + "V");
      if (el && out) out.textContent = el.value;
    });
  }
  syncSw();
  /* 日期面板自己的那套控件（描边 / 填充 / 底色）也要跟着当前对象走，
     否则两套控件会各显示各的，改完一个看不出另一个的值 */
  if (typeof syncDatePanel === "function") syncDatePanel(o);
  if (!o){ txtEl.value = ""; renderFontChips(); return; }
  /* 日期也是文字控件：输入框里放它的内容，随手就能改数字 / 英文 */
  if (isDate(o)){
    txtEl.value = o.text || "";
    $("tSize").value = Math.round(o.size);
    $("tRot").value = Math.round(o.rot||0);
    $("tStroke").value = Math.round(o.stroke||0);
    syncNumOut();
    renderFontChips(); return;
  }
  if (!isText){ renderFontChips(); return; }      /* 贴纸：输入框留着草稿，不清空 */
  txtEl.value = o.text;
  $("tFont").value = String(o.font|0);
  $("tSize").value = Math.round(o.size);
  $("tRot").value = Math.round(o.rot||0);
  $("tStroke").value = Math.round(o.stroke||0);
  $("tWrap").value = clamp(Math.round(+o.wrap||0), 0, EW);
  $("tWrapV").textContent = (+o.wrap||0) ? Math.round(o.wrap) + "px" : "自动";
  syncNumOut();
  renderFontChips();
}
function bindSel(id, key, ev, dateOk){
  $(id).addEventListener(ev, function(){
    var o = curObjs()[selIdx];
    if (!o || isStk(o)) return;
    if (isDate(o) && !dateOk) return;   /* 日期没有字体索引，也没有换行宽度 */
    o[key] = +$(id).value;
    saveCfg(); relayoutOne(selIdx); schedulePreview(false);
  });
}
bindSel("tFont","font","change");
bindSel("tSize","size","input", true);
bindSel("tStroke","stroke","input", true);
$("tFont").addEventListener("change", renderFontChips);

/* 方向：0 / ±90 / 180 吸附（±4° 内归整），其余角度自由。
   R1.4.1 之前这里调用的是已经随 Cropper 一起删掉的吸附函数，
   一拖就抛异常 —— 方向滑块「没反应」的根因就是它。 */
function snapTextRot(a){
  for (var i = -2; i <= 2; i++){
    if (Math.abs(a - i*90) <= 4) return i*90;
  }
  return a;
}
$("tRot").addEventListener("input", function(){
  var o = curObjs()[selIdx]; if (!o || isStk(o)) return;   /* 日期也有 rot，一起转 */
  o.rot = clamp(snapTextRot(Math.round(+$("tRot").value)), -180, 180);
  $("tRotV").textContent = Math.round(o.rot);
  saveCfg(); relayoutOne(selIdx); schedulePreview(false);
});
/* 文本框宽度：0 = 自动（按文字实测宽），>0 = 固定框宽，超出部分换行 */
$("tWrap").addEventListener("input", function(){
  var o = curObjs()[selIdx]; if (!o || isStk(o) || isDate(o)) return;
  var v = clamp(Math.round(+$("tWrap").value), 0, EW);
  o.wrap = v;
  $("tWrapV").textContent = v ? v + "px" : "自动";
  saveCfg(); relayoutOne(selIdx); schedulePreview(false);
});
txtEl.addEventListener("input", function(){
  var o = curObjs()[selIdx];
  /* 日期同样接受输入：数字 / 英文照原样式画，样式里没有的字自动回退普通字体 */
  if (o && (isDate(o) || (!isStk(o) && o.type === "text"))){
    o.text = txtEl.value;
    /* 日期一旦被手工改写，就切成「自定义」，不然下次重算又被日期/时间格式盖回去 */
    if (isDate(o)){ o.fmt = "custom"; o.fd = ""; o.ft = ""; }
    relayoutOne(selIdx);
    saveCfg();
    schedulePreview(false);
  } else {
    saveCfg();
  }
});

/* ---------- 贴纸：图标 / 表情 / 上传图片 ---------- */
/* 三条来源各自独立，所以做成三级选项：
     图标 = 字形画在画布上，跟四色调色板（可换色，也不占体积）
     表情 = 系统彩色 emoji 字体（本身就是彩色的，不选色）
     图片 = 上传的原图（原色，不选色，只在本页有效） */
/* 这些图标码位在不少系统默认按**彩色 emoji**呈现（⚡☀☕☘✈✉♥…），
   会混进「图标」页变成彩色图。追加 FE0E（文本呈现符）强制单色字形，
   才能跟四色调色板走 —— 用户要的红心 / 黄星 / 黑纸飞机才成立。 */
function icoEmoPres(cp){
  return cp === 0x2600 || cp === 0x2615 || cp === 0x2618 || cp === 0x2665
      || cp === 0x26A1 || cp === 0x2708 || cp === 0x2709 || cp === 0x2764;
}
var STK_GLYPH = ["★","♥","☀","☾","✿","❀","♪","✈","✉","☘","⚡","☕","✓","➜","▲","●"]
  .map(function(ch){ return icoEmoPres(ch.codePointAt(0)) ? ch + "\uFE0E" : ch; });
var STK_EMOJI = ["😀","😍","🥳","🌸","⭐","🍀","🎁","🐱","🌈","🔥"];
var stkColor = C_K;

function stkCSS(i){
  var p = PAL[clamp(i|0, 0, 3)];
  return "rgb(" + p[0] + "," + p[1] + "," + p[2] + ")";
}
/* 图标格子按当前颜色重画 + 色板选中态（表情格不参与，避免颜色落到表情上） */
function stkPaint(){
  var cells = document.querySelectorAll("#stkRow .stkCell"), i;
  for (i = 0; i < cells.length; i++) cells[i].style.color = stkCSS(stkColor);
  paintSw("stkColors", stkColor);
}
function addStkObj(o){
  o.x = EW/2; o.y = EH/2; o.rot = 0;
  curObjs().push(o);
  selIdx = curObjs().length - 1;
  saveCfg(); layoutObjs(); syncSel(); schedulePreview(false);
  msg("已添加贴纸，拖四角调大小", "ok", 1600);
}
function addStkGlyph(ch){
  addStkObj({ type:"stk", kind:"glyph", ch:ch, color:stkColor, w:200, h:200 });
}
function addStkEmoji(ch){
  addStkObj({ type:"stk", kind:"emoji", ch:ch, w:200, h:200 });
}
function addStkImg(src, ratio){
  var h = 220, w = Math.round(h * (ratio || 1));
  if (w > EW*0.9){ w = Math.round(EW*0.9); h = Math.round(w/(ratio||1)); }
  addStkObj({ type:"stk", kind:"img", src:src, w:w, h:h });
}
function stkCell(ch, emo){
  var b = document.createElement("b");
  b.className = "stkCell" + (emo ? " emo" : "");
  b.textContent = ch;
  b.addEventListener("click", function(){ emo ? addStkEmoji(ch) : addStkGlyph(ch); });
  return b;
}
/* 表情格最前面的「＋」：点开弹窗，用系统输入法打 / 粘贴任意表情 */
function emoAddCell(){
  var b = document.createElement("b");
  b.className = "stkCell add";
  b.id = "stkEmoAdd";
  b.textContent = "＋";
  b.title = "输入法里的表情";
  b.setAttribute("aria-label", "添加表情");
  b.addEventListener("click", openEmoPop);
  return b;
}
/* 图标格最前面的「＋」：和表情那一格一样，点开输入框自己打 / 粘贴符号 */
function icoAddCell(){
  var b = document.createElement("b");
  b.className = "stkCell add";
  b.id = "stkIcoAdd";
  b.textContent = "＋";
  b.title = "输入图标";
  b.setAttribute("aria-label", "添加图标");
  b.addEventListener("click", openIcoPop);
  return b;
}
/* 图标白名单 = 表情白名单去掉 emoji 主体区：
   图标是单色字形（画在画布上跟四色调色板走），彩色 emoji 属于「表情」页，
   两边分开才不会做出「一半黑一半彩」的东西。文字 / 数字同样剔掉。 */
function isIconCode(cp){
  if (cp >= 0x1F000 && cp <= 0x1FAFF) return false;   /* emoji 主体区 → 表情页 */
  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return false;   /* 国旗字母 */
  /* 自带图标格里的 ▲ ● 这类几何图形不在表情白名单里，单独放行：
     它们是单色符号，正是「图标」该收的东西。 */
  if (cp >= 0x2300 && cp <= 0x23FF) return true;      /* 技术符号 ⌘ ⌛ */
  if (cp >= 0x2460 && cp <= 0x24FF) return true;      /* 带圈字符 ① */
  if (cp >= 0x2500 && cp <= 0x25FF) return true;      /* 几何图形 ▲ ● ■ */
  return isEmojiCode(cp);
}
function filterIcon(str){
  var src = String(str), out = "", i, cp;
  for (i = 0; i < src.length; i++){
    cp = src.codePointAt(i);
    if (cp > 0xFFFF) i++;
    if (isIconCode(cp)) out += String.fromCodePoint(cp);
  }
  /* 输入进来的图标同样强制文本呈现，否则打进去的 ⚡ 还是彩色 emoji */
  var a = Array.from(out), j;
  for (j = 0; j < a.length; j++){
    var c = a[j];
    if (c === "\uFE0E" || c === "\uFE0F") continue;
    if (icoEmoPres(c.codePointAt(0))) a[j] = c + "\uFE0E";
  }
  return a.join("");
}
var icoWarned = false;
function openIcoPop(){
  $("stkIcoIn").value = "";
  icoWarned = false;
  $("icoPop").classList.add("show");
  setTimeout(function(){ try { $("stkIcoIn").focus(); } catch(e){} }, 60);
}
function closeIcoPop(){ $("icoPop").classList.remove("show"); }
function icoAdd(){
  var raw = String($("stkIcoIn").value || "");
  var v = filterIcon(raw.replace(/\s+/g, ""));
  if (!v){
    msg(raw.replace(/\s+/g, "") ? "这里只放图标符号，文字请用「文字」" : "先打一个图标", "err");
    return;
  }
  closeIcoPop();
  addStkGlyph(firstGraphemes(v, 1));
}

/* 表情白名单：只留 emoji 与符号区段，中文 / 英文 / 数字 / 标点一律剔掉。
   以前输入法里打「你好」也会被收下，做出来是一坨黑字 —— 现在输入框只收表情。 */
function isEmojiCode(cp){
  if (cp === 0x200D || cp === 0x20E3) return true;              /* 连接符 / 键帽组合 */
  if (cp >= 0xFE00 && cp <= 0xFE0F) return true;                /* 变体选择符 */
  if (cp >= 0x1F000 && cp <= 0x1FAFF) return true;              /* emoji 主体区 */
  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return true;              /* 国旗字母 */
  if (cp >= 0x2190 && cp <= 0x21FF) return true;                /* 箭头 */
  if (cp >= 0x2600 && cp <= 0x27BF) return true;                /* 杂项符号 / 装饰 */
  if (cp >= 0x2900 && cp <= 0x297F) return true;                /* 箭头补充 */
  if (cp >= 0x2B00 && cp <= 0x2BFF) return true;                /* 星星 / 三角 */
  if (cp === 0x203C || cp === 0x2049 || cp === 0x2122 || cp === 0x2139) return true;
  if (cp === 0x3030 || cp === 0x303D || cp === 0x3297 || cp === 0x3299) return true;
  return false;
}
function filterEmoji(str){
  var src = String(str), out = "", i, cp;
  for (i = 0; i < src.length; i++){
    cp = src.codePointAt(i);
    if (cp > 0xFFFF) i++;                       /* 代理对：只前进一次 */
    if (isEmojiCode(cp)) out += String.fromCodePoint(cp);
  }
  return out;
}
/* 取前 n 个字素（不切断 ZWJ 组合表情，如 👨‍👩‍👧 这类） */
function firstGraphemes(s, n){
  var out = "", i = 0, r;
  try {
    if (typeof Intl !== "undefined" && Intl.Segmenter){
      var it = new Intl.Segmenter("zh", { granularity:"grapheme" })
                 .segment(s)[Symbol.iterator]();
      while (i < n){ r = it.next(); if (r.done) break; out += r.value.segment; i++; }
      return out;
    }
  } catch(e){}
  return Array.from(String(s)).slice(0, n).join("");
}
var emoWarned = false;
function openEmoPop(){
  $("stkEmoIn").value = "";          /* 每次打开都是空白，不预填任何表情 */
  emoWarned = false;
  $("emoPop").classList.add("show");
  setTimeout(function(){ try { $("stkEmoIn").focus(); } catch(e){} }, 60);
}
function closeEmoPop(){ $("emoPop").classList.remove("show"); }
function emoAdd(){
  var raw = String($("stkEmoIn").value || "");
  var v = filterEmoji(raw.replace(/\s+/g, ""));
  if (!v){
    msg(raw.replace(/\s+/g, "") ? "这里只放表情，文字请用「文字」" : "先打一个表情", "err");
    return;
  }
  closeEmoPop();
  addStkEmoji(firstGraphemes(v, 2));
}
(function initStk(){
  $("stkRow").appendChild(icoAddCell());      /* 和表情页一样，入口排在最前 */
  STK_GLYPH.forEach(function(ch){ $("stkRow").appendChild(stkCell(ch, false)); });
  $("stkEmo").appendChild(emoAddCell());      /* 添加入口排在选择列最前 */
  STK_EMOJI.forEach(function(ch){ $("stkEmo").appendChild(stkCell(ch, true)); });

  /* 色板：先改当前颜色；已经选中图标贴纸时顺手把它的颜色也换掉 */
  bindSw("stkColors", function(v){
    stkColor = clamp(v|0, 0, 3);
    var o = curObjs()[selIdx];
    if (o && isStk(o) && o.kind === "glyph"){
      o.color = stkColor; saveCfg(); schedulePreview(false);
    }
    stkPaint();
  });
  stkPaint();

  /* 图标弹窗：添加 / 取消 / 点遮罩关闭 / 回车添加 / 实时把非符号剔掉 */
  $("stkIcoOk").addEventListener("click", icoAdd);
  $("stkIcoCancel").addEventListener("click", closeIcoPop);
  $("icoPop").addEventListener("click", function(ev){ if (ev.target === this) closeIcoPop(); });
  $("stkIcoIn").addEventListener("keydown", function(ev){
    if (ev.key === "Enter"){ ev.preventDefault(); icoAdd(); }
  });
  $("stkIcoIn").addEventListener("input", function(){
    var raw = $("stkIcoIn").value;
    var clean = filterIcon(raw.replace(/\s+/g, ""));
    if (clean === raw) return;
    var pos = $("stkIcoIn").selectionStart || 0;
    $("stkIcoIn").value = clean;
    try {
      var at = Math.min(pos, clean.length);
      $("stkIcoIn").setSelectionRange(at, at);
    } catch(e){}
    if (!icoWarned){ icoWarned = true; msg("这里只收图标符号", "err"); }
  });

  $("stkEmoOk").addEventListener("click", emoAdd);
  $("stkEmoCancel").addEventListener("click", closeEmoPop);
  $("emoPop").addEventListener("click", function(ev){ if (ev.target === this) closeEmoPop(); });
  $("stkEmoIn").addEventListener("keydown", function(ev){
    if (ev.key === "Enter"){ ev.preventDefault(); emoAdd(); }
  });
  /* 实时净化：打进文字/数字就地剔掉，光标尽量留在原处 */
  $("stkEmoIn").addEventListener("input", function(){
    var raw = $("stkEmoIn").value;
    var clean = filterEmoji(raw.replace(/\s+/g, ""));
    if (clean === raw) return;
    var pos = $("stkEmoIn").selectionStart || 0;
    $("stkEmoIn").value = clean;
    try {
      var at = Math.min(pos, clean.length);
      $("stkEmoIn").setSelectionRange(at, at);
    } catch(e){}
    if (!emoWarned){ emoWarned = true; msg("这里只收表情符号", "err"); }
  });

  $("stkUp").addEventListener("click", function(){ $("stkFile").click(); });
  $("stkFile").addEventListener("change", function(){
    var f = this.files && this.files[0];
    this.value = "";
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function(){
      var src = fr.result, probe = new Image();
      probe.onload = function(){ addStkImg(src, (probe.naturalWidth || 1) / (probe.naturalHeight || 1)); };
      probe.onerror = function(){ msg("这张图片读不出来", "err"); };
      probe.src = src;
    };
    fr.readAsDataURL(f);
  });
})();

/* ---------- 对象手柄：拖动 / 右下缩放 / 右上旋转 / 左下宽度 / 左上删除 ---------- */
function objScale(){
  return (prevWrapEl.clientWidth || EW) / EW;
}
function ensureObjHandles(el){
  if (el.querySelector(".hnd")) return;
  var hS = document.createElement("i"); hS.className = "hnd h-s"; hS.dataset.a = "s";
  var hR = document.createElement("i"); hR.className = "hnd h-r"; hR.dataset.a = "r";
  var hW = document.createElement("i"); hW.className = "hnd h-w"; hW.dataset.a = "wl";
  var hDel = document.createElement("i"); hDel.className = "hnd h-del"; hDel.dataset.a = "del";
  el.appendChild(hS); el.appendChild(hR); el.appendChild(hW); el.appendChild(hDel);
}
function relayoutOne(i, keepSize, fixedScale){
  var objs = curObjs(), o = objs[i], el = objLayerEl.children[i];
  if (!o || !el) return;
  var s = fixedScale > 0 ? fixedScale : objScale();
  el.style.left = (o.x * s) + "px";
  el.style.top  = (o.y * s) + "px";
  el.style.transform = "translate(-50%,-50%) rotate(" + (+o.rot||0) + "deg)";
  el.classList.toggle("stkbox", isStk(o));
  /* 日期没有宽度手柄：换行由「自定义」里的回车决定，框宽就是最宽那一行 */
  el.classList.toggle("nowrap", isDate(o));
  /* 画布是唯一视觉源（.tobj 文字永久透明），
     手柄框 = 实测包围盒 + 画布同款内边距，永远紧贴内容 */
  if (!keepSize){
    var m = objMetrics(o, s);
    el.style.width  = Math.max(30, Math.round(m.mw + m.pX*2)) + "px";
    el.style.height = Math.max(30, Math.round(m.blockH + m.pY*2)) + "px";
  }
  ensureObjHandles(el);
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
  objLayerEl.style.display = "";     /* 有对象就显示，没有就是空的 */
}
var od = null, objEditing = false;
/* 这一次点在对象上是「点选」还是「拖动」：拖动结束不该再跳面板，
   否则拖完字整个面板被换走，改个位置得重新点回来。 */
var objTapMoved = false;
objLayerEl.addEventListener("pointerdown", function(e){
  var el = e.target.closest ? e.target.closest(".tobj") : null;
  if (!el) return;
  var i = Array.prototype.indexOf.call(objLayerEl.children, el);
  var o = curObjs()[i];
  if (!o) return;
  objTapMoved = false;
  if (selIdx !== i){ selIdx = i; layoutObjs(); syncSel(); }
  if (e.target.dataset && e.target.dataset.a === "del"){   /* 左上红柄：点按删除 */
    curObjs().splice(i, 1); selIdx = -1;
    saveCfg(); layoutObjs(); syncSel(); schedulePreview(false);
    return;
  }
  var r = el.getBoundingClientRect();
  var cx = r.left + r.width/2, cy = r.top + r.height/2;
  /* 两个比例，别混：
       baseS = 布局比例（不含画布显示缩放）—— 手柄框的 left/top/size 都按它算，
               因为 #prevWrap 上的 CSS scale 会把这些值整体放大一次；
       dragS = 手指位移的换算比例（含显示缩放）—— 放大 2× 后拖字要走同样的物理距离。
     ★ 混用就是「控件和控件框错位」：框按 base*z 定位，再被 CSS 放大 z 倍 = z²。 */
  var baseS = objScale();
  var dragS = baseS * ((typeof stageView !== "undefined") ? stageView.z : 1);
  var dragScale = dragS;
  od = { i:i, pid:e.pointerId, act:(e.target.dataset && e.target.dataset.a) || "m",
         stk:isStk(o),
         sx:e.clientX, sy:e.clientY,
         scale:dragScale, fs:baseS,
         x0:o.x, y0:o.y, size0:o.size, rot0:o.rot,
         w0:(+o.w || 0), h0:(+o.h || 0),
         wrap0:(+o.wrap || 0),
         cs:Math.cos((+o.rot||0)*Math.PI/180), sn:Math.sin((+o.rot||0)*Math.PI/180),
         cx:cx, cy:cy,
         d0:Math.hypot(e.clientX-cx, e.clientY-cy),
         a0:Math.atan2(e.clientY-cy, e.clientX-cx)*180/Math.PI };
  objEditing = true;
  relayoutOne(i, false, baseS);
  startLive();             /* 缓存静态画面，首帧实时重绘（画布唯一视觉源） */
  e.preventDefault();
  document.addEventListener("pointermove", odMove, { passive:false });
  document.addEventListener("pointerup", odUp);
  document.addEventListener("pointercancel", odUp);
});
function odMove(e){
  if (!od || e.pointerId !== od.pid) return;   /* 只响应发起手势的指针 */
  var o = curObjs()[od.i]; if (!o) return;
  if (Math.abs(e.clientX - od.sx) + Math.abs(e.clientY - od.sy) > 6) objTapMoved = true;
  var s = od.scale;
  if (od.act === "m"){
    o.x = od.x0 + (e.clientX - od.sx)/s;
    o.y = od.y0 + (e.clientY - od.sy)/s;
  } else if (od.act === "s"){
    var d = Math.hypot(e.clientX-od.cx, e.clientY-od.cy);
    var k = od.d0 > 6 ? d/od.d0 : 1;
    if (od.stk){
      o.w = clamp(Math.round(od.w0 * k), 24, 2000);
      o.h = clamp(Math.round(od.h0 * k), 24, 2000);
    } else {
      o.size = clamp(Math.round(od.size0 * k), 16, 240);
      $("tSize").value = o.size;
    }
  } else if (od.act === "wl"){
    if (o.type === "date") return;                 /* 日期没有宽度手柄 */
    /* 左下宽度柄：位移投影到局部 x 轴（随旋转） */
    var dl = ((e.clientX - od.sx)*od.cs + (e.clientY - od.sy)*od.sn) / s;
    if (od.stk){
      /* 手柄在左边，往左拖 = 变宽 */
      o.w = clamp(Math.round(od.w0 - dl * 2), 24, 2000);
    } else {
      var nw = od.wrap0 ? (od.wrap0 - dl) : (objMetrics(o, 1).mw - dl);
      if (nw >= EW - 8) nw = 0;
      var minW = Math.max(24, Math.round((+o.size||48)*0.7));
      o.wrap = (nw === 0) ? 0 : clamp(Math.round(nw), minW, EW);
      $("tWrap").value = o.wrap;
      $("tWrapV").textContent = o.wrap ? Math.round(o.wrap) + "px" : "自动";
    }
  } else {
    if (od.stk){
      var a = Math.atan2(e.clientY-od.cy, e.clientX-od.cx)*180/Math.PI;
      o.rot = clamp(Math.round(od.rot0 + (a - od.a0)), -180, 180);
    } else {
      var a2 = Math.atan2(e.clientY-od.cy, e.clientX-od.cx)*180/Math.PI;
      o.rot = clamp(snapTextRot(Math.round(od.rot0 + (a2 - od.a0))), -180, 180);
      $("tRot").value = Math.round(o.rot);
      $("tRotV").textContent = Math.round(o.rot);
    }
  }
  scheduleLive();          /* 实时重绘：每帧 = 底图贴回 + 全部对象矢量重画 */
  e.preventDefault();
}
function odUp(e){
  if (e && od && e.pointerId !== od.pid) return;
  if (od){ saveCfg(); }
  od = null; objEditing = false; layoutObjs();
  liveBase = null; liveAbove = null; liveMetric = null;
  if (liveRaf){ cancelAnimationFrame(liveRaf); liveRaf = 0; }
  schedulePreview(false);  /* 松手全量合成 */
  document.removeEventListener("pointermove", odMove);
  document.removeEventListener("pointerup", odUp);
  document.removeEventListener("pointercancel", odUp);
}
