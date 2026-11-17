/* ==================================================================
   20-state.js —— DOM 句柄 / 配置持久化 / 载入迁移
   ================================================================== */
/* ---------- DOM 句柄 ----------
   这一行之后才开始碰 DOM；上面的 10~13 是纯函数段（smoke 会单独抽出来跑）。 */
var $ = function(id){ return document.getElementById(id); };
/* 禁止 Safari 放大整页；裁剪区的图片缩放仍由 Cropper 处理。 */
function stopViewportGesture(e){ e.preventDefault(); }
document.addEventListener("gesturestart", stopViewportGesture, { passive:false });
document.addEventListener("gesturechange", stopViewportGesture, { passive:false });
var fileEl = $("file"), coreEl = $("core"), dmodeEl = $("dmode");
var levelsEl = $("levels"), spaceEl = $("space");
var cropImgEl = $("cropImg"), objLayerEl = $("objLayer"), prevWrapEl = $("prevWrap");
var prevEl = $("prev"), goEl = $("go"), goOnlyEl = $("goOnly"), msgEl = $("msg");
var barEl = $("bar"), fillEl = $("fill"), statHintEl = $("stathint");
var txtEl = $("txt");
var workLoadingEl = $("workLoading"), workLoadingTextEl = $("workLoadingText");

function showWorkLoading(text){
  workLoadingTextEl.textContent = text || "正在处理…";
  workLoadingEl.classList.add("show");
  document.body.classList.add("workLocked");
  workLoadingEl.setAttribute("aria-hidden", "false");
}
function updateWorkLoading(text){ workLoadingTextEl.textContent = text; }
function hideWorkLoading(){
  workLoadingEl.classList.remove("show");
  document.body.classList.remove("workLocked");
  workLoadingEl.setAttribute("aria-hidden", "true");
}
/* 同步 Canvas 计算会占满主线程；跨过两个动画帧，确保 loading 已经真正绘制到屏幕。 */
function afterLoadingPaint(fn){
  requestAnimationFrame(function(){ requestAnimationFrame(fn); });
}

var captivePage = /(?:^|[?&])moink_captive=1(?:&|$)/.test(location.search);

var cfg = Object.assign({}, DEF);
var img = null;
var curRot = 0;   /* 取景框角度（-45..45），只转框不转照片 */
var previewTimer = null, previewBusy = false, previewWant = null;
var previewOK = false;   /* 图像管线离线跑通标记：预览成功才允许上传（用户要求：先离线跑通再 OTA） */
/* 裸页面以 file:// 打开（未注入 MOINK_BASE）= 纯本地预览：
   渲染/裁剪可用，但 API 全部不可达——上传类操作给出明确提示而非「net」。 */
var LOCAL_PREVIEW = (location.protocol === "file:" && !BASE);

var _msgTmr = 0;
/* hold > 0 时到点自动清空 —— 成功回执（「预览就绪」）没必要时时压在照片上 */
function msg(s, cls, hold){
  if (_msgTmr){ clearTimeout(_msgTmr); _msgTmr = 0; }
  msgEl.textContent = s; msgEl.className = cls || "";
  var line = document.getElementById("statusLine");
  if (line) line.classList.toggle("hid", !s);
  if (s && hold){
    _msgTmr = setTimeout(function(){
      _msgTmr = 0;
      msgEl.textContent = ""; msgEl.className = "";
      if (line) line.classList.add("hid");
    }, hold);
  }
}

var LS_KEY = "moink.cfg4";
var LS_KEY_OLD = "einkframe.cfg4";
/* FB-005：saveCfg 节流（前沿 + 300ms 拖尾）。滑杆拖动等高频调用不再逐次写
   localStorage，最后一次改动保证落盘；调用点保持原样无需改动。 */
var _saveLast = 0, _saveTmr = null;
function _saveNow(){
  try {
    /* 文字框仅属于当前编辑会话，刷新或重新打开页面时从空白开始。 */
    var stored = Object.assign({}, cfg);
    delete stored.objsImg; delete stored.objsNote; delete stored.text;
    localStorage.setItem(LS_KEY, JSON.stringify(stored));
    _saveLast = Date.now();
  } catch(e){}
}
function saveCfg(){
  if (_saveTmr){ clearTimeout(_saveTmr); _saveTmr = null; }
  var gap = Date.now() - _saveLast;
  if (gap >= 300){ _saveNow(); }
  else { _saveTmr = setTimeout(function(){ _saveTmr = null; _saveNow(); }, 300 - gap); }
}
function normObjs(a){
  if (!Array.isArray(a)) return [];
  return a.map(function(o){
    if (o && o.type === "date")
      return { type:"date",
               /* R1.4.6：手写体已取消，老存档里的 ink 一律落到「普通」 */
               style: (o.style === "ink") ? "txt"
                      : ((typeof DATE_STYLE !== "undefined" && DATE_STYLE[o.style]) ? o.style : "dot"),
               fmt: (typeof DATE_FMT !== "undefined" && DATE_FMT[o.fmt]) ? o.fmt : "ymd",
               text:String(o.text == null ? "" : o.text),
               x:+o.x||0, y:+o.y||0,
               size:clamp(+o.size||60,12,240),
               color:clamp(+o.color|0,0,3),
               rot:clamp(+o.rot||0,-180,180) };
    if (o && o.type === "stk")
      return { type:"stk",
               kind:(o.kind === "img" || o.kind === "emoji") ? o.kind : "glyph",
               ch:String(o.ch||""), src:String(o.src||""),
               color:clamp(+o.color|0,0,3),
               x:+o.x||0, y:+o.y||0,
               w:clamp(+o.w||200,24,2000), h:clamp(+o.h||200,24,2000),
               rot:clamp(+o.rot||0,-180,180) };
    return { type:"text", x:+o.x||0, y:+o.y||0, text:String(o.text==null?"":o.text),
             font:clamp(+o.font|0,0,FONTS.length-1), size:clamp(+o.size||48,16,240),
             color:clamp(+o.color|0,0,3), rot:clamp(+o.rot||0,-180,180),
             stroke:clamp(+o.stroke||0,0,10), strokeC:clamp(+o.strokeC|0,0,3),
             bg:clamp(+o.bg|0,0,4), wrap:+o.wrap||0 };
  });
}
function loadCfg(){
  try {
    var t = localStorage.getItem(LS_KEY) || localStorage.getItem(LS_KEY_OLD);
    if (t) Object.assign(cfg, JSON.parse(t));
  } catch(e){}
  /* 迁移：旧版单条 cfg.text → 单个文字对象（拍立得/便签各一份） */
  if (!Array.isArray(cfg.objsImg) && !Array.isArray(cfg.objsNote) &&
      String(cfg.text||"").replace(/\s+$/, "")){
    var px = clamp(Math.round(45 * clamp(+cfg.textSize, 40, 260) / 100), 16, 240);
    var o = { x:EW/2, y:EH/2, text:cfg.text, font:cfg.textFont|0,
              size:px, color:cfg.textColor|0, rot:0, stroke:0,
              strokeC:(cfg.textColor === C_W) ? 0 : 1, bg:0, wrap:0 };
    cfg.objsImg = [JSON.parse(JSON.stringify(o))];
    cfg.objsNote = [JSON.parse(JSON.stringify(o))];
  }
  cfg.objsImg = normObjs(cfg.objsImg);
  cfg.objsNote = normObjs(cfg.objsNote);
  /* 旧版本曾把文字框写入 localStorage；载入后清掉，避免再次打开仍显示上次内容。 */
  cfg.objsImg = [];
  cfg.objsNote = [];
  cfg.text = "";
  /* R1.0.16 竖屏化一次性迁移：旧横屏坐标(768x552)逆时针映射到竖屏(552x768)，
     保证设备输出不变（rotateCW(新) === 旧）；m16rot 防重入 */
  if (!cfg.m16rot){
    [cfg.objsImg, cfg.objsNote].forEach(function(arr){
      (arr || []).forEach(function(o){
        var nx = clamp(Math.round(+o.y || 0), 0, EW), ny = clamp(Math.round(767 - (+o.x || 0)), 0, EH);
        o.x = nx; o.y = ny;
      });
    });
    cfg.m16rot = 1; saveCfg();
  }
  /* R1.1.0：已存坐标所依据的编辑空间几何（老工程 = 竖屏 552x768）。
     设备信息到达后由 applyPanelGeom() 校正，必要时按比例迁移。 */
  /* R1.4.5：边框参数（cfg.frame / padT..padR）已废，改成一个 cfg.tpl。
     老存档里选过「白边」的按拍立得接上，其余一律无边框。 */
  if (!cfg.tpl){
    cfg.tpl = (+cfg.frame === 1) ? "polaroid" : "none";
  }
  delete cfg.frame; delete cfg.padOn;
  delete cfg.padT; delete cfg.padB; delete cfg.padL; delete cfg.padR;
  /* R1.4.0：便签文档是「要贴在屏上的内容」，和临时文字框不同，跨刷新保留。
     _saveNow 里只 delete objsImg/objsNote/text，noteDoc 会正常落盘。 */
  cfg.noteDoc = noteNorm(cfg.noteDoc);
  GEOM_SRC = { w: (+cfg.geomW || 552), h: (+cfg.geomH || 768) };
  cfg.geomW = GEOM_SRC.w; cfg.geomH = GEOM_SRC.h;
  PANEL.w = GEOM_SRC.h; PANEL.h = GEOM_SRC.w;
  EW = GEOM_SRC.w; EH = GEOM_SRC.h;
  /* R1.0.13 的 m13bg 白底迁移已按用户要求撤销（R1.0.15）：新对象默认透明底，
     已被迁移成白底的旧对象保持不变，可在面板逐对象改回。 */
  curRot = clamp(Math.round(+cfg.cropRot || 0), -45, 45);
}
