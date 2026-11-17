/* ==================================================================
   34-tpl.js —— 「特效 → 模板」：六种边框，全部现场绘制
   ------------------------------------------------------------------
   模板 = 叠加在照片上的蒙版层，不改裁剪、不改取景框几何：
     · rect = 照片**可见区**（相对相纸 552×768），之外一律盖成白/黑
     · art  = 边框绘制函数，Canvas 路径现画，不引任何图片文件
     · 白边宽度固定，不做滑块（自定义白边已取消）
   R1.4.6：细边框只留白边（去黑线）、取消花边、拼图改错位排布、
           票据按参考图重做（上下邮票孔 + 四角 1/4 圆）、胶片转竖版。
   ================================================================== */

/* rect = 照片可见区（相对相纸）。边距按同一物理宽度折算成百分比，
   所以横竖的百分比不一样（552 宽 / 768 高）。 */
var TPL = {
  none:     { name:"无",      rect:[0, 0, 1, 1] },
  line:     { name:"细边框",  rect:[0.045, 0.032, 0.910, 0.936] },
  polaroid: { name:"拍立得",  rect:[0.029, 0.025, 0.942, 0.815] },  /* 左右上减半，底白不变 */
  puzzle:   { name:"拼图",    rect:[0.0225, 0.016, 0.955, 0.968] },   /* 白边减半 */
  ticket:   { name:"票据",    rect:[0.034, 0.062, 0.932, 0.790] },  /* 下方多留白，放 MOINK */
  film:     { name:"胶片",    rect:[0.145, 0.085, 0.710, 0.830] }
};
var TPL_ORDER = ["none", "line", "polaroid", "puzzle", "ticket", "film"];

function tplNow(){
  var id = String(cfg.tpl || "none");
  return TPL[id] ? id : "none";
}
function tplRect(){ return TPL[tplNow()].rect; }

/* ---------- 绘制工具 ---------- */
function tplK(cw){ return cw / EW; }
/* 线宽跟着画布缩放走，缩略图上也不会消失 */
function tplLW(cw, ratio){ return Math.max(1, Math.round(tplK(cw) * (ratio || 1.4))); }

/* 圆角矩形：老内核没有 ctx.roundRect，自己用 arcTo 拼 */
function tplRRect(ctx, x, y, w, h, r){
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/* 把可见区之外的照片盖成白。模板的一切效果都从这一步开始：
   照片仍然满幅画着，只是边缘被「相纸挡板」挡住了。 */
function tplMaskOut(ctx, cw, ch, r, col){
  if (r[0] <= 0 && r[1] <= 0 && r[2] >= 1 && r[3] >= 1) return;
  var x = r[0]*cw, y = r[1]*ch, w = r[2]*cw, h = r[3]*ch;
  ctx.save();
  ctx.fillStyle = col || "#fff";
  ctx.fillRect(0, 0, cw, Math.ceil(y));
  ctx.fillRect(0, y + h, cw, ch - y - h);
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, cw - x - w, h);
  ctx.restore();
}

/* 可见区四角倒圆角：把每个角「方形减去 1/4 圆」的区域盖成相纸色。
   R 按当前画布缩放（32px = 3mm @270ppi，53px = 5mm @270ppi）。 */
function tplRound(ctx, x, y, w, h, R, col){
  R = Math.min(R, w/2, h/2);
  if (R < 1) return;
  ctx.save();
  ctx.fillStyle = col || "#fff";
  /* 左上 */
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + R, y);
  ctx.arc(x + R, y + R, R, -Math.PI/2, Math.PI, true); ctx.closePath(); ctx.fill();
  /* 右上 */
  ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w - R, y);
  ctx.arc(x + w - R, y + R, R, -Math.PI/2, 0, false); ctx.closePath(); ctx.fill();
  /* 右下 */
  ctx.beginPath(); ctx.moveTo(x + w, y + h); ctx.lineTo(x + w, y + h - R);
  ctx.arc(x + w - R, y + h - R, R, 0, Math.PI/2, false); ctx.closePath(); ctx.fill();
  /* 左下 */
  ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + R, y + h);
  ctx.arc(x + R, y + h - R, R, Math.PI/2, Math.PI, false); ctx.closePath(); ctx.fill();
  ctx.restore();
}
/* 相纸四角倒圆角（拼图：最屏幕边缘四角 5mm） */
function tplRoundSheet(ctx, cw, ch, R, col){
  tplRound(ctx, 0, 0, cw, ch, R, col);
}

/* ---------- 六种边框 ---------- */
/* 细边框：白边 + 照片四角 3mm 圆角，不画任何线（用户明确：不要黑线） */
function tplArtLine(ctx, cw, ch){
  var r = tplRect();
  tplMaskOut(ctx, cw, ch, r);
  tplRound(ctx, r[0]*cw, r[1]*ch, r[2]*cw, r[3]*ch, Math.round(32*tplK(cw)), "#fff");
}

/* 拍立得：上窄白 + 下方宽白；照片四角 3mm 圆角，只压一道极淡的圆角边 */
function tplArtPolaroid(ctx, cw, ch){
  var r = tplRect(), lw = tplLW(cw, 1);
  var x = r[0]*cw, y = r[1]*ch, w = r[2]*cw, h = r[3]*ch;
  var rad = Math.round(32*tplK(cw));
  tplMaskOut(ctx, cw, ch, r);
  tplRound(ctx, x, y, w, h, rad, "#fff");
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = Math.max(1, Math.round(lw * 0.8));
  tplRRect(ctx, x, y, w, h, rad); ctx.stroke();
  ctx.restore();
}

/* 拼图：细白边 + 错位拼缝（竖缝居中，左块横缝在上、右块横缝在下）
   —— 缝宽与白边同宽，四块高度各不相同，看起来才像真拼图。 */
function tplArtPuzzle(ctx, cw, ch){
  var r = tplRect();
  var x = r[0]*cw, y = r[1]*ch, w = r[2]*cw, h = r[3]*ch;
  var gw = Math.max(2, Math.round(r[0]*cw));      /* 竖缝 = 左右白边宽 */
  var gh = Math.max(2, Math.round(r[1]*ch));      /* 横缝 = 上下白边宽 */
  tplMaskOut(ctx, cw, ch, r);
  /* 靠屏幕边缘的四角倒 5mm 圆角（在拼缝之前挖掉，缝不补角） */
  tplRound(ctx, x, y, w, h, Math.round(53*tplK(cw)), "#fff");
  ctx.save();
  ctx.fillStyle = "#fff";
  /* 竖缝：整高、居中 */
  ctx.fillRect(Math.round(x + w/2 - gw/2), Math.round(y), gw, Math.round(h));
  /* 横缝：左边 40%、右边 62%，各画半幅，互不相接 */
  ctx.fillRect(Math.round(x), Math.round(y + h*0.40 - gh/2), Math.round(w/2), gh);
  ctx.fillRect(Math.round(x + w/2), Math.round(y + h*0.62 - gh/2), Math.round(w/2), gh);
  ctx.restore();
}

/* 票据（按用户参考图重做）：
     · 纸面顶到屏幕四边，上下白边略宽、左右略窄
     · 画框四角挖 1/4 圆（内凹倒角），**不描黑线**
     · 上下屏幕边缘打一排黑色半圆 = 邮票齿孔 */
function tplArtTicket(ctx, cw, ch){
  var k = tplK(cw), r = tplRect();
  var x = r[0]*cw, y = r[1]*ch, w = r[2]*cw, h = r[3]*ch;
  var R = Math.max(6, Math.round(k * 30));        /* 1/4 圆倒角半径 */
  var i, cx;
  tplMaskOut(ctx, cw, ch, r);

  ctx.save();
  /* 四角挖扇形：圆心就是画框角点，半径 R，挖掉的那块盖白 */
  ctx.fillStyle = "#fff";
  var corners = [[x, y, 0], [x + w, y, Math.PI/2],
                 [x + w, y + h, Math.PI], [x, y + h, Math.PI*1.5]];
  for (i = 0; i < 4; i++){
    ctx.beginPath();
    ctx.moveTo(corners[i][0], corners[i][1]);
    ctx.arc(corners[i][0], corners[i][1], R, corners[i][2], corners[i][2] + Math.PI/2);
    ctx.closePath();
    ctx.fill();
  }

  /* R1.4.6：画框不再描黑线 —— 四角的扇形挖白已经足够交代轮廓（用户要求） */

  /* 上下邮票孔：黑色半圆，圆心落在屏幕上下边缘。
     ★ 从左右两个角落开始排（首孔圆心 = pr，末孔圆心 = cw - pr），中间均分 ——
     不再是「按格数居中」，那样两端会空出半个孔的距离，看着像没排满。 */
  var pr = Math.max(6, Math.round(k * 22));      /* 齿孔直径加倍（用户要求） */
  var span = Math.max(pr * 2, cw - pr * 2);
  var n = Math.max(2, Math.round(span / Math.max(pr * 2.6, k * 72)) + 1);
  ctx.fillStyle = "#000";
  for (i = 0; i < n; i++){
    cx = pr + span * (i / (n - 1));
    ctx.beginPath(); ctx.arc(cx, 0, pr, 0, Math.PI); ctx.fill();          /* 上沿：向下半圆 */
    ctx.beginPath(); ctx.arc(cx, ch, pr, Math.PI, Math.PI*2); ctx.fill(); /* 下沿：向上半圆 */
  }
  ctx.restore();
}

/* 胶片（竖版）：整块黑边包住照片，左右两条宽黑带上打圆角齿孔，
   上下黑边窄一些，留给文字控件（片号 / 日期）。 */
function tplArtFilm(ctx, cw, ch){
  var r = tplRect();
  var x = r[0]*cw, y = r[1]*ch, w = r[2]*cw, h = r[3]*ch;
  tplMaskOut(ctx, cw, ch, r, "#000");

  ctx.save();
  /* 齿孔：正方形轮廓 + 圆角（用户 11-17 二次反馈：改回和之前一样的圆角矩形，
     只是变成正方形）。间距取前后平均：(旧 1.95 + 新 2.6)/2 = 2.275。
     ★ 宽度仍按带宽 0.52（正方形），圆角半径取孔边长的 0.22。 */
  var bandL = x, bandR = cw - x - w;
  var bandW = Math.min(bandL, bandR);
  var pw = Math.max(8, Math.round(bandW * 0.52));   /* 方孔边长 */
  var ph = pw;                                      /* 正方 */
  var rad = Math.max(2, Math.round(pw * 0.22));     /* 圆角：恢复圆角矩形 */
  var pitch = Math.round(ph * 2.275);               /* 间距：旧新平均 */
  var n = Math.max(3, Math.floor((ch - ph) / pitch) + 1);
  var y0 = Math.round((ch - ((n - 1) * pitch + ph)) / 2);
  ctx.fillStyle = "#fff";
  for (var i = 0; i < n; i++){
    var yy = y0 + i * pitch;
    tplRRect(ctx, Math.round(bandL/2 - pw/2), yy, pw, ph, rad); ctx.fill();
    tplRRect(ctx, Math.round(x + w + bandR/2 - pw/2), yy, pw, ph, rad); ctx.fill();
  }
  /* R1.4.6：照片与黑边之间不再画白框线（用户要求） */
  ctx.restore();
}

var TPL_ART = {
  none: null,
  line: tplArtLine,
  polaroid: tplArtPolaroid,
  puzzle: tplArtPuzzle,
  ticket: tplArtTicket,
  film: tplArtFilm
};

/* 画在照片之上、文字之下。none 什么都不画。 */
function drawTpl(ctx, cw, ch){
  var f = TPL_ART[tplNow()];
  if (!f) return;
  try { f(ctx, cw, ch); } catch(e){}
}

/* ---------- 模板自带文字 ----------
   胶片是竖版片基：上下两条黑边各留一行字（片号 / 日期）。
   这些字是**编辑区里真实的文字对象**，用户能改能拖，换模板时自动清掉。 */
function tplSeedText(name){
  if (name !== "film" && name !== "ticket" && name !== "polaroid") return;
  var objs = curObjs();
  /* 拍立得：下方宽留白放「红心 / 黄五角星 / 黑纸飞机 + 文字」+ 右侧黄色书签，
     全部是可编辑对象（带 tpl 标记，换模板自动清掉）。
     ★ 图标用 glyph 贴纸而不是彩色 emoji —— glyph 才跟四色调色板走。
     ★ 11-17 二次反馈：图标+文字改**左对齐**（原来居中）；右侧空白处加黄底书签。 */
  if (name === "polaroid"){
    var yBand = Math.round((0.025 + 0.815) * EH + (1 - 0.025 - 0.815) * EH / 2);
    var cy = yBand - 16;                       /* 图标行 */
    var left = Math.round(TPL.polaroid.rect[0] * EW) + 24;  /* 对齐到留白区左缘 + 内缩 */
    var xs = [left + 22, left + 66, left + 110];
    var chs = ["♥", "★", "✈"];
    var cls = [3, 2, 0];                       /* 红 / 黄 / 黑 */
    for (var q = 0; q < 3; q++){
      objs.push({ type:"stk", kind:"glyph", ch:chs[q], color:cls[q],
                  x:xs[q], y:cy, w:44, h:44, rot:0, tpl:"polaroid" });
    }
    objs.push({ type:"text", x:left + 106, y:cy + 52, text:"RECORD EVERY DAY OF LIFE",
                font:0, size:16, color:0, rot:0, stroke:0, strokeC:1,
                bg:0, wrap:0, tpl:"polaroid" });
    /* 右侧黄色书签：黄底黑字文字对象，可编辑可拖，跟图标一套 tpl 标记 */
    var right = Math.round((TPL.polaroid.rect[0] + TPL.polaroid.rect[2]) * EW) - 40;
    objs.push({ type:"text", x:right, y:cy, text:"MEMO",
                font:0, size:14, color:0, rot:0, stroke:0, strokeC:1,
                bg:3, wrap:0, tpl:"polaroid" });   /* bg:3 = 黄 */
    return;
  }
  /* 票据：下方留白正中间放一行大字（用户要求「添加一行大文字 MOINK」） */
  if (name === "ticket"){
    var rt = TPL.ticket.rect;
    var yMid = Math.round((rt[1] + rt[3]) * EH + (1 - rt[1] - rt[3]) * EH / 2);
    objs.push({ type:"text", x:EW/2, y:yMid, text:"MOINK",
                font:0, size:48, color:0, rot:0, stroke:0, strokeC:1,
                bg:0, wrap:0, tpl:"ticket" });
    return;
  }
  var yTop = Math.round(EH * 0.085 * 0.5);
  var yBot = Math.round(EH - EH * 0.085 * 0.5);
  /* 上黑边：片名 */
  objs.push({ type:"text", x:EW/2, y:yTop, text:"MOINK",
              font:0, size:28, color:C_W, rot:0, stroke:0, strokeC:1,
              bg:0, wrap:0, tpl:"film" });
  /* 下黑边：拍摄日期，做成**日期控件**（面板文字框可直接改字、可换样式） */
  if (typeof dateText === "function"){
    /* 边条窄（65px），点阵/数码管在这个高度下会糊；真胶片边缘的日期也是普通印刷字。
       默认走「普通」，选中后仍可在面板切点阵/数码管。 */
    var style = "txt";
    var fmt   = ($("dateFmt") ? $("dateFmt").value : "ymd");
    var base  = (typeof shotDate !== "undefined" && shotDate) ? shotDate : new Date();
    objs.push({ type:"date", style:style, fmt:fmt, text:dateText(fmt, base),
                x:EW/2, y:yBot, size:30, color:C_W, rot:0, tpl:"film" });
  }
}

/* ---------- 套用 ---------- */
/* 只删模板自己加过的文字，用户自己加的一律不动 */
function tplDropText(){
  var objs = curObjs();
  for (var i = objs.length - 1; i >= 0; i--)
    if (objs[i] && objs[i].tpl) objs.splice(i, 1);
  selIdx = -1;
}

function tplApply(name){
  if (!TPL[name]) return;
  cfg.tpl = name;
  tplDropText();
  tplSeedText(name);
  /* 模板只是叠加蒙版：取景框、照片几何、裁剪缓存全部不动，只重画一次 */
  if (typeof layoutPadMask === "function") layoutPadMask();
  saveCfg();
  if (typeof layoutObjs === "function") layoutObjs();
  schedulePreview(false);
  if (typeof syncTplUI === "function") syncTplUI();
  msg("已套用模板：" + TPL[name].name, "ok");
}
