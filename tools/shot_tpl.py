#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""模板 / 日期总览图：在真页面里跑 renderTo(EW, EH)，把原生 552×768 的合成结果
拼成一张对照图，用来核对边框几何与日期字形。

为什么不用 UI 截图：预览画布在手机上只有几百像素宽，1.5px 的线、11px 的邮票孔
在那个尺寸看不出来；这里直接拿合成结果，和上屏像素是同一份。

用法：
    python tools/shot_tpl.py            # 六种模板 + 日期样式，出两张图
    python tools/shot_tpl.py tpl        # 只出模板
    python tools/shot_tpl.py date       # 只出日期
"""
import io
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAGE = os.path.join(ROOT, "page")

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]

W, H = 1010, 980

DEMO = """
(function(){
  var cv=document.createElement("canvas");cv.width=900;cv.height=1200;
  var x=cv.getContext("2d");
  var g=x.createLinearGradient(0,0,900,1200);
  g.addColorStop(0,"#9db6cf");g.addColorStop(0.5,"#e6c79a");g.addColorStop(1,"#6d5a4a");
  x.fillStyle=g;x.fillRect(0,0,900,1200);
  x.fillStyle="#c8553d";x.beginPath();x.arc(600,360,190,0,7);x.fill();
  x.fillStyle="#f2e9d8";x.fillRect(80,760,420,260);
  x.fillStyle="#2f3d4d";x.font="bold 96px sans-serif";x.fillText("MOINK",90,900);
  x.strokeStyle="#2f3d4d";x.lineWidth=10;x.strokeRect(20,20,860,1160);
  return cv.toDataURL("image/png");
})()
"""

TPL_JS = """
(function(){
  var url = %s;
  var im = new Image();
  im.onload = function(){
    adoptImg(im, url, {name:"demo.png"});
    setTimeout(function(){
      var names = ["none","line","polaroid","puzzle","ticket","film"];
      var tiles = [];
      for (var i=0;i<names.length;i++){
        tplApply(names[i]);            /* 走真实入口：胶片会顺带补上下两条文字 */
        var cv = document.createElement("canvas");
        renderTo(cv, EW, EH);
        tiles.push({name: TPL[names[i]].name, cv: cv});
      }
      montage(tiles);
    }, 900);
  };
  im.src = url;
})()
"""

DATE_JS = """
(function(){
  cfg.tpl = "none";
  setMode(0, true);
  var rows = [
    {t:"点阵 2026.11.13", s:"dot", x:"2026.11.13", z:64},
    {t:"点阵 MOINK 400",  s:"dot", x:"MOINK 400",  z:64},
    {t:"点阵 12:36",      s:"dot", x:"12:36",      z:64},
    {t:"数码管 2026.11.13", s:"seg", x:"2026.11.13", z:64},
    {t:"数码管 12:36",    s:"seg", x:"12:36",      z:64},
    {t:"数码管 Nov.13 2026", s:"seg", x:"Nov.13 2026", z:44},
    {t:"普通 2026.11.13", s:"txt", x:"2026.11.13", z:64},
    {t:"回退 11月13日",   s:"dot", x:"11月13日",   z:64},
    {t:"回退 AB12中文",   s:"seg", x:"AB12中文",   z:64}
  ];
  var tiles = [];
  for (var i=0;i<rows.length;i++){
    cfg.objsImg = [{ type:"date", style:rows[i].s, text:rows[i].x, fmt:"ymd",
                     x:EW/2, y:EH/2, size:rows[i].z, color:0, rot:0 }];
    var cv = document.createElement("canvas");
    renderTo(cv, EW, EH);
    tiles.push({name: rows[i].t, cv: cv});
  }
  cfg.objsImg = [];
  montage(tiles);
})()
"""

DATEBG_JS = """
(function(){
  cfg.tpl = "none";
  setMode(0, true);
  /* 深灰照片当底：白字、白描边、黑底都能看清（白纸上白描边是隐形的，容易误判） */
  var c0 = document.createElement("canvas"); c0.width = 900; c0.height = 1200;
  var x0 = c0.getContext("2d");
  var g = x0.createLinearGradient(0,0,0,1200);
  g.addColorStop(0,"#5b6b7c"); g.addColorStop(0.55,"#39424d"); g.addColorStop(1,"#66707c");
  x0.fillStyle = g; x0.fillRect(0,0,900,1200);
  /* 日期也是文字控件：底色 1白/2黑/3黄/4红，描边宽 st + 描边色 sc */
  var rows = [
    {t:"点阵 · 黄底黑字",           s:"dot", z:64, c:0, st:0, sc:1, bg:3},
    {t:"点阵 · 红描边4 + 白字",     s:"dot", z:64, c:1, st:4, sc:3, bg:0},
    {t:"数码管 · 白底黑字",         s:"seg", z:64, c:0, st:0, sc:1, bg:1},
    {t:"数码管 · 白描边3 + 红字",   s:"seg", z:64, c:3, st:3, sc:1, bg:0},
    {t:"普通 · 黄底黑字",           s:"txt", z:64, c:0, st:0, sc:1, bg:3},
    {t:"普通 · 黄描边2 + 黑字",     s:"txt", z:64, c:0, st:2, sc:2, bg:0}
  ];
  var im = new Image();
  im.onload = function(){
    adoptImg(im, c0.toDataURL("image/png"), {name:"bg.png"});
    setTimeout(function(){
      var tiles = [];
      for (var i=0;i<rows.length;i++){
        var r = rows[i];
        cfg.objsImg = [{ type:"date", style:r.s, text:"2026.11.13", fmt:"ymd",
                         x:EW/2, y:EH/2, size:r.z, color:r.c, rot:0,
                         stroke:r.st, strokeC:r.sc, bg:r.bg }];
        var cv = document.createElement("canvas");
        renderTo(cv, EW, EH);
        tiles.push({name: r.t, cv: cv});
      }
      cfg.objsImg = [];
      montage(tiles);
    }, 800);
  };
  im.src = c0.toDataURL("image/png");
})()
"""

MONTAGE = """
function montage(tiles){
  var cols = 3, sc = 0.52;
  var tw = Math.round(EW*sc), th = Math.round(EH*sc), gap = 12, cap = 26;
  var rows = Math.ceil(tiles.length / cols);
  var out = document.createElement("canvas");
  out.width = cols*(tw+gap)+gap;
  out.height = rows*(th+cap+gap)+gap;
  var o = out.getContext("2d");
  o.fillStyle = "#f4f1ea"; o.fillRect(0,0,out.width,out.height);
  for (var i=0;i<tiles.length;i++){
    var cx = gap + (i%cols)*(tw+gap);
    var cy = gap + Math.floor(i/cols)*(th+cap+gap);
    o.drawImage(tiles[i].cv, cx, cy, tw, th);
    o.strokeStyle = "#b9b2a4"; o.lineWidth = 1; o.strokeRect(cx+0.5, cy+0.5, tw-1, th-1);
    o.fillStyle = "#2b2b2b"; o.font = "16px sans-serif"; o.textBaseline = "top";
    o.fillText(tiles[i].name, cx+2, cy+th+5);
  }
  document.body.innerHTML = "";
  document.body.style.margin = "0";
  document.body.style.background = "#f4f1ea";
  out.style.display = "block";
  document.body.appendChild(out);
  document.title = "OK";
}
"""

FRAME = u"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
html,body{{margin:0;background:#f4f1ea}}
iframe{{width:{w}px;height:{h}px;border:0;display:block}}
</style></head><body>
<iframe id="f" src="index.dev.html"></iframe>
<script>
document.getElementById("f").addEventListener("load", function(){{
  var w = this.contentWindow;
  try {{ w.eval({montage}); w.eval({state}); }} catch(e) {{ document.title = "ERR " + e.message; }}
}});
</script>
</body></html>
"""


def find_edge():
    for p in EDGE_CANDIDATES:
        if os.path.isfile(p):
            return p
    raise SystemExit("找不到 Edge/Chrome，改 EDGE_CANDIDATES")


def shot(edge, tag, state):
    tmp = os.path.join(PAGE, "_tplframe.html")
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(FRAME.format(w=W, h=H, montage=json.dumps(MONTAGE), state=json.dumps(state)))
    out = os.path.join(PAGE, "_t_%s.png" % tag)
    subprocess.call([
        edge, "--headless=new", "--disable-gpu",
        "--allow-file-access-from-files",
        "--force-device-scale-factor=1", "--hide-scrollbars",
        "--virtual-time-budget=9000",
        "--window-size=%d,%d" % (W, H),
        "--screenshot=" + out,
        "file:///" + tmp.replace("\\", "/"),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.path.exists(tmp):
        os.remove(tmp)
    print("%-6s %s" % (tag, ("%d B" % os.path.getsize(out)) if os.path.exists(out) else "失败"))
    return out


def main():
    what = (sys.argv[1] if len(sys.argv) > 1 else "all").lower()
    edge = find_edge()
    if what in ("all", "tpl"):
        shot(edge, "tpl", TPL_JS % DEMO)
    if what in ("all", "date"):
        shot(edge, "date", DATE_JS)
    if what in ("all", "datebg"):
        shot(edge, "datebg", DATEBG_JS)
    print("图在 page/_t_*.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
