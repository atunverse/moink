"use strict";
/* ==================================================================
   10-core.js —— 常量 / 几何 / 色彩工具
   ------------------------------------------------------------------
   · 设备帧 PANEL 与编辑空间 EW×EH：编辑空间恒为设备帧顺时针转 90°
   · 所有坐标、字号、留白都以「编辑空间像素」为单位存储
   · PAL 是四色板：0 黑 / 1 白 / 2 黄 / 3 红
   · 从本文件到 13-pack.js 全都是**纯函数**（不碰 DOM）：
     smoke_page.js 会把这一段抽出来在 sandbox 里跑断言，
     所以 $ 与 document 一律放到 20-state.js 之后。
   ================================================================== */

/* 离线客户端：整页存成 file:// 打开时用它拼 URL */
var BASE = (typeof window.MOINK_BASE === "string" && window.MOINK_BASE) ? window.MOINK_BASE : "";
function api(p){ return BASE + p; }
var PANEL = { id: 0, name: "A0", w: 768, h: 552 };
/* R1.1.2（FB-013）：设备帧几何由「屏幕 + A1 驱动模式」共同决定——
   A0 / A1(默认 768×552 顺序) = 768×552；A1(原生 800×600 对照档) = 800×600。
   编辑空间恒为设备帧顺时针转 90°（EW x EH = h x w），见 applyPanelGeom()。 */
/* 设备帧格式契约版本（/api/info.api）：0 = 未连设备 / 能力未知（本地离线打开页面时
   fetch 失败），>=2 = fw R1.1.0 及以后。连上设备后以真实 api 为准。 */
var DEV_API = 0;
var EW = 552, EH = 768;
/* GEOM_SRC = 当前已存文字/留白坐标所依据的编辑空间几何（竖屏）。 */
var GEOM_SRC = { w: 552, h: 768 };
function migrateGeomTo(nw, nh){
  if (GEOM_SRC.w === nw && GEOM_SRC.h === nh) return false;
  var kx = nw / GEOM_SRC.w, ky = nh / GEOM_SRC.h;
  function sc(o){
    o.x = Math.round((+o.x || 0) * kx);
    o.y = Math.round((+o.y || 0) * ky);
    o.size = clamp(Math.round((+o.size || 48) * kx), 16, 240);
    o.wrap = (+o.wrap) ? Math.round(+o.wrap * kx) : 0;
  }
  (cfg.objsImg || []).forEach(sc);
  (cfg.objsNote || []).forEach(sc);
  GEOM_SRC = { w: nw, h: nh };
  cfg.geomW = nw; cfg.geomH = nh;
  saveCfg();
  return true;
}
/* 应用屏幕：切换 PANEL 与编辑空间；几何变了则按比例迁移已存工程（坐标/字号/
   换行宽/留白），保证版面意图不变。返回是否发生了几何切换。
   R1.2.2：A1 只保留 768×552 顺序档，A0 / A1 几何一致，故不再有分支。 */
function applyPanelGeom(panelId){
  if (PANEL.w === 768 && PANEL.h === 552){ PANEL.id = +panelId; return false; }
  PANEL.id = +panelId; PANEL.w = 768; PANEL.h = 552;
  EW = 552; EH = 768;
  migrateGeomTo(EW, EH);
  return true;
}
var MODE  = 0;
var PAL = [[0,0,0], [255,255,255], [255,255,0], [255,0,0]];   /* 0K 1W 2黄 3红 */
var C_K = 0, C_W = 1, C_Y = 2, C_R = 3;
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function mod(a,n){ return ((a%n)+n)%n; }
function luma(r,g,b){ return r*0.2126+g*0.7152+b*0.0722; }
function s2l(v){ v=clamp(v,0,255)/255; return 255*(v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)); }
function l2s(v){ v=clamp(v,0,255)/255; return 255*(v<=0.0031308?v*12.92:1.055*Math.pow(v,1/2.4)-0.055); }
var S2L_LUT=(function(){ var t=new Float64Array(256); for(var i=0;i<256;i++)t[i]=s2l(i); return t; })();
var PAL_LIN = PAL.map(function(p){ return p.map(s2l); });
