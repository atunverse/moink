/* ══════════════════════════════════════════════════════════════════
   模块 50 · 界面控制层
   ------------------------------------------------------------------
   这一层只做「视图状态」，不碰像素：画布尺寸、底栏、上滑面板、
   二级页签、图槽选中与长按菜单、导出入口。

   与其它模块的边界：
     · 渲染/打包（12/13）由 preview / upload 调用，本层不直接碰像素
     · 裁剪（30）只管 Cropper 实例，本层只负责给它正确尺寸
     · 上传（40）、图库（41）、设置（60）的既有函数本层只调用不重写
   ══════════════════════════════════════════════════════════════════ */

/* ---------- 50.1 视图切换（创作 / 设备） ---------- */
function showView(v){
  var dev = (v === "dev");
  $("vEdit").style.display = dev ? "none" : "";
  $("vDev").classList.toggle("show", dev);
  if (dev){
    $("vDev").scrollTop = 0;
    if (typeof refreshInfo === "function") refreshInfo();
  } else {
    requestAnimationFrame(fitStage);
  }
}

/* ---------- 50.2 画布尺寸 ----------
   编辑空间恒为 EW×EH（552×768 竖屏），按可用区等比 contain。
   相纸、裁剪容器、文字手柄层共用同一尺寸，三者才不会错位。 */
/* ---------- 50.2 滑块进度着色 ----------
   CSS 靠 --p 画「已选橙色 / 未选浅灰」，原生 accent-color 在安卓上轨道偏黑。
   不监听 change 而监听 input：拖动过程中就要跟着走。 */
function paintRange(el){
  var mn = parseFloat(el.min);
  var mx = (el.max === "" || el.max == null) ? 100 : parseFloat(el.max);
  if (!isFinite(mn)) mn = 0;
  if (!isFinite(mx) || mx <= mn) mx = mn + 100;
  var p = (+el.value - mn) / (mx - mn) * 100;
  el.style.setProperty("--p", Math.max(0, Math.min(100, p)).toFixed(2) + "%");
}
function paintRanges(){
  var l = document.querySelectorAll('input[type="range"]');
  for (var i = 0; i < l.length; i++) paintRange(l[i]);
}

/* 下拉框 → 胶囊行：选项摆在明面上点一下就换，样式和字体行一致。
   select 不删，仍当唯一数据源 —— change 处理器、存档、门禁断言都不用改。 */
function paintChips(selId, rowId){
  var sel = $(selId), row = $(rowId);
  if (!sel || !row) return;
  while (row.firstChild) row.removeChild(row.firstChild);
  for (var i = 0; i < sel.options.length; i++){
    (function(o){
      var s = document.createElement("span");
      s.textContent = o.textContent;
      if (o.value === sel.value) s.className = "on";
      s.addEventListener("click", function(){
        sel.value = o.value;
        sel.dispatchEvent(new Event("change"));   /* 走原来的 change 逻辑，不复制一份 */
      });
      row.appendChild(s);
    })(sel.options[i]);
  }
}

/* ---------- 50.2b 画布显示：缩放 / 平移 ----------
   只改「怎么看」，不改像素、不改几何：
     · 双指捏合 = 缩放（0.6×～4×），围绕两指中点，松手不回弹
     · 单指在相纸上拖动 = 平移（点在文字 / 贴纸对象上是拖那个对象）
     · 双击相纸 = 复位到 1:1 居中
   为什么用 transform：canvas 的位图尺寸恒为 552×768，缩放只是显示放大，
   导出的成片和上传的帧一个像素都不受影响。 */
var stageView = { z:1, x:0, y:0 };
function applyStageView(){
  var w = $("prevWrap");
  if (!w) return;
  w.style.transform = "translate(-50%,-50%) translate(" +
    Math.round(stageView.x) + "px," + Math.round(stageView.y) + "px) scale(" +
    stageView.z.toFixed(3) + ")";
}
function resetStageView(){
  stageView.z = 1; stageView.x = 0; stageView.y = 0;
  applyStageView();
}
/* 以屏幕点 (px,py) 为不动点缩放 k 倍 */
function zoomStageAt(px, py, k){
  var st = $("stage");
  if (!st) return;
  var z = clamp(stageView.z * k, 0.6, 4);
  k = z / stageView.z;
  if (Math.abs(k - 1) < 0.0001) return;
  var r = st.getBoundingClientRect();
  var cx = r.left + r.width / 2 + stageView.x;
  var cy = r.top + r.height / 2 + stageView.y;
  stageView.x += (px - cx) * (1 - k);
  stageView.y += (py - cy) * (1 - k);
  stageView.z = z;
  applyStageView();
}

/* 画布可用的「基准」高度：视口 - 品牌行 - 底栏 - 面板最高能占的 38%。
   ★ 为什么不用 stage.clientHeight：面板一打开就把 stage 顶小，面板再按内容
   变高变矮，stage 跟着变 —— 画布尺寸就跟着跳（用户点名「跳变」）。
   基准只跟视口尺寸有关，窗口不变它就恒定，画布尺寸和位置也就恒定。 */
function stageBaseH(){
  var ve = $("vEdit");
  var vh = (ve && ve.clientHeight) || window.innerHeight || 0;
  var brand = $("brand") ? $("brand").offsetHeight : 0;
  var dock  = $("dock")  ? $("dock").offsetHeight  : 0;
  if (vh < 200 || !brand){

    var st0 = $("stage");
    return Math.max(150, (st0 ? st0.clientHeight : 600) - 18);
  }
  var base = vh - brand - dock - Math.round(vh * 0.38) - 18;   /* 18 = 上下 padding */
  return Math.max(150, base);
}

function fitStage(){
  var st = $("stage");
  if (!st) return;
  var aw = st.clientWidth  - 20;   /* CSS padding: 左右各 10 */
  var ah = stageBaseH();
  if (aw < 40 || ah < 40) return;
  var k = Math.min(aw / EW, ah / EH);
  var w = Math.max(40, Math.floor(EW * k));
  var h = Math.max(40, Math.floor(EH * k));

  var wrap = $("prevWrap");
  wrap.style.width  = w + "px";
  wrap.style.height = h + "px";
  /* 位置也钉在基准区的中心，面板高矮变化不会让画布上下漂 */
  wrap.style.top = Math.round(8 + ah / 2) + "px";

  /* 构图工作区 = 整张相纸（R1.4.0：留白改成叠加蒙版，不再缩这块区域，
     所以取景框恒为相纸比例，切特效不会把框弄小）。它是 #prevWrap 的子元素，
     位置直接用「相纸逻辑单位 × 当前缩放」，不用再算 stage 的居中偏移。
     构图状态存的是原图像素，这里只是换个显示尺寸，取景框不会因此漂。 */
  var r0 = contentRect();
  var cs = $("cropStage");
  cs.style.left   = Math.round(r0.x * k) + "px";
  cs.style.top    = Math.round(r0.y * k) + "px";
  cs.style.width  = Math.round(r0.w * k) + "px";
  cs.style.height = Math.round(r0.h * k) + "px";

  layoutCrop();                /* 照片与取景框按新尺寸重排（构图本身不变） */
  layoutPadMask();             /* 留白蒙版跟着相纸尺寸重排 */
  applyStageView();            /* 缩放 / 平移是显示层，先摆好再排对象 */
  layoutObjs();
}

/* 画面来源：show = 预览画布，crop = Cropper 工作区 */
function setStageView(v){
  var st = $("stage");
  if (st.dataset.view === v) return;
  st.dataset.view = v;
  /* 只切视图，尺寸交给 fitStage。切视图时不需要重算几何：
     构图状态是原图像素，跟显示尺寸无关。 */
}

/* ---------- 50.3 底栏与上滑面板 ---------- */
var curTool = "";
/* R1.4.0：底栏两组工具按 MODE 互斥显示，save 是共用的第四格。
   data-mode 缺省（save）= 两种模式都在。 */
var TOOL_MODE = { compose:0, color:0, fx:0, ncontent:1, nlayout:1, ntheme:1 };
function dockVisible(b){
  var m = b.dataset.mode;
  return (m == null || m === "") ? true : (+m === MODE);
}

function paintDock(t){
  var btns = document.querySelectorAll("#dock .dk");
  for (var i = 0; i < btns.length; i++){
    var b = btns[i], on = (b.dataset.tool === t);
    /* 隐藏的一组把高亮清掉：切模式回来时不会闪一下上一模式的高亮 */
    if (!dockVisible(b)){ b.classList.remove("on"); b.classList.remove("open"); continue; }
    if (b.dataset.tool === "save") b.classList.toggle("open", on);
    else b.classList.toggle("on", on);
  }
}

function openTool(t){
  var sh = $("sheet");
  curTool = t;
  sh.dataset.panel = t;
  sh.classList.add("up");
  paintDock(t);
  showLvl(t);             /* 先把二 / 三级选项条搭好，再量画布 */

  /* 构图 = 真的在裁剪；其余面板都给最终画面（实时预览） */
  if (t === "compose" && MODE === 0 && img) setStageView("crop");
  else setStageView("show");

  if (t === "save") refreshGallery();
  /* 同步算：class 刚改完，读 clientHeight 会强制重排，拿到的一定是最终高度。
     用 rAF 会踩「没有新帧就不回调」的坑，画布会停在面板展开时的小尺寸。 */
  fitStage();
}

function closeSheet(){
  curTool = "";
  $("sheet").classList.remove("up");
  paintDock("");
  setStageView("show");
  /* 收起面板 = 结束编辑：顺手取消文字选中，否则相纸上一直挂着一圈手柄
     （模板落款尤其明显：面板一关字还在那儿「被选中」）。 */
  if (selIdx >= 0){ selIdx = -1; syncSel(); layoutObjs(); }
  fitStage();
}

function tapTool(t){
  if (curTool === t) closeSheet();
  else openTool(t);
}

/* ---------- 50.4 二级 / 三级选项 ----------
   DOM 本身就是数据结构：.pane > .grp[data-l2] > .box[data-l3]。
   这里只做三件事：把当前工具的 .grp 摊成下一行、.box 摊成上一行、
   把选中项之外的 .box 全部收起。加参数 = 往 HTML 里加一个 .box，不改逻辑。

   为什么不做「一屏铺满」：参数摊平以后光调色就 15 行，画布被挤成一条缝，
   而改动某一项时其余十几项一个都用不上 —— 分层后永远只占两行。 */
var lvlMem = {};        /* tool → { l2, l3 }：每个工具各自记住上次停在哪 */
var lvlAct = {};        /* 三级选项里「点一下就执行」的动作（其余是露出控件） */

function paneOfTool(t){
  var list = document.querySelectorAll("#sheet .pane");
  for (var i = 0; i < list.length; i++)
    if (list[i].dataset.pane === t) return list[i];
  return null;
}

/* 三级选项按当前便签版式过滤：data-only="x" 只在 x 版式出现，
   data-skip="x" 在 x 版式收起。没有这两个属性的盒子完全不受影响。 */
function boxUsable(el){
  var d = el.dataset || {};
  if (!d.only && !d.skip) return true;
  var lay = (typeof noteDoc === "function") ? noteDoc().layout : "";
  return (!d.only || d.only === lay) && (!d.skip || d.skip !== lay);
}

/* 摊平 .pane 的直接子节点：只有带 data-l2 的 .grp 才算一组 */
function lvlGroups(pane){
  var out = [], kids = pane.children;
  for (var i = 0; i < kids.length; i++){
    var g = kids[i];
    if (!g.dataset || g.dataset.l2 == null) continue;
    var items = [], kk = g.children;
    for (var j = 0; j < kk.length; j++){
      if (kk[j].classList && kk[j].classList.contains("box")){
        /* 不适用的一项连 .on 一起清掉，切版式回来时不会露出旧控件 */
        if (!boxUsable(kk[j])) kk[j].classList.remove("on");
        else items.push({ el: kk[j], name: kk[j].dataset.l3 || g.dataset.l2 });
      }
    }
    if (items.length) out.push({ name: g.dataset.l2, items: items });
  }
  return out;
}

function lvlRow(bar, names, sel, pick){
  while (bar.firstChild) bar.removeChild(bar.firstChild);
  bar.classList.toggle("hid", !names.length);
  for (var i = 0; i < names.length; i++){
    var b = document.createElement("b");
    b.textContent = names[i];
    if (i === sel) b.className = "on";
    (function(k, node){
      node.addEventListener("click", function(){ pick(k); });
    })(i, b);
    bar.appendChild(b);
  }
}

function lvlHide(){
  /* 连内容一起清掉：只加 .hid 的话旧页的胶囊还留在 DOM 里，
     一旦有脚本按节点点回去，会把别的面板又"点"出来。 */
  ["l2bar", "l3bar"].forEach(function(id){
    var bar = $(id);
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    bar.classList.add("hid");
  });
}

function showLvl(t){
  var pane = paneOfTool(t);
  var gs = pane ? lvlGroups(pane) : [];
  if (!gs.length){ lvlHide(); return; }        /* 保存页没有分组：两条都收起 */

  var mem = lvlMem[t] || (lvlMem[t] = { l2: 0, l3: 0 });
  /* 索引一律夹到合法范围：mem 是跨面板共享的，任何一处写坏都会让
     g.items[mem.l3] 变成 undefined（后面读 .dataset 就整个面板崩掉）。 */
  if (typeof mem.l2 !== "number" || mem.l2 < 0 || mem.l2 >= gs.length) mem.l2 = 0;
  var g = gs[mem.l2];
  /* 模板组的三级项就是模板本身，选中项必须等于当前 cfg.tpl，
     否则换了模板，这里还显示上一次点的那一项。 */
  if (t === "fx" && g.name === "模板") mem.l3 = Math.max(0, TPL_ORDER.indexOf(tplNow()));
  if (typeof mem.l3 !== "number" || mem.l3 < 0 || mem.l3 >= g.items.length) mem.l3 = 0;

  for (var i = 0; i < gs.length; i++)
    for (var j = 0; j < gs[i].items.length; j++){
      var on = (i === mem.l2 && j === mem.l3);
      gs[i].items[j].el.classList.toggle("on", on);
      /* 面板高度是固定的，控件少的页会留一大片空白 —— 只让「当前这一组」
         撑满剩余高度，内容在中间垂直居中（.grp.cur 见 CSS） */
      if (gs[i].items[j].el.parentNode)
        gs[i].items[j].el.parentNode.classList.toggle("cur", i === mem.l2);
    }

  lvlRow($("l2bar"), gs.map(function(x){ return x.name; }), mem.l2, function(k){
    if (k === mem.l2) return;
    mem.l2 = k; mem.l3 = 0;
    showLvl(t);
  });
  /* 只有一个三级项就不摆选项行 —— 一行一个胶囊除了占地方没有别的作用 */
  var l3names = (g.items.length > 1) ? g.items.map(function(x){ return x.name; }) : [];
  lvlRow($("l3bar"), l3names, mem.l3, function(k){
    mem.l3 = k;
    var box = g.items[k].el;
    showLvl(t);
    var act = box.dataset.act;                 /* 动作类选项（铺满 / 90° / 模板…） */
    if (act && lvlAct[act]) lvlAct[act]();
    /* 点「日期 → 自定义」：把输入框填成当前显示串并聚焦，点进来就能直接改 */
    if (g.name === "日期" && box.dataset.l3 === "自定义"
        && typeof enterDateCustom === "function") enterDateCustom(true);
  });

  /* 停在这一页（含从别处切回来）时也要保证输入框跟着当前对象，但不抢焦点 */
  /* g.items[] 的元素是 {el, name}，盒子本身在 .el 上 */
  var curBox = (g.items[mem.l3] || {}).el;
  if (t === "fx" && g.name === "日期" && curBox && curBox.dataset.l3 === "自定义"
      && typeof enterDateCustom === "function") enterDateCustom(false);

  $("l2bar").dataset.tool = t;
  var panes = document.querySelector("#sheet .panes");
  if (panes) panes.scrollTop = 0;
  paintRanges();
  fitStage();
}

/* ---------- 50.4b 点画面上的对象 → 直接进它自己的面板 ----------
   要改一段字的描边，先点「特效 → 文字 → 描边」三下太绕；
   所以画布上点谁，面板就切到对应的二级 / 三级选项，一次点到。 */
function gotoLvl(t, grp, l3){
  var pane = paneOfTool(t);
  if (!pane) return false;
  var gs = lvlGroups(pane), gi = -1, li = -1, i, j;
  for (i = 0; i < gs.length; i++) if (gs[i].name === grp) gi = i;
  if (gi < 0) return false;
  for (j = 0; j < gs[gi].items.length; j++) if (gs[gi].items[j].name === l3) li = j;
  var mem = lvlMem[t] || (lvlMem[t] = { l2:0, l3:0 });
  mem.l2 = gi;
  mem.l3 = (li < 0) ? 0 : li;
  if (curTool === t) showLvl(t);
  else openTool(t);
  return true;
}
function focusObj(i){
  var o = curObjs()[i];
  if (!o) return;
  selIdx = i;
  layoutObjs(); syncSel();
  if (o.type === "date"){
    gotoLvl("fx", "日期", "日期");      /* 日期已经是一个独立的二级菜单 */
  } else if (isStk(o)){
    var k = (o.kind === "emoji") ? "表情" : ((o.kind === "img" || o.src) ? "上传图片" : "图标");
    gotoLvl("fx", "贴纸", k);
  } else {
    gotoLvl("fx", "文字", "文字");
  }
}

/* ---------- 50.5 图槽：选中 + 长按菜单 ----------
   为什么不做「点一下就上屏」：拇指滑过的误触代价太高（画面被换掉你未必发现）。
   单击只选中，长按才出菜单 —— 与编辑类 App 的通用肌肉记忆一致。 */
var selSlot = -1;
function selectSlot(slot){
  selSlot = slot;
  var cells = $("galGrid").querySelectorAll(".galCell");
  for (var i = 0; i < cells.length; i++)
    cells[i].classList.toggle("sel", +cells[i].dataset.slot === slot);
}

var galPress = null;
function cancelPress(){
  if (galPress){ clearTimeout(galPress.timer); galPress = null; }
}
(function bindGalleryPress(){
  var grid = $("galGrid");
  if (!grid) return;
  grid.addEventListener("pointerdown", function(ev){
    if (caroBusy) return;
    var cell = ev.target.closest ? ev.target.closest(".galCell") : null;
    if (!cell) return;
    var slot = +cell.dataset.slot;
    selectSlot(slot);
    galPress = {
      slot: slot, x: ev.clientX, y: ev.clientY,
      timer: setTimeout(function(){
        galPress = null;
        openCtx(slot);
      }, 500)
    };
  });
  /* 只拦图槽的系统长按菜单，不全局拦（否则输入框选词会失效） */
  grid.addEventListener("contextmenu", function(ev){ ev.preventDefault(); });
  document.addEventListener("pointermove", function(ev){
    if (!galPress) return;
    var dx = ev.clientX - galPress.x, dy = ev.clientY - galPress.y;
    if (dx*dx + dy*dy > 100) cancelPress();     /* 移动超 10px = 在滑动，不是长按 */
  }, { passive: true });
  document.addEventListener("pointerup", cancelPress);
  document.addEventListener("pointercancel", cancelPress);
})();

var ctxSlot = -1;
function openCtx(slot){
  if (caroBusy) return;
  ctxSlot = slot;
  $("ctxTitle").textContent = "第 " + (slot + 1) + " 张图片";
  $("ctxMenu").classList.add("show");
}
function closeCtx(){
  $("ctxMenu").classList.remove("show");
  ctxSlot = -1;
}

/* 从菜单直接上屏：不经过大图预览，省一次 40KB 拉取 */
function showSlotNow(slot){
  closeCtx();
  msg("正在切换屏幕…", "");
  caroLock(true, "正在切换…");
  fetch(api("/api/carousel/show?slot=" + slot), { method: "POST" })
    .then(function(r){
      return r.text().then(function(t){
        return { ok: r.status === 200, status: r.status, body: t };
      });
    })
    .then(function(x){
      if (x.ok){
        msg("屏幕上正在切换（约 2~5 秒，成功会自动更新勾选）", "ok");
        waitSlotShown(slot);
      } else if (x.status === 503){
        msg("设备正忙，请稍后重试", "err");
      } else {
        msg("显示失败：HTTP " + x.status, "err");
      }
    })
    .catch(function(){ msg("网络错误（可能已生效，请看屏幕）", "err"); })
    .then(function(){ caroLock(false); });
}

/* ---------- 50.6 存到远程（保存面板与设备页共用同一段逻辑） ---------- */
function pushRemote(say){
  if (LOCAL_PREVIEW){ say("warn", "本地预览：请连设备后再用"); return; }
  if (MODE === 0 && !img){ say("err", "请先选择图片"); return; }
  if (MODE === 0 && !previewOK){ say("err", "预览还没生成好，稍等"); return; }
  var body;
  try { body = frameWithHeader(packFull()); }
  catch(e){ say("err", "合成失败：" + e.message); return; }

  say("busy", "正在上传到远程…（约 5~60 秒）");
  var xhr = new XMLHttpRequest();
  xhr.open("POST", api("/api/frame?save=remote"));
  xhr.timeout = 90000;
  xhr.onload = function(){
    if (xhr.status === 200) say("ok", "已存到远程，清单已追加");
    else say("err", xhr.responseText || ("HTTP " + xhr.status));
    loadRemote();
  };
  xhr.onerror   = function(){ say("err", "网络错误：请确认已连设备热点"); };
  xhr.ontimeout = function(){ say("warn", "超时：远程可能已写入，点「探测清单」核对"); };
  xhr.send(body);
}

/* ---------- 50.7 导出到手机 ----------
   用完整分辨率（EW×EH）重绘一份，不复用可能只有一半分辨率的快速预览。 */
function exportPng(){
  if (MODE === 0 && !img){ msg("请先选择图片", "err"); return; }
  if (MODE === 0 && !previewOK){ msg("预览还没生成好，稍等", "err"); return; }
  showWorkLoading("正在生成图片…");
  afterLoadingPaint(function(){
    try {
      var cv = document.createElement("canvas");
      renderTo(cv, EW, EH);
      cv.toBlob(function(b){
        hideWorkLoading();
        if (!b){ msg("导出失败，请重试", "err"); return; }
        var url = URL.createObjectURL(b);
        var a = document.createElement("a");
        a.href = url;
        a.download = "moink-" + (MODE === 0 ? "photo" : "note") + "-" +
                     new Date().toISOString().slice(0, 19).replace(/[:T]/g, "") + ".png";
        document.body.appendChild(a);
        a.click();
        setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 5000);
        msg("已导出 PNG 到手机", "ok");
      }, "image/png");
    } catch(e){
      hideWorkLoading();
      msg("导出失败：" + e.message, "err");
    }
  });
}

/* ---------- 50.8 呈现模式（拍立得 / 便签） ---------- */
/* 只负责「哪些控件该出现」，像素侧由 drawBase 按 MODE 分流。 */
function setMode(m, silent){
  var next = (+m === 1) ? 1 : 0;
  var changed = (next !== MODE);
  if (changed){
    selByMode[MODE] = selIdx;
    selIdx = selByMode[next];
  }
  MODE = next;
  if (!curObjs()[selIdx]){
    selIdx = -1;
    if (changed) txtEl.value = "";
  }
  document.querySelectorAll("#modes .mode").forEach(function(b){
    b.classList.toggle("on", +b.dataset.m === MODE);
  });

  var photo = (MODE === 0);
  /* 便签没有图，也就没有裁剪 */
  if (photo) initCrop(); else destroyCrop();

  $("objBgRow").style.display   = photo ? "" : "none";

  /* 空相纸提示只对拍立得有意义；便签直接是纯色底 */
  $("stage").classList.toggle("empty", photo && !img);

  /* 底栏按模式换一组工具；当前展开的面板若属于另一模式，先收起，
     免得「模式切了、面板还停在旧工具上」。 */
  if (curTool && TOOL_MODE[curTool] !== undefined && TOOL_MODE[curTool] !== MODE) closeSheet();
  document.querySelectorAll("#dock .dk").forEach(function(b){
    b.style.display = dockVisible(b) ? "" : "none";
  });
  if (!photo && typeof noteSyncUI === "function") noteSyncUI();

  refreshTextUI();
  syncSel();
  goEl.disabled = photo ? !img : false;
  goOnlyEl.disabled = goEl.disabled;

  cfg.lastMode = MODE;
  saveCfg();
  if (!silent) schedulePreview(false);
}

/* ---------- 50.8b 模板选项同步 ----------
   模板只存一个 cfg.tpl（缺省 none），绘制在 34-tpl.js 的 drawTpl。
   这里负责让「模板」那一排胶囊跟上当前值。 */
function syncTplUI(){
  var pane = paneOfTool("fx");
  var gs = pane ? lvlGroups(pane) : [];
  var gi = -1, i;
  for (i = 0; i < gs.length; i++) if (gs[i].name === "模板") gi = i;
  var mem = lvlMem.fx;
  if (mem && gi >= 0 && mem.l2 === gi && curTool === "fx"){
    mem.l3 = Math.max(0, TPL_ORDER.indexOf(tplNow()));
    showLvl("fx");
  }
}

/* ---------- 50.9 一次性接线 ---------- */
(function wireUI(){
  /* 底栏 */
  document.querySelectorAll("#dock .dk").forEach(function(b){
    b.addEventListener("click", function(){ tapTool(b.dataset.tool); });
  });
  /* 抓手下滑收起（R1.4.0-5）：面板跟着手指变矮，松手后按位移判「收起」还是「弹回」。
     原实现只在位移超过 28px 时直接 closeSheet()，但抓手只有 4px 高且没写
     touch-action:none —— 手指一动就被浏览器判成页面滚动，pointercancel 先到，
     于是拖拽条看起来「完全没反应」。 */
  (function(){
    var sheet = $("sheet"), grip = $("grip");
    var y0 = 0, dy = 0, h = 0, dragging = false;

    function snap(px){                       /* 直接把面板压到指定高度 */
      sheet.style.maxHeight = px + "px";
    }
    grip.addEventListener("pointerdown", function(e){
      if (!sheet.classList.contains("up")) return;
      dragging = true; y0 = e.clientY; dy = 0;
      /* 拖动期间关掉过渡，面板才跟得上手指 */
      sheet.style.transition = "none";
      /* 展开动画还没跑完时 offsetHeight 只是中间值（实测能读到 143 / 真实 400+）。
         先放手让 CSS 上限立刻生效，再量——这样「刚打开就往下拖」也不会判错基准。 */
      sheet.style.maxHeight = "";
      h = sheet.offsetHeight || 0;
      if (h < 80) h = sheet.scrollHeight || 400;
      try { grip.setPointerCapture(e.pointerId); } catch(err){}
    });
    grip.addEventListener("pointermove", function(e){
      if (!dragging) return;
      dy = Math.max(0, e.clientY - y0);
      snap(Math.max(48, h - dy));            /* 留 48px，别收到「看不见一条缝」 */
      if (e.cancelable) e.preventDefault();
    });
    function finish(){
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = "";
      var close = dy > Math.max(56, h / 3);
      dy = 0;
      snap(close ? 0 : h);          /* px→px 才能过渡 */
      /* 过渡结束再把 inline 高度交还给 CSS（定时器兜底：没有过渡事件时也要收尾）。
         收起那条必须等过渡走完再摘 class，否则 inline 高度会把收起动画挡住。 */
      var settled = false;
      function done(){
        if (settled) return;
        settled = true;
        sheet.removeEventListener("transitionend", onEnd);
        sheet.style.maxHeight = "";
        if (close && sheet.classList.contains("up")) closeSheet();
      }
      function onEnd(ev){
        if (ev.target === sheet && ev.propertyName === "max-height") done();
      }
      sheet.addEventListener("transitionend", onEnd);
      setTimeout(done, 420);
    }
    grip.addEventListener("pointerup", finish);
    grip.addEventListener("pointercancel", finish);
  })();

  /* 视图切换 */
  $("gearBtn").addEventListener("click", function(){ showView("dev"); });
  $("backBtn").addEventListener("click", function(){ showView("edit"); });

  /* 模式切换 */
  document.querySelectorAll("#modes .mode").forEach(function(b){
    b.addEventListener("click", function(){ setMode(+b.dataset.m); });
  });

  /* 空相纸点一下 = 选图；有图后点画面 = 进构图 */
  $("emptyCue").addEventListener("click", function(){ fileEl.click(); });
  $("prevWrap").addEventListener("click", function(ev){
    var t = ev.target;
    /* 点在对象上 = 进它自己的面板（文字 → 文字编辑，贴纸 → 图标 / 表情 / 上传图片） */
    var el = t.closest ? t.closest(".tobj") : null;
    if (el){
      if (objTapMoved){ objTapMoved = false; return; }        /* 刚才是拖动，不是点选 */
      if (t.dataset && t.dataset.a === "del") return;         /* 删除柄不进面板 */
      focusObj(Array.prototype.indexOf.call(objLayerEl.children, el));
      return;
    }
    if (MODE !== 0 || !img) return;
    /* 面板已经开着时，点画面只是「看」—— 以前会直接跳到构图，
       在调色 / 特效里手一滑就换工具，还得再点回来。 */
    if (curTool) return;
    openTool("compose");
  });

  /* 三级选项里的动作：点一下就执行，不弹控件。
     铺满 / 居中 / 90° / 模板都属于这一类 —— 它们要的是「做一件事」，不是「调一个值」。 */
  lvlAct = {
    cropMax:    function(){ cropMax(); },
    cropCenter: function(){ cropCenter(); },
    rotL:       function(){ rotateQuarter(-1); },
    rotR:       function(){ rotateQuarter(1); },
    rotZero:    function(){ imgUpright(); },
    tplNone:    function(){ tplApply("none"); },
    tplLine:    function(){ tplApply("line"); },
    tplPolaroid:function(){ tplApply("polaroid"); },
    tplPuzzle:  function(){ tplApply("puzzle"); },
    tplTicket:  function(){ tplApply("ticket"); },
    tplFilm:    function(){ tplApply("film"); }
  };

  /* 保存面板的出口 */
  $("goRemote").addEventListener("click", function(){
    pushRemote(function(kind, text){
      msg(text, kind === "ok" ? "ok" : (kind === "err" ? "err" : ""));
    });
  });
  $("goExport").addEventListener("click", exportPng);
  $("galRefresh").addEventListener("click", function(){
    selectSlot(-1);
    refreshGallery();
  });

  /* 长按菜单 */
  $("ctxView").addEventListener("click", function(){
    var s = ctxSlot; closeCtx(); if (s >= 0) showPreview(s);
  });
  $("ctxShow").addEventListener("click", function(){
    var s = ctxSlot; if (s >= 0) showSlotNow(s); else closeCtx();
  });
  $("ctxDel").addEventListener("click", function(){
    var s = ctxSlot; closeCtx(); if (s >= 0) deleteSlot(s);
  });
  $("ctxCancel").addEventListener("click", closeCtx);
  $("ctxMenu").addEventListener("click", function(ev){
    if (ev.target === this) closeCtx();      /* 点遮罩 = 取消 */
  });

  /* 文字面板的数值回显（原来没有，滑完看不到值） */
  [["tSize","tSizeV"],["tRot","tRotV"],["tStroke","tStrokeV"]].forEach(function(p){
    var src = $(p[0]), out = $(p[1]);
    if (!src || !out) return;
    var sync = function(){ out.textContent = src.value; };
    src.addEventListener("input", sync);
    sync();
  });

  /* 视口变化：尺寸变了就重算；旋转屏后 Cropper 也要重算 */
  var ro = 0;
  function relayout(){
    cancelAnimationFrame(ro);
    ro = requestAnimationFrame(fitStage);
  }
  window.addEventListener("resize", relayout);
  window.addEventListener("orientationchange", function(){ setTimeout(relayout, 220); });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", relayout);

  /* 面板展开/收起会改变画布高度（不是窗口 resize），必须单独监听，
     否则相纸尺寸不变、Cropper 手柄会错位。 */
  if (window.ResizeObserver){
    new ResizeObserver(relayout).observe($("stage"));
  }

  /* 面板的高度有 260ms 过渡，ResizeObserver 会在中间值上触发好几次。
     过渡结束再校一次，保证相纸尺寸与构图容器都落在最终布局上。 */
  $("sheet").addEventListener("transitionend", function(ev){
    if (ev.propertyName === "max-height") fitStage();
  });

  /* 任何滑块一动就刷新进度着色（滑块有静态的，也有 32-style.js 动态生成的） */
  document.addEventListener("input", function(ev){
    var t = ev.target;
    if (t && t.type === "range") paintRange(t);
  }, true);
})();

/* ---------- 50.9 画布手势（缩放 / 平移 / 双击复位） ----------
   只挂在 #stage 上，而且**点在 .tobj 上时不抢**：那是拖文字 / 拖贴纸。
   第二指落下就进入捏合，同时把已经开始的对象拖动撤掉（否则手指在缩放、
   对象还在跟着跑）。 */
(function bindStageGestures(){
  var st = $("stage");
  if (!st) return;
  var pts = {}, pan = null, pinch = null, lastTap = 0, downX = 0, downY = 0, moved = false;

  function setPt(id, x, y){ pts[id] = { x:x, y:y }; }
  function two(){
    var a = [], k;
    for (k in pts) a.push(pts[k]);
    return a.length >= 2 ? [a[0], a[1]] : null;
  }
  function dist(p, q){ return Math.hypot(p.x - q.x, p.y - q.y); }
  function mid(p, q){ return { x:(p.x + q.x) / 2, y:(p.y + q.y) / 2 }; }

  /* 第二指落下时，正在进行的对象拖动要撤回原位 —— 不撤的话对象会跟着
     第一根手指跑到别处，看起来像「缩放把字甩飞了」 */
  function cancelObjDrag(){
    if (typeof od === "undefined" || !od) return;
    var o = curObjs()[od.i];
    if (o){ o.x = od.x0; o.y = od.y0; }
    od = null;
    try { objEditing = false; } catch(e){}
    layoutObjs();
  }

  st.addEventListener("pointerdown", function(e){
    /* 构图（裁剪）视图整个让给取景框：拖动 / 四角改大小都在那里，
       画布手势一接管，取景框就跟着手指跑 */
    if (st.dataset.view === "crop") return;
    var onObj = e.target.closest ? e.target.closest(".tobj") : null;
    setPt(e.pointerId, e.clientX, e.clientY);
    moved = false; downX = e.clientX; downY = e.clientY;
    var t = two();
    if (t && dist(t[0], t[1]) > 20){
      cancelObjDrag();
      pan = null;
      pinch = { d0:dist(t[0], t[1]), z0:stageView.z };
    } else if (!onObj && !pinch){
      pan = { id:e.pointerId, sx:e.clientX, sy:e.clientY,
              x:stageView.x, y:stageView.y };
    }
  });

  st.addEventListener("pointermove", function(e){
    if (!pts[e.pointerId]) return;
    setPt(e.pointerId, e.clientX, e.clientY);
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 6) moved = true;

    if (pinch){
      var t = two();
      if (!t) return;
      var d = dist(t[0], t[1]);
      if (d < 20) return;
      var m = mid(t[0], t[1]);
      var k = d / pinch.d0;
      var z = clamp(pinch.z0 * k, 0.6, 4);
      zoomStageAt(m.x, m.y, z / stageView.z);
      e.preventDefault();
      return;
    }
    if (pan && e.pointerId === pan.id){
      stageView.x = pan.x + (e.clientX - pan.sx);
      stageView.y = pan.y + (e.clientY - pan.sy);
      applyStageView();
      if (moved) e.preventDefault();
    }
  }, { passive:false });

  function up(e){
    delete pts[e.pointerId];
    var t = two();
    if (pinch && !t){
      /* 松手时还剩一根手指：把它当新的平移起点，画面不会突然跳 */
      pinch = null;
      pan = t ? null : null;
      if (t) pan = { id:0, sx:t[0].x, sy:t[0].y, x:stageView.x, y:stageView.y };
    }
    if (pan && e.pointerId === pan.id) pan = null;
    if (!moved && Date.now() - lastTap < 320){
      lastTap = 0;
      resetStageView();
    } else if (!moved){
      lastTap = Date.now();
    }
  }
  st.addEventListener("pointerup", up);
  st.addEventListener("pointercancel", up);

  /* 桌面调试用：滚轮缩放（触屏没有滚轮，不影响） */
  st.addEventListener("wheel", function(e){
    if (!e.deltaY) return;
    e.preventDefault();
    zoomStageAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive:false });
})();
