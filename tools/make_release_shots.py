#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 R1.4.0 发布说明 / 操作说明书用的效果图（真实照片示例）。

与 shot_tpl.py / shot_note.py 的区别：那两个用脚本画的渐变+太阳示意，
本脚本把 Unsplash 真实照片 adoptImg 进真页面，再走 renderTo 出四色成品，
按 montage 拼图。图存 docs/images/，只用于文档，不进固件。

用法：
    python tools/make_release_shots.py            # 全部 4 张
    python tools/make_release_shots.py tpl        # 只出某张
"""
import io
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAGE = os.path.join(ROOT, "page")
DOCS_IMG = os.path.join(ROOT, "docs", "images")
PHOTOS = os.path.join(DOCS_IMG, "photos")
TMP_PHOTOS = os.path.join(PAGE, "_relphotos")

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]

W, H = 1010, 980


def find_edge():
    for p in EDGE_CANDIDATES:
        if os.path.isfile(p):
            return p
    raise SystemExit("找不到 Edge/Chrome")


# 复用 shot_tpl 的 montage / FRAME（同一套拼图版式）
sys.path.insert(0, HERE)
import shot_tpl as S

MONTAGE = S.MONTAGE

# ---- 状态脚本：每个都先 adoptImg 真实照片，再做各自演示 ----
def adopt(photo):
    return ('var im=new Image();im.onload=function(){'
            'adoptImg(im,"_relphotos/%s.jpg",{name:"%s.jpg"});'
            'setTimeout(RUN,900);};im.src="_relphotos/%s.jpg";' % (photo, photo, photo))

TPL = """
(function(){
  function RUN(){
    var names=["none","line","polaroid","puzzle","ticket","film"];
    var titles=["原图（参考）","细边框","拍立得","拼图","票据","胶片"];
    var tiles=[];
    for(var i=0;i<names.length;i++){
      tplApply(names[i]);
      var cv=document.createElement("canvas");renderTo(cv,EW,EH);
      tiles.push({name:titles[i],cv:cv});
    }
    montage(tiles);
  }
  %s
})()
""" % adopt("flower")

NOTE = r"""
(function(){
  function RUN(){
    setMode(1,true);
    var names={todo:"待办清单",memo:"备忘挂件",cornell:"康奈尔笔记",
               kanban:"看板",poster:"纯文字画报",dark:"票根挂件·墨黑"};
    var tiles=[];
    for(var i=0;i<NOTE_LAYOUT_ORDER.length;i++){
      var k=NOTE_LAYOUT_ORDER[i],d=noteDoc();
      d.layout=k;d.theme=(k==="dark")?"ink":"paper";
      d.tok=null;d.cols=3;d.scale=1;d.density="normal";d.raw=NOTE_SAMPLE[k];
      noteSyncBlocks();
      var cv=document.createElement("canvas");renderTo(cv,EW,EH);
      tiles.push({name:names[k],cv:cv});
    }
    montage(tiles);
  }
  %s
})()
""" % adopt("coffee")

FX = r"""
(function(){
  function RUN(){
    var tiles=[];
    function shot(title,fn){
      fn();var cv=document.createElement("canvas");renderTo(cv,EW,EH);
      tiles.push({name:title,cv:cv});
    }
    setMode(0,true);cfg.tpl="none";
    /* 1 原图 */
    shot("1 原图四色化",function(){cfg.objsImg=[];});
    /* 2 文字：红字黄描边 */
    shot("2 文字·描边旋转",function(){
      cfg.objsImg=[{type:"text",text:"MOINK",x:EW/2,y:EH*0.4,size:96,color:3,
        stroke:4,strokeC:2,rot:-8,bg:0}];
    });
    /* 3 贴纸：图标 + 表情 */
    shot("3 贴纸·图标/表情",function(){
      cfg.objsImg=[
        {type:"stk",kind:"glyph",ch:"\u2665",color:3,x:EW*0.3,y:EH*0.35,w:70,h:70,rot:0},
        {type:"stk",kind:"glyph",ch:"\u2605",color:2,x:EW*0.55,y:EH*0.35,w:70,h:70,rot:0},
        {type:"stk",kind:"emoji",ch:"\U0001F31F",x:EW*0.78,y:EH*0.35,w:70,h:70,rot:0}
      ];
    });
    /* 4 日期：点阵（放大居中展示字形；实际默认是右下 20px 小戳，见第 6 格） */
    shot("4 日期·点阵",function(){
      cfg.objsImg=[{type:"date",style:"dot",fmt:"",text:"11.17",x:EW/2,y:EH/2,
        size:72,color:1,rot:0}];
    });
    /* 5 日期：数码管 */
    shot("5 日期·数码管",function(){
      cfg.objsImg=[{type:"date",style:"seg",fmt:"",text:"11.17",x:EW/2,y:EH/2,
        size:72,color:1,rot:0}];
    });
    /* 6 组合成品 */
    shot("6 组合成品",function(){
      cfg.tpl="polaroid";
      cfg.objsImg=[{type:"date",style:"dot",fmt:"ymd",text:"",x:EW-24-90,y:EH-34,
        size:20,color:0,rot:0}];
    });
    cfg.objsImg=[];cfg.tpl="none";
    montage(tiles);
  }
  %s
})()
""" % adopt("cat")

COLOR = r"""
(function(){
  function RUN(){
    setMode(0,true);cfg.tpl="none";cfg.objsImg=[];
    var tiles=[];
    function shot(title){var cv=document.createElement("canvas");renderTo(cv,EW,EH);
      tiles.push({name:title,cv:cv});}
    /* 固定同一张照片，切不同风格 preset */
    /* 页面真实预设：natural 自然暖调 / adaptive 全面暖色 / gray 纯灰度 / naive 原色直出 */
    var presets=["natural","adaptive","gray","naive"];
    var names=["自然暖调","全面暖色","纯灰度","原色直出"];
    for(var i=0;i<presets.length;i++){
      var b=document.querySelector('#presets button[data-m="'+presets[i]+'"]');
      if(b){b.click();}
      shot(names[i]);
    }
    montage(tiles);
  }
  %s
})()
""" % adopt("street")

SHOTS = [
    ("tpl", TPL, "01-模板效果.png"),
    ("note", NOTE, "02-便签六版式.png"),
    ("fx", FX, "03-文字贴纸日期.png"),
    ("color", COLOR, "04-调色风格.png"),
]


def shot(edge, tag, state, outname):
    # 复制照片到 page/_relphotos（file:// 同源相对路径）
    if not os.path.isdir(TMP_PHOTOS):
        os.makedirs(TMP_PHOTOS)
    for f in glob_photos():
        shutil.copyfile(f, os.path.join(TMP_PHOTOS, os.path.basename(f)))
    tmp = os.path.join(PAGE, "_relframe.html")
    frame = u"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#f4f1ea}
iframe{width:%dpx;height:%dpx;border:0;display:block}
</style></head><body><iframe id="f" src="index.dev.html"></iframe>
<script>
document.getElementById("f").addEventListener("load",function(){
  var w=this.contentWindow;
  try{w.eval(%s);w.eval(%s);}catch(e){document.title="ERR "+e.message;}
});
</script></body></html>""" % (W, H, json.dumps(MONTAGE), json.dumps(state))
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(frame)
    out = os.path.join(DOCS_IMG, outname)
    subprocess.call([
        edge, "--headless=new", "--disable-gpu",
        "--allow-file-access-from-files", "--force-device-scale-factor=1",
        "--hide-scrollbars", "--virtual-time-budget=12000",
        "--window-size=%d,%d" % (W, H), "--screenshot=" + out,
        "file:///" + tmp.replace("\\", "/"),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.path.exists(tmp):
        os.remove(tmp)
    ok = os.path.exists(out)
    print("%-6s -> %s %s" % (tag, outname, ("%d B" % os.path.getsize(out)) if ok else "失败"))
    return ok


def glob_photos():
    import glob
    return glob.glob(os.path.join(PHOTOS, "*.jpg"))


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    edge = find_edge()
    rc = 0
    for tag, state, outname in SHOTS:
        if what != "all" and tag != what:
            continue
        rc = rc or (0 if shot(edge, tag, state, outname) else 1)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
