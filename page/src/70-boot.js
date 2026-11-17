/* ══════════════════════════════════════════════════════════════════
   模块 70 · 启动
   ------------------------------------------------------------------
   顺序有讲究：
     1) 先把本地配置灌进 cfg（否则后面读到的都是默认值）
     2) 再应用风格与模式（会触发控件回填与布局）
     3) 再算画布尺寸（依赖布局已展开）
     4) 最后才去拉设备数据（网络是异步的，失败也不能挡住页面可用）
   ══════════════════════════════════════════════════════════════════ */

loadCfg();          /* 边框老字段（frame / pad*）在这里就地迁成 cfg.tpl */
noteInit();         /* R1.4.0 便签面板：loadCfg 之后才有 noteDoc */
applyMode(cfg.mode || DEF.mode);
setMode(cfg.lastMode ? 1 : 0, true);
syncSel();

/* 控件回填 —— 这里只负责「把 cfg 的值放回 DOM」，
   任何计算都由各自的 change 处理器负责。 */
$("tFont").value   = cfg.textFont || 0;
$("tSize").value   = cfg.textSize || 100;
renderFontChips();          /* 字体胶囊跟着当前字体走 */
syncSw();                   /* 色点行回显（描边色 / 文字色 / 底色） */

CTRL.forEach(function(c){ setCtrlVal(c, cfg[c.key]); });
$("space").value = cfg.space || DEF.space;
paintChips("dmode","dmodeRow"); paintChips("space","spaceRow");
refreshDefMarks();
syncTplUI();

/* 首帧：先定尺寸，再出一次画面（便签 = 底色；拍立得空态 = 白相纸） */
fitStage();
schedulePreview(false);
paintRanges();          /* 滑块可能刚被 32-style.js 生成，补一次着色 */

/* 文字参数的回显（syncSel 改的是 value，不触发 input 事件） */
["tSize","tRot","tStroke"].forEach(function(id){
  var el = $(id), out = $(id + "V");
  if (el && out) out.textContent = el.value;
});

/* 设备页数据：拿不到就保持「—」，不阻塞创作 */
initNetUI();
refreshInfo();
loadSettings();

