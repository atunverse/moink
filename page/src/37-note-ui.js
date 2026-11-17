/* ==================================================================
   37-note-ui.js —— 便签面板接线
   ------------------------------------------------------------------
   底栏便签态是 版式 / 内容 / 配色 / 保存（先选版式再写内容）。
   胶囊、色点、滑块全部复用已有那套；六个 select 的 option 与五个色点行
   在这里由 36-note.js 的表生成 —— HTML 只留空壳，避免两处各写一份。

   所有绑定都放在 noteInit() 里，由 70-boot.js 在 loadCfg() 之后调用。
   ================================================================== */

/* 点胶囊往输入框追加一行。select 的 value 不是状态，处理完立刻回置成空，
   否则再点同一颗不会触发 change。 */
var NOTE_INSERT = {
  title:"# 标题", task:"[ ] ", urgent:"[!] ", done:"[x] ", high:"[*] ",
  note:"- ", quote:"> ", col:":: ", div:"---", meta:"@ "
};
var NOTE_TOK_ROWS = {
  bg:"noteTokBg", ink:"noteTokInk", rule:"noteTokRule",
  accent:"noteTokAccent", alert:"noteTokAlert"
};
var NOTE_TOK_LABELS = {
  bg:"纸底", ink:"正文", rule:"分隔", accent:"强调", alert:"警示"
};
var NOTE_SW_NAMES = ["黑", "白", "黄", "红"];

/* 六个下拉框的选项全部从 36-note.js 的表派生，改版式/主题只改一处 */
function noteOptions(){
  var o = {
    noteCols:[["2","2 列"], ["3","3 列"], ["4","4 列"]],
    noteDensity:[["tight","紧凑"], ["normal","标准"], ["loose","宽松"]],
    noteInsert:[["title","标题"], ["task","待办"], ["urgent","紧急"],
               ["done","完成"], ["high","优先"], ["note","笔记"],
               ["quote","大字"], ["col","列头"], ["div","分隔"], ["meta","落款"]],
    noteLayout:[], noteTheme:[], notePreset:[]
  };
  for (var i = 0; i < NOTE_LAYOUT_ORDER.length; i++){
    var k = NOTE_LAYOUT_ORDER[i];
    o.noteLayout.push([k, NOTE_LAYOUTS[k]]);
  }
  for (var j = 0; j < NOTE_THEME_ORDER.length; j++){
    var t = NOTE_THEME_ORDER[j];
    o.noteTheme.push([t, NOTE_THEMES[t].name]);
  }
  for (var p = 0; p < NOTE_PRESETS.length; p++)
    o.notePreset.push([String(p), NOTE_PRESETS[p].name]);
  return o;
}

/* 一行四色点：data-v 是值、data-c 是外观，与拍立得那套色点完全一致 */
function noteSwRow(id, label){
  var row = document.createElement("div");
  row.className = "swRow"; row.id = id;
  var sp = document.createElement("span");
  sp.textContent = label; row.appendChild(sp);
  for (var i = 0; i < 4; i++){
    var b = document.createElement("b");
    b.className = "sw"; b.dataset.v = i; b.dataset.c = i;
    b.title = NOTE_SW_NAMES[i];
    b.setAttribute("aria-label", NOTE_SW_NAMES[i]);
    row.appendChild(b);
  }
  return row;
}

/* 只跑一次：把 HTML 里的空 select / 空 box 补成完整控件 */
function noteBuildControls(){
  var opts = noteOptions(), k;
  for (k in opts){
    var sel = $(k);
    if (!sel) continue;
    for (var i = 0; i < opts[k].length; i++){
      var op = document.createElement("option");
      op.value = opts[k][i][0];
      op.textContent = opts[k][i][1];
      sel.appendChild(op);
    }
  }
  var boxes = document.querySelectorAll('#sheet .pane[data-pane="ntheme"] .box[data-tok]');
  for (var j = 0; j < boxes.length; j++){
    var key = boxes[j].dataset.tok;
    if (NOTE_TOK_ROWS[key])
      boxes[j].appendChild(noteSwRow(NOTE_TOK_ROWS[key], NOTE_TOK_LABELS[key]));
  }
}

/* 版式变了才重建三级选项条：栏数/密度按版式显隐，滑块拖动不触发重排 */
var noteLastLayout = "";
function noteSyncLvl(){
  var lay = noteDoc().layout;
  if (lay === noteLastLayout) return;
  noteLastLayout = lay;
  if (typeof curTool !== "undefined" && curTool === "nlayout"
      && typeof showLvl === "function") showLvl("nlayout");
}

function noteSyncUI(){
  var d = noteDoc(), T = noteTokens(d);
  var ta = $("noteRaw");
  if (ta && ta.value !== d.raw) ta.value = d.raw;

  var sels = [
    ["noteLayout",  d.layout,   "noteLayoutRow"],
    ["noteCols",    String(d.cols),    "noteColsRow"],
    ["noteDensity", d.density,  "noteDensityRow"],
    ["noteTheme",   d.theme,    "noteThemeRow"]
  ];
  for (var i = 0; i < sels.length; i++){
    var el = $(sels[i][0]);
    if (!el) continue;
    el.value = sels[i][1];
    if (typeof paintChips === "function") paintChips(sels[i][0], sels[i][2]);
  }
  /* 这两行是「动作」不是状态，永远停在占位项上 */
  ["noteInsert", "notePreset"].forEach(function(id){
    var el = $(id);
    if (!el) return;
    el.value = "";
    if (typeof paintChips === "function") paintChips(id, id + "Row");
  });

  var sc = $("noteScale");
  if (sc){
    sc.value = Math.round(d.scale * 100);
    if ($("noteScaleV")) $("noteScaleV").textContent = sc.value + "%";
    if (typeof paintRange === "function") paintRange(sc);
  }
  for (var k in NOTE_TOK_ROWS){
    if (typeof paintSw === "function") paintSw(NOTE_TOK_ROWS[k], T[k]);
  }
  if ($("noteCount")){
    var n = 0;
    for (var j = 0; j < d.blocks.length; j++) if (d.blocks[j].t !== "gap") n++;
    $("noteCount").textContent = n + " 个内容块";
  }
  if ($("noteThemeHint")){
    var th = NOTE_THEMES[d.theme] || NOTE_THEMES.paper;
    $("noteThemeHint").textContent = th.dark
      ? th.name + " · 深色主题整屏反相，刷新闪烁会更明显"
      : th.name + " · 纸底 / 正文 / 强调 / 警示 四色分工";
  }
  noteSyncLvl();
}

function noteInit(){
  var ta = $("noteRaw");
  if (!ta) return;                    /* 老页面没有便签面板，直接跳过 */
  noteBuildControls();                /* 先补控件，下面才绑定事件与回填 */

  ta.addEventListener("input", function(){
    noteSetRaw(this.value);
    var d = noteDoc(), n = 0;
    for (var i = 0; i < d.blocks.length; i++) if (d.blocks[i].t !== "gap") n++;
    if ($("noteCount")) $("noteCount").textContent = n + " 个内容块";
  });

  /* 插入块 / 预设文档 */
  $("noteInsert").addEventListener("change", function(){
    var v = this.value;
    this.value = "";
    if (!v || !NOTE_INSERT[v]) { noteSyncUI(); return; }
    var t = ta.value;
    if (t && t.charAt(t.length - 1) !== "\n") t += "\n";
    t += NOTE_INSERT[v];
    ta.value = t;
    noteSetRaw(t);
    noteSyncUI();
    try { ta.focus(); ta.setSelectionRange(t.length, t.length); } catch (e){}
  });
  $("notePreset").addEventListener("change", function(){
    var v = +this.value;
    this.value = "";
    if (NOTE_PRESETS[v]){
      noteSetRaw(NOTE_PRESETS[v].raw);
      noteSyncUI();
    }
  });

  /* 版式 / 网格 */
  $("noteLayout").addEventListener("change",  function(){ noteSetLayout(this.value); });
  $("noteCols").addEventListener("change",     function(){ noteSet("cols", +this.value); });
  $("noteDensity").addEventListener("change", function(){ noteSet("density", this.value); });
  $("noteScale").addEventListener("input", function(){
    var v = +this.value / 100;
    if ($("noteScaleV")) $("noteScaleV").textContent = this.value + "%";
    if (typeof paintRange === "function") paintRange(this);
    noteSet("scale", v);
  });

  /* 主题 / 色板 */
  $("noteTheme").addEventListener("change", function(){ noteSetTheme(this.value); });
  for (var k in NOTE_TOK_ROWS){
    (function(key, id){
      if (typeof bindSw === "function") bindSw(id, function(v){ noteSetTok(key, v); });
    })(k, NOTE_TOK_ROWS[k]);
  }
  $("noteTokReset").addEventListener("click", function(){
    var d = noteDoc();
    d.tok = null;
    saveCfg(); noteSyncUI();
    if (typeof schedulePreview === "function") schedulePreview(false);
  });

  noteSyncUI();
}
