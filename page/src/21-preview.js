/* ==================================================================
   21-preview.js —— 预览调度（fast / full 两档）
   ================================================================== */
/* ---------- 预览 ---------- */
function preview(){
  if (previewBusy || !previewWant) return;
  if (MODE === 0 && !img){ previewWant = null; return; }
  previewBusy = true;
  runPreview();
}
function runPreview(){
  if (!previewWant){
    previewBusy = false;
    return;
  }
  var fast = (previewWant === "fast");
  previewWant = null;
  try {
    var div = fast ? 2 : 1;
    renderTo(prevEl, Math.round(EW/div), Math.round(EH/div));
    statHintEl.textContent = fast ? "正在生成预览…" : "";
    previewOK = true;
    goEl.disabled = (MODE === 0) ? (!img || !previewOK) : false;
    goOnlyEl.disabled = goEl.disabled;
    if (!fast) msg("预览就绪", "", 2200);
  } catch (e){
    previewOK = false;
    statHintEl.textContent = "预览失败：" + e.message;
    if (MODE === 0) goEl.disabled = true;
    goOnlyEl.disabled = goEl.disabled;
    if (!fast) msg("预览失败：" + e.message + "，请重试", "err");
  }
  previewBusy = false;
  if (previewWant){ preview(); return; }
  if (fast){
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function(){ previewWant = "full"; preview(); }, 320);
  }
}
function schedulePreview(fast){
  clearTimeout(previewTimer);
  if (fast){ previewWant = "fast"; preview(); return; }
  previewWant = "full";
  previewTimer = setTimeout(preview, 130);
}
