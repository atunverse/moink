/* ==================================================================
   36-note.js —— 便签：文档模型 / 四色主题 / 六种版式 / 纯色绘制
   ------------------------------------------------------------------
   便签和拍立得是两套东西：
     · 拍立得 = 照片 + 自由摆放的文字对象
     · 便签   = 一份结构化文档（一行一块）+ 版式 + 主题
   这里只做「文档 → 四色画面」，不碰 DOM、不碰帧格式。
   drawBase() 的便签分支调 noteRender()，后面 renderComposite →
   snapIdx → packIdx → /api/frame 一行不动，固件零改动。

   ★ 设计约束（四色墨水屏）：
     1) 只用 PAL 的 0 黑 / 1 白 / 2 黄 / 3 红，绝不用灰阶、渐变、阴影、半透明；
     2) 文字最小 16px、正文 20~24px、标题 34~96px，线条 ≥3px；
     3) 黄 + 红面积控制在 15% 左右，白（纸）是主体；
     4) 纯色直出不抖动，可吃 120Hz 快刷。
   ================================================================== */

/* ---------- 版式与主题 ---------- */
var NOTE_LAYOUTS = {
  todo:    "待办清单",
  memo:    "备忘挂件",
  cornell: "康奈尔笔记",
  kanban:  "看板",
  poster:  "纯文字画报",
  dark:    "票根挂件"
};
var NOTE_LAYOUT_ORDER = ["todo", "memo", "cornell", "kanban", "poster", "dark"];

/* 主题 = 5 个 token 各取一个色码。换主题 = 整张纸一起换，不会出现半套配色。
   dark 只标记「这是反相主题」，刷新闪烁更明显，UI 上要提示。 */
var NOTE_THEMES = {
  paper: { name:"纸白",   bg:C_W, ink:C_K, rule:C_K, accent:C_Y, alert:C_R, dark:false },
  gold:  { name:"黄纸",   bg:C_Y, ink:C_K, rule:C_K, accent:C_W, alert:C_R, dark:false },
  ink:   { name:"墨黑",   bg:C_K, ink:C_W, rule:C_W, accent:C_Y, alert:C_R, dark:true  },
  red:   { name:"红标",   bg:C_W, ink:C_K, rule:C_R, accent:C_Y, alert:C_R, dark:false },
  mono:  { name:"极简",   bg:C_W, ink:C_K, rule:C_K, accent:C_K, alert:C_K, dark:false },
  stijl: { name:"风格派", bg:C_W, ink:C_K, rule:C_K, accent:C_R, alert:C_Y, dark:false }
};
var NOTE_THEME_ORDER = ["paper", "gold", "ink", "red", "mono", "stijl"];
var NOTE_TOKENS = ["bg", "ink", "rule", "accent", "alert"];

/* 六种预设文本。切版式时若用户还没改过内容（仍是某份示例），就跟着换示例；
   一旦自己写过字，切版式只换排版、不动内容。 */
var NOTE_SAMPLE = {
  todo:    "# 今日待办\n[ ] 交周报\n[!] 14:00 项目会\n[*] 取快递\n[x] 买牛奶\n- 别忘了带工牌\n@ 2026.11.14",
  memo:    "> 带伞\n- 钥匙 门禁 工牌\n- 关窗 关空调\n[!] 出门前看一眼\n@ MOINK 2026",
  cornell: "# 会议笔记\n:: 线索\n- 议题与结论\n:: 正文\n- 记录要点与待办\n- 会后同步给项目组\n@ p.01",
  kanban:  "# 本周看板\n:: 待办\n[ ] 设计稿\n[ ] 采购清单\n:: 进行中\n[*] 打样\n[!] 交期确认\n:: 完成\n[x] 需求评审\n@ 2026.11.14",
  poster:  "# 26\n> NOV / 2026\n- 把想说的话写下来\n- 贴在每天都会看见的地方\n@ MOINK STUDIO",
  dark:    "> 留言\n- 有事请按门铃\n- 稍后回复\n[!] 请勿张贴广告\n@ 11.14 / 23:40"
};
var NOTE_PRESETS = [
  { name:"今日待办", raw:NOTE_SAMPLE.todo },
  { name:"出门提醒", raw:NOTE_SAMPLE.memo },
  { name:"会议笔记", raw:NOTE_SAMPLE.cornell },
  { name:"本周看板", raw:NOTE_SAMPLE.kanban },
  { name:"一句话",   raw:"> 慢慢来\n- 比较快\n@ MOINK" },
  { name:"清空",     raw:"" }
];

/* ---------- 文档模型 ---------- */
function noteDefault(){
  return { v:1, theme:"paper", layout:"todo", cols:3,
           scale:1, density:"normal", raw:NOTE_SAMPLE.todo,
           tok:null, blocks:[] };
}
function noteNorm(d){
  d = (d && typeof d === "object") ? d : {};
  var o = noteDefault();
  if (NOTE_THEMES[d.theme])   o.theme = d.theme;
  if (NOTE_LAYOUTS[d.layout]) o.layout = d.layout;
  o.cols    = clamp(Math.round(+d.cols || 3), 2, 4);
  o.scale   = clamp(+d.scale || 1, 0.8, 1.4);
  o.density = (d.density === "tight" || d.density === "loose") ? d.density : "normal";
  /* 注意：只有「真没这个字段」才用默认示例；用户显式清空后存下来的 raw=""
     必须保持为空，不能一刷新又冒出示例内容。 */
  o.raw     = (d.raw == null) ? o.raw : String(d.raw);
  o.tok     = null;
  if (d.tok && typeof d.tok === "object"){
    o.tok = {};
    for (var i = 0; i < NOTE_TOKENS.length; i++){
      var k = NOTE_TOKENS[i];
      if (d.tok[k] != null) o.tok[k] = clamp(+d.tok[k] | 0, 0, 3);
    }
  }
  o.blocks = noteParse(o.raw);
  return o;
}
function noteDoc(){
  if (!cfg.noteDoc) cfg.noteDoc = noteDefault();
  return cfg.noteDoc;
}
function noteIsSample(d){
  for (var k in NOTE_SAMPLE) if (NOTE_SAMPLE[k] === d.raw) return true;
  return false;
}
/* 轻量标记：一行一块。# 标题 / [ ] 待办 / [x] 完成 / [!] 紧急 / [*] 优先
   - 笔记 / > 大字 / :: 列头 / --- 分隔 / @ 落款。其余非空行按笔记收。 */
function noteParse(raw){
  var src = String(raw == null ? "" : raw);
  if (!src.trim()) return [];                 /* 空文档就是 0 块，不要留占位块 */
  var lines = src.replace(/\r\n?/g, "\n").split("\n");
  var out = [], i, L, m;
  for (i = 0; i < lines.length; i++){
    L = lines[i];
    if (!L.trim()){ out.push({ t:"gap", text:"" }); continue; }
    if (/^-{3,}\s*$/.test(L)){ out.push({ t:"div", text:"" }); continue; }
    if ((m = L.match(/^#\s*(.+)$/))){ out.push({ t:"title", text:m[1] }); continue; }
    if ((m = L.match(/^\s*\[([ xX!*])\]\s*(.*)$/))){
      var k = m[1];
      out.push({ t:"task", text:m[2],
                 state:(k === "x" || k === "X") ? "done" : "todo",
                 pri:(k === "!") ? "urgent" : (k === "*") ? "high" : "normal" });
      continue;
    }
    if ((m = L.match(/^::\s*(.+)$/))){ out.push({ t:"col", text:m[1] }); continue; }
    if ((m = L.match(/^>\s*(.+)$/))){ out.push({ t:"quote", text:m[1] }); continue; }
    if ((m = L.match(/^-\s*(.+)$/))){ out.push({ t:"note", text:m[1] }); continue; }
    if ((m = L.match(/^@\s*(.+)$/))){ out.push({ t:"meta", text:m[1] }); continue; }
    out.push({ t:"note", text:L });
  }
  return out;
}
function noteSyncBlocks(){
  var d = noteDoc();
  d.blocks = noteParse(d.raw);
  return d;
}
function noteTokens(d){
  var t = NOTE_THEMES[d.theme] || NOTE_THEMES.paper;
  var o = { bg:t.bg, ink:t.ink, rule:t.rule, accent:t.accent,
            alert:t.alert, dark:!!t.dark };
  if (d.tok) for (var i = 0; i < NOTE_TOKENS.length; i++){
    var k = NOTE_TOKENS[i];
    if (d.tok[k] != null) o[k] = d.tok[k];
  }
  return o;
}
function noteSetRaw(s){
  var d = noteDoc();
  d.raw = String(s == null ? "" : s);
  noteSyncBlocks();
  saveCfg();
  if (typeof schedulePreview === "function") schedulePreview(false);
}
function noteSetLayout(name){
  if (!NOTE_LAYOUTS[name]) return;
  var d = noteDoc();
  if (d.layout !== name && noteIsSample(d)) d.raw = NOTE_SAMPLE[name];
  d.layout = name;
  noteSyncBlocks();
  saveCfg();
  if (typeof noteSyncUI === "function") noteSyncUI();
  if (typeof schedulePreview === "function") schedulePreview(false);
}
function noteSetTheme(name){
  if (!NOTE_THEMES[name]) return;
  var d = noteDoc();
  d.theme = name; d.tok = null;      /* 换主题 = 恢复整套 token */
  saveCfg();
  if (typeof noteSyncUI === "function") noteSyncUI();
  if (typeof schedulePreview === "function") schedulePreview(false);
}
function noteSetTok(k, v){
  if (NOTE_TOKENS.indexOf(k) < 0) return;
  var d = noteDoc();
  if (!d.tok) d.tok = {};
  d.tok[k] = clamp(+v | 0, 0, 3);
  saveCfg();
  if (typeof noteSyncUI === "function") noteSyncUI();
  if (typeof schedulePreview === "function") schedulePreview(false);
}
function noteSet(k, v){
  var d = noteDoc();
  if (k === "cols")    d.cols = clamp(Math.round(+v), 2, 4);
  if (k === "scale")   d.scale = clamp(+v, 0.8, 1.4);
  if (k === "density") d.density = (v === "tight" || v === "loose") ? v : "normal";
  saveCfg();
  if (typeof noteSyncUI === "function") noteSyncUI();
  if (typeof schedulePreview === "function") schedulePreview(false);
}

/* ---------- 绘制原语（全部纯色，逻辑坐标 552×768） ---------- */
function ntRGB(c){
  var p = PAL[clamp(c | 0, 0, 3)];
  return "rgb(" + p[0] + "," + p[1] + "," + p[2] + ")";
}
function ntBox(ctx, x, y, w, h, c){
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = ntRGB(c);
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
function ntFont(sz, bold){
  return (bold ? 700 : 500) + " " + sz + "px " +
         "-apple-system,'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif";
}
/* 画两遍同一个字：Canvas 抗锯齿的半透明边缘被加深，snapIdx 之后
   不会把灰边误判成黄/红噪点（四色屏上这一点比「边缘更顺滑」重要得多）。 */
function ntText(ctx, s, x, y, sz, c, align, maxW, bold){
  var str = String(s == null ? "" : s);
  ctx.font = ntFont(sz, bold);
  ctx.textAlign = align || "left";
  ctx.textBaseline = "middle";
  if (maxW > 0 && ctx.measureText(str).width > maxW){
    while (str.length > 1 && ctx.measureText(str + "…").width > maxW)
      str = str.slice(0, -1);
    str += "…";
  }
  ctx.fillStyle = ntRGB(c);
  ctx.fillText(str, x, y);
  ctx.fillText(str, x, y);
  return str;
}
/* 色块上的文字色：黄 / 白底用黑字，黑 / 红底用白字 */
function ntOn(c){ return (c === C_Y || c === C_W) ? C_K : C_W; }
function ntFirst(B, t){
  for (var i = 0; i < B.length; i++) if (B[i].t === t) return B[i].text;
  return "";
}
function ntFilter(B, types){
  var o = [];
  for (var i = 0; i < B.length; i++)
    if (types.indexOf(B[i].t) >= 0) o.push(B[i]);
  return o;
}
function ntCheck(ctx, x, y, T, mode){
  /* mode: none / fill / accent / alert —— 外框 20px，线宽 3px（≥3px 硬边） */
  var c = (mode === "accent") ? T.accent : (mode === "alert") ? T.alert : T.ink;
  ntBox(ctx, x, y, 20, 20, c);
  ntBox(ctx, x + 3, y + 3, 14, 14, T.bg);
  if (mode === "fill") ntBox(ctx, x + 3, y + 3, 14, 14, c);
}
function ntFooter(ctx, B, T, y){
  var meta = ntFirst(B, "meta") || "MOINK";
  ntText(ctx, meta, 40, y, 16, T.ink, "left", 320);
  ntText(ctx, "MOINK", 512, y, 16, T.ink, "right", 120);
}
function ntMore(ctx, n, y, x, T){
  if (n > 0) ntText(ctx, "+ " + n + " 条", x, y, 18, T.alert, "left", 200);
}
function ntDensity(d){
  return d.density === "tight" ? 0.84 : d.density === "loose" ? 1.18 : 1;
}

/* ---------- 版式 1 · 待办清单 ---------- */
function ntTodo(ctx, B, T, d){
  var M = 40, CW = 472, sc = d.scale * ntDensity(d);
  var title = ntFirst(B, "title") || "便签";
  ntBox(ctx, M, 44, 8, 44, T.accent);
  ntText(ctx, title, M + 22, 66, 34 * d.scale, T.ink, "left", CW - 140, true);
  var meta = ntFirst(B, "meta");
  if (meta) ntText(ctx, meta, M + CW, 66, 16, T.alert, "right", 130);
  ntBox(ctx, M, 104, CW, 4, T.rule);

  var items = ntFilter(B, ["task", "note", "quote", "div"]);
  var lh = Math.round(56 * sc), top = 136;
  var maxN = Math.max(1, Math.floor((690 - top) / lh));
  var i, b, y, mode, str;
  for (i = 0; i < Math.min(items.length, maxN); i++){
    b = items[i]; y = top + i * lh;
    if (b.t === "div"){ ntBox(ctx, M, y - 2, CW, 3, T.rule); continue; }
    if (b.t === "task"){
      mode = b.state === "done" ? "fill"
           : b.pri === "urgent" ? "alert"
           : b.pri === "high"  ? "accent" : "none";
      ntCheck(ctx, M, y - 10, T, mode);
      str = ntText(ctx, b.text, M + 34, y, 23 * d.scale, T.ink, "left", CW - 40);
      if (b.state === "done"){
        ctx.font = ntFont(23 * d.scale, false);
        var stw = ctx.measureText(str).width;
        ntBox(ctx, M + 34, y, Math.min(stw, CW - 40), 3, T.ink);
      }
    } else {
      ntText(ctx, (b.t === "quote" ? "" : "– ") + b.text,
             M + 8, y, (b.t === "quote" ? 27 : 20) * d.scale,
             T.ink, "left", CW - 16);
    }
  }
  ntMore(ctx, items.length - maxN, top + maxN * lh, M + 8, T);
  ntBox(ctx, M, 708, CW, 4, T.accent);
  ntFooter(ctx, B, T, 734);
}

/* ---------- 版式 2 · 备忘挂件 ---------- */
function ntMemo(ctx, B, T, d){
  var M = 40, CW = 472, sc = d.scale * ntDensity(d);
  var big = ntFirst(B, "quote") || ntFirst(B, "title") || "带伞";
  var sub = ntFirst(B, "note") || ntFirst(B, "task");
  ntBox(ctx, M, 40, CW, 200, T.accent);
  ntText(ctx, String(big).slice(0, 6), M + 20, 112, 64 * d.scale,
         ntOn(T.accent), "left", CW - 40, true);
  if (sub) ntText(ctx, sub, M + 20, 208, 24 * d.scale, ntOn(T.accent), "left", CW - 40);

  var items = ntFilter(B, ["task", "note", "div"]);
  var lh = Math.round(54 * sc), top = 284;
  var maxN = Math.max(1, Math.floor((612 - top) / lh));
  var i, b, y;
  for (i = 0; i < Math.min(items.length, maxN); i++){
    b = items[i]; y = top + i * lh;
    if (b.t === "div"){ ntBox(ctx, M, y - 2, CW, 3, T.rule); continue; }
    if (b.t === "task" && (b.pri === "urgent" || b.state === "done"))
      ntBox(ctx, M, y - 8, 12, 12, b.pri === "urgent" ? T.alert : T.ink);
    else
      ntBox(ctx, M, y - 3, 8, 5, T.rule);
    ntText(ctx, b.text, M + 24, y, 24 * d.scale, T.ink, "left", CW - 30);
  }
  ntMore(ctx, items.length - maxN, top + maxN * lh, M + 8, T);

  ntBox(ctx, M, 640, CW, 68, T.ink);
  ntText(ctx, "出门前看一眼", M + 16, 674, 22 * d.scale, ntOn(T.ink), "left", CW - 32);
  ntFooter(ctx, B, T, 734);
}

/* ---------- 版式 3 · 康奈尔笔记 ---------- */
function ntCornell(ctx, B, T, d){
  var M = 40, CW = 472, sc = d.scale * ntDensity(d);
  var title = ntFirst(B, "title") || "笔记";
  ntBox(ctx, M, 40, CW, 36, T.ink);
  ntText(ctx, "NOTE / " + title, M + 10, 58, 18, ntOn(T.ink), "left", CW - 20);

  var cueW = 120;
  ntBox(ctx, M, 92, cueW, 520, T.accent);
  ntText(ctx, "KEY", M + 12, 118, 18, ntOn(T.accent), "left", cueW - 24);
  ntBox(ctx, M + 12, 134, cueW - 30, 3, ntOn(T.accent));
  var cues = ntFilter(B, ["col"]);
  for (var c = 0; c < Math.min(cues.length, 6); c++){
    var cy = 172 + c * 60;
    ntBox(ctx, M + 12, cy - 6, 8, 8, ntOn(T.accent));
    ntText(ctx, cues[c].text, M + 26, cy, 18, ntOn(T.accent), "left", cueW - 36);
  }

  var rx = M + cueW + 16, rw = CW - cueW - 16;
  var notes = ntFilter(B, ["note", "quote", "task"]);
  var lh = Math.round(46 * sc), top = 124;
  var maxN = Math.max(1, Math.floor((590 - top) / lh));
  for (var i = 0; i < Math.min(notes.length, maxN); i++){
    var b = notes[i], y = top + i * lh;
    if (b.t === "task" && b.pri === "urgent")
      ntBox(ctx, rx, y + 12, 20, 3, T.alert);
    ntText(ctx, (b.t === "quote" ? "" : "· ") + b.text, rx, y,
           (b.t === "quote" ? 26 : 21) * d.scale, T.ink, "left", rw);
  }
  ntMore(ctx, notes.length - maxN, top + maxN * lh, rx, T);

  ntBox(ctx, M, 622, CW, 3, T.rule);
  ntBox(ctx, M, 636, CW, 4, T.alert);
  ntText(ctx, "摘要  " + (ntFirst(B, "meta") || ""), M + 4, 664, 20 * d.scale,
         T.ink, "left", CW - 8);
  ntText(ctx, "把要点写成一句话，回头一眼就能想起", M + 4, 694, 18 * d.scale,
         T.ink, "left", CW - 8);
  ntFooter(ctx, B, T, 734);
}

/* ---------- 版式 4 · 看板 ---------- */
function ntKanban(ctx, B, T, d){
  var M = 40, CW = 472;
  var title = ntFirst(B, "title") || "看板";
  ntBox(ctx, M, 44, 8, 40, T.accent);
  ntText(ctx, title, M + 22, 66, 32 * d.scale, T.ink, "left", CW - 100, true);

  /* 有 :: 列头就按列头分组；没有就按任务状态自动分三组 */
  var cols = [], cur = null, i, b;
  for (i = 0; i < B.length; i++){
    b = B[i];
    if (b.t === "col"){ cur = { name:b.text, items:[] }; cols.push(cur); continue; }
    if (b.t === "task" || b.t === "note"){
      if (!cur){ cur = { name:"待办", items:[] }; cols.push(cur); }
      cur.items.push(b);
    }
  }
  if (!cols.length || (cols.length === 1 && cols[0].name === "待办")){
    cols = [ { name:"待办", items:[] }, { name:"进行中", items:[] }, { name:"完成", items:[] } ];
    var tasks = ntFilter(B, ["task", "note"]);
    for (i = 0; i < tasks.length; i++){
      b = tasks[i];
      var g = (b.state === "done") ? 2 : (b.pri === "urgent" || b.pri === "high") ? 1 : 0;
      cols[g].items.push(b);
    }
  }
  var n = clamp(d.cols, 2, 4);
  while (cols.length > n){                 /* 超出的列并入最后一列 */
    var extra = cols.pop();
    cols[cols.length - 1].items = cols[cols.length - 1].items.concat(extra.items);
  }
  while (cols.length < n) cols.push({ name:"—", items:[] });

  var gap = 12, colW = (CW - gap * (n - 1)) / n;
  var headC = [T.ink, T.accent, T.alert, T.rule];
  var cardH = 64, cardGap = 8, cardTop = 136;
  var maxN = Math.max(1, Math.floor((536 - cardTop) / (cardH + cardGap)));
  for (i = 0; i < n; i++){
    var x = M + i * (colW + gap), hc = headC[i % headC.length];
    ntBox(ctx, x, 92, colW, 32, hc);
    ntText(ctx, cols[i].name, x + 8, 108, 20, ntOn(hc), "left", colW - 16);
    for (var j = 0; j < Math.min(cols[i].items.length, maxN); j++){
      var it = cols[i].items[j], y = cardTop + j * (cardH + cardGap);
      ntBox(ctx, x, y, colW, cardH, T.rule);
      ntBox(ctx, x + 3, y + 3, colW - 6, cardH - 6, T.bg);
      if (it.t === "task" && it.pri === "urgent") ntBox(ctx, x + 3, y + 3, 8, cardH - 6, T.alert);
      if (it.t === "task" && it.pri === "high")   ntBox(ctx, x + 3, y + 3, 8, cardH - 6, T.accent);
      ntText(ctx, it.text, x + 14, y + 26, 18 * d.scale, T.ink, "left", colW - 26);
      ntText(ctx, it.t === "task" ? (it.state === "done" ? "完成" : "待办") : "笔记",
             x + 14, y + 48, 16, T.ink, "left", colW - 26);
    }
    var rest = cols[i].items.length - maxN;
    if (rest > 0) ntText(ctx, "+ " + rest + " more", x + 6,
                         cardTop + maxN * (cardH + cardGap), 16, T.alert, "left", colW - 12);
  }
  /* 下半部完成度：大数字 + 四色进度条。既是有用的信息，也把看板常见的
     大片留白填上（e-ink dashboard 的 INFO 栏就是这个思路）。 */
  var done = 0, total = 0, ci, cj;
  for (ci = 0; ci < n; ci++) for (cj = 0; cj < cols[ci].items.length; cj++){
    var it2 = cols[ci].items[cj];
    if (it2.t !== "task") continue;
    total++; if (it2.state === "done") done++;
  }
  ntBox(ctx, M, 568, CW, 3, T.rule);
  ntText(ctx, String(done), M, 628, 72 * d.scale, T.ink, "left", 150, true);
  ntText(ctx, "/ " + total, M + 132, 646, 28 * d.scale, T.ink, "left", 100);
  ntText(ctx, "本周完成", M + CW, 610, 22 * d.scale, T.ink, "right", 220, true);
  ntText(ctx, "已完成条目 / 全部条目", M + CW, 642, 16, T.ink, "right", 240);
  ntBox(ctx, M, 674, CW, 18, T.rule);
  if (total > 0) ntBox(ctx, M + 2, 676, Math.max(0, (CW - 4) * done / total), 14, T.accent);
  ntBox(ctx, M, 708, CW, 4, T.accent);
  ntFooter(ctx, B, T, 734);
}

/* ---------- 版式 5 · 纯文字画报（瑞士网格） ---------- */
function ntPoster(ctx, B, T, d){
  var M = 40, CW = 472;
  var hero = ntFirst(B, "title") || "26";
  ntText(ctx, String(hero).slice(0, 3), M - 2, 112, 96 * d.scale,
         T.ink, "left", 270, true);
  ntBox(ctx, 320, 40, 192, 150, T.alert);
  ntBox(ctx, M, 208, CW, 26, T.ink);

  /* quote 专供底部黄带做标题，不再混进正文重复出现 */
  var notes = ntFilter(B, ["note"]);
  var top = 272, lh = Math.round(52 * ntDensity(d));
  var maxN = Math.max(1, Math.floor((540 - top) / lh));
  for (var i = 0; i < Math.min(notes.length, maxN); i++){
    ntText(ctx, notes[i].text, M, top + i * lh,
           (notes[i].t === "quote" ? 28 : 22) * d.scale, T.ink, "left", CW);
    ntBox(ctx, M, top + i * lh + 22, CW, 2, T.rule);
  }
  ntMore(ctx, notes.length - maxN, top + maxN * lh, M, T);

  ntBox(ctx, M, 566, CW, 128, T.accent);
  ntText(ctx, ntFirst(B, "quote") || "NOV / 2026", M + 16, 626, 36 * d.scale,
         ntOn(T.accent), "left", CW - 32, true);
  ntFooter(ctx, B, T, 734);
}

/* ---------- 版式 6 · 票根挂件 ---------- */
function ntStub(ctx, B, T, d){
  var M = 40, CW = 472;
  var big = ntFirst(B, "quote") || ntFirst(B, "title") || "留言";
  ntBox(ctx, M, 40, CW, 6, T.accent);
  ntText(ctx, String(big).slice(0, 5), M + 8, 142, 72 * d.scale,
         T.ink, "left", CW - 16, true);

  var notes = ntFilter(B, ["note", "task", "div"]);
  var top = 228, lh = Math.round(50 * ntDensity(d));
  var maxN = Math.max(1, Math.floor((436 - top) / lh));
  for (var i = 0; i < Math.min(notes.length, maxN); i++){
    var b = notes[i], y = top + i * lh;
    if (b.t === "div"){ ntBox(ctx, M, y - 2, CW, 3, T.rule); continue; }
    if (b.t === "task" && b.pri === "urgent")
      ntBox(ctx, M, y - 12, 12, 24, T.alert);
    ntText(ctx, b.text, M + 20, y, 22 * d.scale, T.ink, "left", CW - 24);
  }
  ntMore(ctx, notes.length - maxN, top + maxN * lh, M + 20, T);

  ntBox(ctx, M, 470, 120, 120, T.alert);
  ntText(ctx, "!", M + 60, 530, 64, ntOn(T.alert), "center", 0, true);
  ntBox(ctx, M + 140, 492, CW - 140, 8, T.ink);
  ntBox(ctx, M + 140, 522, CW - 190, 8, T.ink);
  ntBox(ctx, M + 140, 552, CW - 160, 8, T.ink);

  /* 票根齿孔：一排硬边小方齿，全部纯色，不用圆弧抗锯齿 */
  for (var k = 0; k < 12; k++) ntBox(ctx, M + k * 40, 660, 22, 10, T.rule);
  ntBox(ctx, M, 690, CW, 4, T.accent);
  ntFooter(ctx, B, T, 734);
}

var NOTE_DRAW = {
  todo:ntTodo, memo:ntMemo, cornell:ntCornell,
  kanban:ntKanban, poster:ntPoster, dark:ntStub
};

/* ---------- 画布入口（由 drawBase 的便签分支调用） ---------- */
function noteRender(ctx, cw, ch){
  var d = noteDoc();
  var T = noteTokens(d);
  var s = cw / EW;
  ctx.save();
  ctx.scale(s, s);
  /* 纸底：整幅铺满，不留透明区（snapIdx 见到透明会当黑色） */
  ntBox(ctx, 0, 0, EW, EH, T.bg);
  var B = (d.blocks && d.blocks.length) ? d.blocks : noteParse(d.raw);
  var fn = NOTE_DRAW[d.layout] || ntTodo;
  try { fn(ctx, B, T, d); }
  catch (e){
    /* 版式画失败也要给一张能看的纸，不能让整页预览挂掉 */
    ntText(ctx, "便签排版出错", 40, 80, 24, T.ink, "left", 472, true);
  }
  ctx.restore();
}
