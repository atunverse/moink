/* ==================================================================
   32-style.js —— 风格预设与高级参数
   ================================================================== */
/* ---------- 风格 ---------- */
function setCtrlVal(c, val){
  var el = $(c.id);
  el.value = Math.round(val*c.sc);
  var out = $("o-" + c.id);
  if (out) out.textContent = fmtCtrl(c, +el.value / c.sc);
  cfg[c.key] = +el.value / c.sc;
}
function modeName(m){
  return { natural:"自然暖调", adaptive:"全面暖色", gray:"纯灰度", naive:"原色直出" }[m] || m;
}
function mark(elId, isDef){ var el = $(elId); if (el) el.classList.toggle("off", !!isDef); }
function refreshDefMarks(){
  var m = CORE[cfg.mode] || CORE.natural;
  var coreDef = m.key ? (Math.abs(cfg[m.key] - m.def) < 0.005) : true;
  mark("d-core", coreDef);
  var nDiff = 0;
  CTRL.forEach(function(c){
    var rawDef = Math.round(DEF[c.key]*c.sc);
    var isDef = (+$(c.id).value === rawDef);
    mark("d-" + c.id, isDef);
    if (!isDef) nDiff++;
  });
  mark("d-levels", !!cfg.autoLevels === !!DEF.autoLevels);
  if (cfg.autoLevels != DEF.autoLevels) nDiff++;
  mark("d-dmode", cfg.dither === DEF.dither);
  if (cfg.dither !== DEF.dither) nDiff++;
  mark("d-space", (cfg.space || DEF.space) === DEF.space);
  if ((cfg.space || DEF.space) !== DEF.space) nDiff++;
  if (!coreDef) nDiff++;
  if (cfg.mode !== DEF.mode) nDiff++;
  var all = (nDiff === 0);
  mark("d-all", all);
  syncDmodeHint();
}
function applyMode(mode){
  cfg.mode = mode;
  document.querySelectorAll("#presets button").forEach(function(b){
    b.classList.toggle("on", b.dataset.m === mode);
  });
  var m = CORE[mode] || CORE.natural;
  $("coreLab").textContent = m.lab;   /* 预设只有一项参数，标签随预设换 */
  /* 纯灰度 / 原色直出没有「色彩强度」这个参数：整行（标签 + 滑块 + 还原）收起，
     不留一根拖了没反应的滑轨。 */
  var row = $("coreRow");
  if (row) row.style.display = m.key ? "" : "none";
  if (m.key){
    coreEl.disabled = false;
    coreEl.value = Math.round(cfg[m.key]*100);
    $("o-core").textContent = coreEl.value;
  } else {
    coreEl.disabled = true;
    $("o-core").textContent = "—";
  }
  refreshDefMarks(); saveCfg();
}

/* 动态生成 13 个高级滑块。
   R1.4.1：不再堆进「基础 / 暖调 / 四色 / 锐化」四个面板，而是**一项一个 .box**，
   每个 .box 挂在对应的二级分组下（HTML 里已经写好空壳 #ctrls-<key>）。
   这样三级选项条能直接按 .box 生成「亮度 / 对比度 / 伽马…」，
   选中哪项才显示哪项的滑块 —— 一屏最多一行滑块。 */
(function(){
  CTRL.forEach(function(c){
    var box = $("ctrls-" + c.key);
    if (!box) return;
    var d = document.createElement("div");
    d.className = "slider";
    var lab = document.createElement("label");
    lab.textContent = (c.key === "warmCenter" || c.key === "warmSpan" || c.key === "coolCap" || c.key === "warmPullCap")
      ? ({warmCenter:"暖色中心",warmSpan:"暖色跨度",coolCap:"冷色上限",warmPullCap:"暖色吸引上限"}[c.key])
      : ({brightness:"亮度",contrast:"对比度",gamma:"伽马",saturation:"饱和度",coolPull:"冷色抑制",coolDesat:"冷色去饱和",warmPull:"暖色吸引",sharpen:"锐化",ditherStrength:"抖动强度"}[c.key]);
    var in_ = document.createElement("input");
    in_.type = "range"; in_.id = c.id;
    in_.min = Math.round((c.key === "gamma" ? 0.5 : (c.key === "warmCenter" ? 0 : 0)) * (c.key==="gamma"?100:c.sc));
    if (c.key === "gamma"){ in_.min = 50; in_.max = 250; }
    else if (c.key === "brightness" || c.key === "contrast"){ in_.min = -100; in_.max = 100; }
    else if (c.key === "warmCenter"){ in_.min = 0; in_.max = 60; }
    else if (c.key === "warmSpan"){ in_.min = 10; in_.max = 120; }
    else if (c.key === "coolCap" || c.key === "warmPullCap"){ in_.min = 0; in_.max = 60; }
    else { in_.min = 0; in_.max = 100; }
    in_.value = Math.round(DEF[c.key]*c.sc);
    var out = document.createElement("output");
    out.id = "o-" + c.id;
    var dm = document.createElement("span");
    dm.className = "dmark off"; dm.id = "d-" + c.id; dm.textContent = "默认";
    /* R1.3.7：点击「默认」角标恢复该项默认值（仅该项，不影响其他参数） */
    dm.addEventListener("click", function(){
      setCtrlVal(c, DEF[c.key]);
      refreshDefMarks(); saveCfg(); schedulePreview(true);
      msg("已恢复「" + lab.textContent + "」默认值", "ok");
    });
    d.appendChild(lab); d.appendChild(in_); d.appendChild(out); d.appendChild(dm);
    box.appendChild(d);

    in_.addEventListener("input", function(){
      cfg[c.key] = +in_.value / c.sc;
      out.textContent = fmtCtrl(c, +in_.value / c.sc);
      refreshDefMarks(); saveCfg(); schedulePreview(true);
    });
    in_.addEventListener("change", function(){ schedulePreview(false); });
  });
})();

coreEl.addEventListener("input", function(){
  var m = CORE[cfg.mode];
  if (!m.key) return;
  cfg[m.key] = +coreEl.value/100;
  $("o-core").textContent = coreEl.value;
  refreshDefMarks(); saveCfg(); schedulePreview(true);
});
coreEl.addEventListener("change", function(){ schedulePreview(false); });
dmodeEl.addEventListener("change", function(){ cfg.dither = dmodeEl.value; refreshDefMarks(); saveCfg(); schedulePreview(false); paintChips("dmode","dmodeRow"); });
spaceEl.addEventListener("change", function(){ cfg.space = spaceEl.value; refreshDefMarks(); saveCfg(); schedulePreview(false); paintChips("space","spaceRow"); });
/* 下拉框改成胶囊行（外观统一；select 仍是数据源） */
paintChips("dmode","dmodeRow");
paintChips("space","spaceRow");
levelsEl.addEventListener("change", function(){ cfg.autoLevels = levelsEl.checked ? 1 : 0; refreshDefMarks(); saveCfg(); schedulePreview(false); });
document.querySelectorAll("#presets button").forEach(function(b){
  b.addEventListener("click", function(){ applyMode(b.dataset.m); schedulePreview(false); });
});
$("resetAdv").addEventListener("click", function(){
  CTRL.forEach(function(c){ setCtrlVal(c, DEF[c.key]); });
  cfg.dither = DEF.dither;  dmodeEl.value = DEF.dither;
  cfg.space = DEF.space; spaceEl.value = DEF.space;
  paintChips("dmode","dmodeRow"); paintChips("space","spaceRow");
  cfg.autoLevels = DEF.autoLevels; levelsEl.checked = !!DEF.autoLevels;
  applyMode(DEF.mode);
  refreshDefMarks(); saveCfg(); schedulePreview(false);
  msg("已恢复默认参数（" + modeName(DEF.mode) + "）", "ok");
});
