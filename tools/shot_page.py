#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""页面视觉验证：把 page/index.dev.html 装进 390×844 的 iframe 截图。

为什么要用 iframe：Windows 上 Edge/Chrome 的 headless 窗口有最小宽度限制
（约 520px），--window-size=390 会被抬高，截出来的图左侧 390px 之外是裁掉的，
看到的「右侧元素被切」全是假象。套一层 iframe 才能拿到真机 CSS 视口。

用法：
    python tools/shot_page.py              # 抓全部状态到 page/_v_<state>.png
    python tools/shot_page.py color        # 只抓一个
    python tools/shot_page.py --list       # 列出所有状态

状态 = 载入后在 iframe 里执行的一小段脚本（打开面板、切模式、弹菜单…）。
新加状态直接往 STATES 里加一行。
"""
import io
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(os.path.dirname(HERE), "page")

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]

VIEW_W, VIEW_H = 390, 844          # 目标 CSS 视口
PAD_W, PAD_H = 10, 16              # 给外框留一点余量，避免 iframe 贴边看不出边界

STATES = {
    "home":    "",                                   # 空相纸 + 底栏
    "color":   'openTool("color")',                  # 调色面板
    "fx":      'openTool("fx")',
    "compose": 'openTool("compose")',
    # 特效 → 边框页签（留白并进这里之后要看一眼）
    # 选「白边」→ 四边留白输入应展开，照片四周应真的出白边
    # 日期样式：点「数码管」之后，胶囊行的高亮必须跟着走（R1.4.7 回归）
    "datechips": '(function(){'
                 'function tapBar(id,txt){var l=$(id).children;'
                 'for(var i=0;i<l.length;i++){if(l[i].textContent===txt){l[i].click();return true;}}'
                 'return false;}'
                 'var cv=document.createElement("canvas");cv.width=900;cv.height=1200;'
                 'var x=cv.getContext("2d");x.fillStyle="#cdd8e4";x.fillRect(0,0,900,1200);'
                 'x.fillStyle="#2f3d4d";x.fillRect(60,60,780,760);'
                 'x.fillStyle="#e07a3f";x.beginPath();x.arc(450,960,190,0,7);x.fill();'
                 'var im=new Image();'
                 'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"demo.png"});'
                 'setTimeout(function(){openTool("fx");'
                 'tapBar("l2bar","日期");'
                 'addDateObj();'
                 'if(curObjs().length){curObjs()[curObjs().length-1].color=1;layoutObjs();}'
                 'setTimeout(function(){var row=$("dateStyleRow");'
                 'for(var i=0;i<row.children.length;i++){'
                 'if(row.children[i].textContent==="数码管")row.children[i].click();}'
                 'row.scrollIntoView({block:"center"});},300);},700);};'
                 'im.src=cv.toDataURL("image/png");})()',
    # 日期 → 描边：滑块与描边色都要可用（R1.4.8 日期也能描边）
    "datestroke": '(function(){'
                  'function tapBar(id,txt){var l=$(id).children;'
                  'for(var i=0;i<l.length;i++){if(l[i].textContent===txt){l[i].click();return true;}}'
                  'return false;}'
                  'var cv=document.createElement("canvas");cv.width=900;cv.height=1200;'
                  'var x=cv.getContext("2d");x.fillStyle="#3c4653";x.fillRect(0,0,900,1200);'
                  'x.fillStyle="#8a97a6";x.fillRect(80,180,740,700);'
                  'var im=new Image();'
                  'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"demo.png"});'
                  'setTimeout(function(){openTool("fx");'
                  'tapBar("l2bar","日期");'
                  'addDateObj();'
                  'setTimeout(function(){'
                  'if(curObjs().length){curObjs()[curObjs().length-1].color=1;'
                  'curObjs()[curObjs().length-1].stroke=4;'
                  'curObjs()[curObjs().length-1].strokeC=3;layoutObjs();syncSel();}'
                  'tapBar("l3bar","描边");},250);},700);};'
                  'im.src=cv.toDataURL("image/png");})()',
    # 日期 → 底色：四个底色点，日期下方铺一块黄底
    "datebg":     '(function(){'
                  'function tapBar(id,txt){var l=$(id).children;'
                  'for(var i=0;i<l.length;i++){if(l[i].textContent===txt){l[i].click();return true;}}'
                  'return false;}'
                  'var cv=document.createElement("canvas");cv.width=900;cv.height=1200;'
                  'var x=cv.getContext("2d");x.fillStyle="#3c4653";x.fillRect(0,0,900,1200);'
                  'x.fillStyle="#8a97a6";x.fillRect(80,180,740,700);'
                  'var im=new Image();'
                  'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"demo.png"});'
                  'setTimeout(function(){openTool("fx");'
                  'tapBar("l2bar","日期");'
                  'addDateObj();'
                  'setTimeout(function(){'
                  'if(curObjs().length){curObjs()[curObjs().length-1].bg=3;layoutObjs();syncSel();}'
                  'tapBar("l3bar","底色");},250);},700);};'
                  'im.src=cv.toDataURL("image/png");})()',
    # 固定高度下，控件多的两页也要能看（内容多就在 .panes 里滚）
    "fxtext":  '(function(){openTool("fx");'
               '(function t(){var l=$("l2bar").children;'
               'for(var i=0;i<l.length;i++){if(l[i].textContent==="文字"){l[i].click();return;}}}());})()',
    "fxstick": '(function(){openTool("fx");'
               '(function t(){var l=$("l2bar").children;'
               'for(var i=0;i<l.length;i++){if(l[i].textContent==="贴纸"){l[i].click();return;}}}());})()',
    # 日期二级菜单：点「数码管」当场加一个红字白描边的日期（R1.4.9 点选即加）
    "datemenu": '(function(){'
                'function tapBar(id,txt){var l=$(id).children;'
                'for(var i=0;i<l.length;i++){if(l[i].textContent===txt){l[i].click();return true;}}'
                'return false;}'
                'var cv=document.createElement("canvas");cv.width=900;cv.height=1200;'
                'var x=cv.getContext("2d");x.fillStyle="#b9c6d4";x.fillRect(0,0,900,1200);'
                'x.fillStyle="#3d4a59";x.fillRect(70,150,760,620);'
                'x.fillStyle="#d9a06a";x.beginPath();x.arc(450,980,180,0,7);x.fill();'
                'var im=new Image();'
                'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"demo.png"});'
                'setTimeout(function(){openTool("fx");tapBar("l2bar","日期");'
                'setTimeout(function(){tapBar("dateStyleRow","数码管");'
                'if(curObjs().length){curObjs()[curObjs().length-1].y=EH*0.5;}'
                'layoutObjs();},250);},700);};'
                'im.src=cv.toDataURL("image/png");})()',
    # 日期自定义文字：点「自定义」展开输入行
    "datecustom": '(function(){'
                  'function tapBar(id,txt){var l=$(id).children;'
                  'for(var i=0;i<l.length;i++){if(l[i].textContent===txt){l[i].click();return true;}}'
                  'return false;}'
                  'var cv=document.createElement("canvas");cv.width=900;cv.height=1200;'
                  'var x=cv.getContext("2d");x.fillStyle="#c8d2dc";x.fillRect(0,0,900,1200);'
                  'var im=new Image();'
                  'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"demo.png"});'
                  'setTimeout(function(){openTool("fx");tapBar("l2bar","日期");'
                  'setTimeout(function(){tapBar("l3bar","自定义");'
                  'var inp=$("dateCustom");if(inp){inp.value="Moink"+String.fromCharCode(10)+"2026.11-13";'
                  'inp.dispatchEvent(new Event("input"));}'
                  'layoutObjs();},300);},700);};'
                  'im.src=cv.toDataURL("image/png");})()',
    # 贴纸 → 图标：最前面那个「＋」点开输入框（和表情页同一个入口）
    "stkicon": '(function(){'
               'function tapBar(id,txt){var l=$(id).children;'
               'for(var i=0;i<l.length;i++){if(l[i].textContent===txt){l[i].click();return true;}}'
               'return false;}'
               'var cv=document.createElement("canvas");cv.width=900;cv.height=1200;'
               'var x=cv.getContext("2d");x.fillStyle="#c8d2dc";x.fillRect(0,0,900,1200);'
               'var im=new Image();'
               'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"demo.png"});'
               'setTimeout(function(){openTool("fx");tapBar("l2bar","贴纸");'
               'setTimeout(function(){$("stkIcoAdd").click();'
               'var inp=$("stkIcoIn");if(inp){inp.value="✈";'
               'inp.dispatchEvent(new Event("input"));}},300);},700);};'
               'im.src=cv.toDataURL("image/png");})()',
    # 设备设置：屏幕 / GPIO / 更新和恢复 / 其他 都是第 2 栏的下拉项
    "devset":  '(function(){showView("dev");setTimeout(function(){'
               'var vs=$("vDev"), ds=vs.querySelectorAll("details");'
               'for(var i=4;i<ds.length;i++) ds[i].open=true;'
               'vs.scrollTop = ds[4].offsetTop - 70;},400);})()',
    "devset2": '(function(){showView("dev");setTimeout(function(){'
               'var vs=$("vDev"), ds=vs.querySelectorAll("details");'
               'for(var i=4;i<ds.length;i++) ds[i].open=true;'
               'vs.scrollTop = vs.scrollHeight;},400);})()',
    "save":    'openTool("save")',
    # 便签（R1.4.0）：内容 / 版式 / 配色 三个面板 + 一张纯文字画报
    "note":    '(function(){setMode(1);var d=noteDoc();d.raw=NOTE_SAMPLE.todo;'
               'd.layout="todo";d.theme="paper";d.tok=null;d.scale=1;'
               'd.density="normal";noteSyncBlocks();openTool("ncontent");})()',
    "notelayout": '(function(){setMode(1);noteSetLayout("kanban");'
                  'var d=noteDoc();d.raw=NOTE_SAMPLE.kanban;noteSyncBlocks();'
                  'openTool("nlayout");var r=$("noteLayoutRow");'
                  'for(var i=0;i<r.children.length;i++){'
                  'if(r.children[i].textContent==="看板")r.children[i].click();}})()',
    "notetheme": '(function(){setMode(1);var d=noteDoc();d.raw=NOTE_SAMPLE.todo;'
                 'noteSyncBlocks();noteSetLayout("todo");'
                 'noteSetTheme("ink");openTool("ntheme");})()',
    "noteposter": '(function(){setMode(1);noteSetLayout("poster");'
                  'var d=noteDoc();d.raw=NOTE_SAMPLE.poster;noteSyncBlocks();'
                  'noteSetTheme("paper");openTool("nlayout");})()',
    # 上传后应自动落进构图（裁剪框 + 构图面板），不需要再点一次底栏
    "pick":    '(function(){'
               'var cv=document.createElement("canvas");cv.width=900;cv.height=1200;'
               'var x=cv.getContext("2d");'
               'x.fillStyle="#cdd8e4";x.fillRect(0,0,900,1200);'
               'x.fillStyle="#2f3d4d";x.fillRect(60,60,780,400);'
               'x.fillStyle="#e07a3f";x.beginPath();x.arc(450,720,190,0,7);x.fill();'
               'x.fillStyle="#fff";x.font="bold 88px sans-serif";x.fillText("MOINK",190,1080);'
               'var im=new Image();'
               'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"demo.png"});};'
               'im.src=cv.toDataURL("image/png");})()',
    # 横图：验证「按原比例完整显示」（四周应有留白，不被裁）
    "cropland": '(function(){'
                'var cv=document.createElement("canvas");cv.width=1600;cv.height=900;'
                'var x=cv.getContext("2d");'
                'x.fillStyle="#e8ecf3";x.fillRect(0,0,1600,900);'
                'x.fillStyle="#2f3d4d";x.fillRect(0,0,800,450);'
                'x.fillStyle="#e07a3f";x.fillRect(800,0,800,450);'
                'x.fillStyle="#8fb37a";x.fillRect(0,450,800,450);'
                'x.fillStyle="#c94f4f";x.fillRect(800,450,800,450);'
                'x.fillStyle="#fff";x.font="bold 160px sans-serif";x.fillText("MOINK",560,520);'
                'var im=new Image();'
                'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"landscape.png"});};'
                'im.src=cv.toDataURL("image/png");})()',
    # 同一张横图，取景框转 18°：照片必须端正不动，只有框倾斜
    "croprot": '(function(){'
               'var cv=document.createElement("canvas");cv.width=1600;cv.height=900;'
               'var x=cv.getContext("2d");'
               'x.fillStyle="#e8ecf3";x.fillRect(0,0,1600,900);'
               'x.fillStyle="#2f3d4d";x.fillRect(0,0,800,450);'
               'x.fillStyle="#e07a3f";x.fillRect(800,0,800,450);'
               'x.fillStyle="#8fb37a";x.fillRect(0,450,800,450);'
               'x.fillStyle="#c94f4f";x.fillRect(800,450,800,450);'
               'x.fillStyle="#fff";x.font="bold 160px sans-serif";x.fillText("MOINK",560,520);'
               'var im=new Image();'
               'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"landscape.png"});'
               'setTimeout(function(){setRot(18);},500);};'
               'im.src=cv.toDataURL("image/png");})()',
    # 同一张横图，收起面板 = 看最终上屏效果（取景框内的部分应铺满相纸）
    "cropshow": '(function(){'
                'var cv=document.createElement("canvas");cv.width=1600;cv.height=900;'
                'var x=cv.getContext("2d");'
                'x.fillStyle="#e8ecf3";x.fillRect(0,0,1600,900);'
                'x.fillStyle="#2f3d4d";x.fillRect(0,0,800,450);'
                'x.fillStyle="#e07a3f";x.fillRect(800,0,800,450);'
                'x.fillStyle="#8fb37a";x.fillRect(0,450,800,450);'
                'x.fillStyle="#c94f4f";x.fillRect(800,450,800,450);'
                'x.fillStyle="#fff";x.font="bold 160px sans-serif";x.fillText("MOINK",560,520);'
                'var im=new Image();'
                'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"landscape.png"});'
                'setTimeout(function(){closeSheet();},600);};'
                'im.src=cv.toDataURL("image/png");})()',
    "dev":     'showView("dev")',                    # 设备设置页
    # 横图 → 整格转 90°：照片应立起来（竖），取景框不动
    "rot90":   '(function(){'
               'var cv=document.createElement("canvas");cv.width=1600;cv.height=900;'
               'var x=cv.getContext("2d");'
               'x.fillStyle="#e8ecf3";x.fillRect(0,0,1600,900);'
               'x.fillStyle="#2f3d4d";x.fillRect(0,0,800,450);'
               'x.fillStyle="#e07a3f";x.fillRect(800,0,800,450);'
               'x.fillStyle="#8fb37a";x.fillRect(0,450,800,450);'
               'x.fillStyle="#c94f4f";x.fillRect(800,450,800,450);'
               'x.fillStyle="#fff";x.font="bold 160px sans-serif";x.fillText("MOINK",560,520);'
               'var im=new Image();'
               'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"landscape.png"});'
               'setTimeout(function(){rotateQuarter(1);},500);};'
               'im.src=cv.toDataURL("image/png");})()',
    # 竖图 + 白边 → 收起面板：看最终上屏效果（照片四周应真的盖白，构图不变）
    "padshow": '(function(){'
               'var cv=document.createElement("canvas");cv.width=900;cv.height=1200;'
               'var x=cv.getContext("2d");'
               'x.fillStyle="#cdd8e4";x.fillRect(0,0,900,1200);'
               'x.fillStyle="#2f3d4d";x.fillRect(60,60,780,400);'
               'x.fillStyle="#e07a3f";x.beginPath();x.arc(450,720,190,0,7);x.fill();'
               'var im=new Image();'
               'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"demo.png"});'
               'setTimeout(function(){openTool("fx");'
               'pickLvl("fx","边框","白边");'
               'var pw=document.getElementById("padT");pw.value=110;'
               'pw.dispatchEvent(new Event("input"));'
               'setTimeout(function(){closeSheet();},250);},450);};'
               'im.src=cv.toDataURL("image/png");})()',
    # 横图 + 整格 90° → 收起面板：上屏预览必须和构图里看到的一致（照片是竖的）
    "rot90show": '(function(){'
               'var cv=document.createElement("canvas");cv.width=1600;cv.height=900;'
               'var x=cv.getContext("2d");'
               'x.fillStyle="#e8ecf3";x.fillRect(0,0,1600,900);'
               'x.fillStyle="#2f3d4d";x.fillRect(0,0,800,450);'
               'x.fillStyle="#e07a3f";x.fillRect(800,0,800,450);'
               'x.fillStyle="#8fb37a";x.fillRect(0,450,800,450);'
               'x.fillStyle="#c94f4f";x.fillRect(800,450,800,450);'
               'x.fillStyle="#fff";x.font="bold 160px sans-serif";x.fillText("MOINK",560,520);'
               'var im=new Image();'
               'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"landscape.png"});'
               'setTimeout(function(){rotateQuarter(1);closeSheet();},500);};'
               'im.src=cv.toDataURL("image/png");})()',
    "rot270":  '(function(){'
               'var cv=document.createElement("canvas");cv.width=1600;cv.height=900;'
               'var x=cv.getContext("2d");'
               'x.fillStyle="#e8ecf3";x.fillRect(0,0,1600,900);'
               'x.fillStyle="#2f3d4d";x.fillRect(0,0,800,450);'
               'x.fillStyle="#e07a3f";x.fillRect(800,0,800,450);'
               'x.fillStyle="#8fb37a";x.fillRect(0,450,800,450);'
               'x.fillStyle="#c94f4f";x.fillRect(800,450,800,450);'
               'x.fillStyle="#fff";x.font="bold 160px sans-serif";x.fillText("MOINK",560,520);'
               'var im=new Image();'
               'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"landscape.png"});'
               'setTimeout(function(){rotateQuarter(1);rotateQuarter(1);rotateQuarter(1);closeSheet();},500);};'
               'im.src=cv.toDataURL("image/png");})()',
    "padcrop": '(function(){'
               'var cv=document.createElement("canvas");cv.width=900;cv.height=1200;'
               'var x=cv.getContext("2d");'
               'x.fillStyle="#cdd8e4";x.fillRect(0,0,900,1200);'
               'x.fillStyle="#2f3d4d";x.fillRect(60,60,780,400);'
               'x.fillStyle="#e07a3f";x.beginPath();x.arc(450,720,190,0,7);x.fill();'
               'var im=new Image();'
               'im.onload=function(){adoptImg(im,cv.toDataURL("image/png"),{name:"demo.png"});'
               'setTimeout(function(){openTool("fx");'
               'pickLvl("fx","边框","白边");'
               'var pw=document.getElementById("padT");pw.value=110;'
               'pw.dispatchEvent(new Event("input"));'
               'setTimeout(function(){openTool("compose");},250);},450);};'
               'im.src=cv.toDataURL("image/png");})()',
    # 构图里的动作类三级选项：点一下就该真的转动 / 铺满
    "lvldir":  "(function(){var cv=document.createElement(\"canvas\");cv.width=1600;cv.height=900;var x=cv.getContext(\"2d\");x.fillStyle=\"#e8ecf3\";x.fillRect(0,0,1600,900);x.fillStyle=\"#2f3d4d\";x.fillRect(0,0,800,450);x.fillStyle=\"#e07a3f\";x.fillRect(800,0,800,450);x.fillStyle=\"#8fb37a\";x.fillRect(0,450,800,450);x.fillStyle=\"#c94f4f\";x.fillRect(800,450,800,450);x.fillStyle=\"#fff\";x.font=\"bold 160px sans-serif\";x.fillText(\"MOINK\",560,520);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"landscape.png\"});setTimeout(function(){pickLvl(\"compose\",\"\u7167\u7247\u65b9\u5411\",\"\u987a\u65f6\u9488 90\u00b0\");},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "lvlrot":  "(function(){var cv=document.createElement(\"canvas\");cv.width=1600;cv.height=900;var x=cv.getContext(\"2d\");x.fillStyle=\"#e8ecf3\";x.fillRect(0,0,1600,900);x.fillStyle=\"#2f3d4d\";x.fillRect(0,0,800,450);x.fillStyle=\"#e07a3f\";x.fillRect(800,0,800,450);x.fillStyle=\"#8fb37a\";x.fillRect(0,450,800,450);x.fillStyle=\"#c94f4f\";x.fillRect(800,450,800,450);x.fillStyle=\"#fff\";x.font=\"bold 160px sans-serif\";x.fillText(\"MOINK\",560,520);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"landscape.png\"});setTimeout(function(){pickLvl(\"compose\",\"\u89d2\u5ea6\u5fae\u8c03\",\"\u89d2\u5ea6\");setRot(12);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "lvladd":  "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"文字\",\"文字\");},460);};im.src=cv.toDataURL(\"image/png\");})()",
    # 二级 / 三级选项：一屏只露一个控件（顺便验证面板高度不跳）
    "lvlcolor": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"color\",\"\u57fa\u7840\",\"\u4eae\u5ea6\");},420);};im.src=cv.toDataURL(\"image/png\");})()",
    "lvlfx":    "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"\u6587\u5b57\",\"\u5b57\u4f53\");},420);};im.src=cv.toDataURL(\"image/png\");})()",
    "tplpanel": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"\u6a21\u677f\",\"\u7968\u636e\");},420);};im.src=cv.toDataURL(\"image/png\");})()",
    "tplshow":  "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"\u6a21\u677f\",\"\u7968\u636e\");setTimeout(closeSheet,260);},420);};im.src=cv.toDataURL(\"image/png\");})()",
    # 全量扫一遍：把四个工具的每个二级 / 三级选项都点一次，把异常打到屏幕顶部
    "sweep":   "(function(){var bad=[];window.onerror=function(m){bad.push(m);};[\"compose\",\"color\",\"fx\",\"save\"].forEach(function(t){openTool(t);var a=document.querySelectorAll(\"#l2bar b\");for(var i=0;i<a.length;i++){a[i].click();var b=document.querySelectorAll(\"#l3bar b\");for(var j=0;j<b.length;j++){try{b[j].click();}catch(e){bad.push(t+\":\"+e.message);}}}});var d=document.createElement(\"div\");d.style.cssText=\"position:fixed;left:0;right:0;top:0;z-index:9999;padding:8px;font:12px/1.4 monospace;background:#111;color:#0f0;white-space:pre-wrap\";d.textContent=(bad.length?(\"FAIL \"+bad.length+\"\\n\"+bad.join(\"\\n\")):\"SWEEP OK — 全部二级/三级选项点过一遍，无异常\");document.body.appendChild(d);})()",
    # R1.4.2：白边宽度滑块 / 贴纸选择与画布控件
    "txtrot":  "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"文字\",\"描边\");document.getElementById(\"txt\").value=\"MOINK 2026\";document.getElementById(\"objAdd\").click();setTimeout(function(){var r=document.getElementById(\"tRot\");r.value=30;r.dispatchEvent(new Event(\"input\"));},140);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "txtwrap": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"文字\",\"描边\");document.getElementById(\"txt\").value=\"2026 年 11 月 13 日 · 德阳\";document.getElementById(\"objAdd\").click();setTimeout(function(){var r=document.getElementById(\"tWrap\");r.value=260;r.dispatchEvent(new Event(\"input\"));},140);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "txtadd":  "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"文字\",\"文字\");},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "stylepane": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"color\",\"风格\",\"风格\");},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "tplpane":   "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"模板\",\"拍立得\");},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "stkup":     "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"贴纸\",\"上传图片\");},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "clickguard": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"g.png\"});setTimeout(function(){openTool(\"fx\");var r=document.getElementById(\"prevWrap\").getBoundingClientRect();[\"pointerdown\",\"pointerup\",\"click\"].forEach(function(t){document.getElementById(\"prevWrap\").dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));});setTimeout(function(){var d=document.createElement(\"div\");d.style.cssText=\"position:fixed;left:0;right:0;top:0;z-index:9999;padding:8px;font:13px/1.4 monospace;background:#111;color:#0f0\";d.textContent=\"panel after canvas click = \"+(document.getElementById(\"sheet\").dataset.panel||\"(none)\")+\" / stage view = \"+document.getElementById(\"stage\").dataset.view;document.body.appendChild(d);},400);},520);};im.src=cv.toDataURL(\"image/png\");})()",
    # 纯灰度 / 原色直出：没有强度参数，整行滑块收起
    "stylegray": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"color\",\"风格\",\"风格\");document.querySelector(\"#presets button[data-m=gray]\").click();},460);};im.src=cv.toDataURL(\"image/png\");})()",
    # 白边：解锁后四边各调（上窄下宽）
    "padfree":   "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"边框\",\"白边\");document.getElementById(\"padLock\").click();var a=document.getElementById(\"padT\");a.value=40;a.dispatchEvent(new Event(\"input\"));var b=document.getElementById(\"padB\");b.value=200;b.dispatchEvent(new Event(\"input\"));},460);};im.src=cv.toDataURL(\"image/png\");})()",
    # 贴纸：图标换红色 + 点一个图标
    "stkcolor":  "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"贴纸\",\"图标\");document.querySelectorAll(\"#stkColors .sw\")[1].click();document.querySelectorAll(\"#stkRow .stkCell\")[1].click();setTimeout(closeSheet,300);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    # 贴纸：表情（系统彩色，不选色）
    "stkemo":    "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"贴纸\",\"表情\");document.querySelectorAll(\"#stkEmo .stkCell\")[2].click();setTimeout(closeSheet,300);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "padw":    "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"边框\",\"白边\");var p=document.getElementById(\"padT\");p.value=96;p.dispatchEvent(new Event(\"input\"));},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "stk":     "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"贴纸\",\"图标\");},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "stkput":  "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"贴纸\",\"图标\");document.querySelectorAll(\"#stkRow .stkCell\")[2].click();setTimeout(closeSheet,320);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "stkpic": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"贴纸\",\"上传图片\");addStkImg(cv.toDataURL(\"image/png\"),0.75);setTimeout(closeSheet,320);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "emotext": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"贴纸\",\"表情\");document.querySelector(\"#stkEmo .stkCell.add\").click();setTimeout(function(){var el=document.getElementById(\"stkEmoIn\");el.value=\"\\u4f60\\u597dhello\\ud83d\\ude00\";el.dispatchEvent(new Event(\"input\"));},220);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "tplline": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"模板\",\"细边框\");setTimeout(closeSheet,260);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "tplpolaroid": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"模板\",\"拍立得\");setTimeout(closeSheet,260);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "tplpuzzle": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"模板\",\"拼图\");setTimeout(closeSheet,260);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "tplticket": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"模板\",\"票据\");setTimeout(closeSheet,260);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "tplfilm": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"模板\",\"胶片\");setTimeout(closeSheet,260);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "datedot": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"文字\",\"日期\");document.getElementById(\"dateAdd\").click();setTimeout(closeSheet,260);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "dateseg": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"文字\",\"日期\");var s=document.getElementById(\"dateStyle\");s.value=\"seg\";s.dispatchEvent(new Event(\"change\"));document.getElementById(\"dateAdd\").click();setTimeout(closeSheet,260);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "fontrow": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"文字\",\"字体\");document.getElementById(\"txt\").value=\"MOINK 2026\";document.getElementById(\"objAdd\").click();},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "txtdots": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"文字\",\"描边\");document.getElementById(\"txt\").value=\"MOINK 2026\";document.getElementById(\"objAdd\").click();setTimeout(function(){var s=document.getElementById(\"tStroke\");s.value=3;s.dispatchEvent(new Event(\"input\"));document.querySelectorAll(\"#rowStrokeC .sw\")[3].click();},160);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "stylecenter": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"color\",\"风格\",\"风格\");},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "emopop": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"贴纸\",\"表情\");document.querySelector(\"#stkEmo .stkCell.add\").click();},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "tapobj": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){document.getElementById(\"txt\").value=\"月是故乡明\";document.getElementById(\"objAdd\").click();closeSheet();setTimeout(function(){var el=document.querySelector(\"#objLayer .tobj\");var r=el.getBoundingClientRect();[\"pointerdown\",\"pointerup\",\"click\"].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));});},300);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "tapstk": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"fx\",\"贴纸\",\"图标\");document.querySelectorAll(\"#stkRow .stkCell\")[1].click();closeSheet();setTimeout(function(){var el=document.querySelector(\"#objLayer .tobj\");var r=el.getBoundingClientRect();[\"pointerdown\",\"pointerup\",\"click\"].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));});},300);},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "ditherrow": "(function(){var cv=document.createElement(\"canvas\");cv.width=900;cv.height=1200;var x=cv.getContext(\"2d\");x.fillStyle=\"#cdd8e4\";x.fillRect(0,0,900,1200);x.fillStyle=\"#2f3d4d\";x.fillRect(60,60,780,400);x.fillStyle=\"#e07a3f\";x.beginPath();x.arc(450,720,190,0,7);x.fill();x.fillStyle=\"#fff\";x.font=\"bold 86px sans-serif\";x.fillText(\"MOINK\",250,1080);var im=new Image();im.onload=function(){adoptImg(im,cv.toDataURL(\"image/png\"),{name:\"demo.png\"});setTimeout(function(){pickLvl(\"color\",\"抖动\",\"方式\");},460);};im.src=cv.toDataURL(\"image/png\");})()",
    "notebg": "setMode(1);pickLvl(\"fx\",\"文字\",\"底色\");",
    "ctx":     '(function(){'
               'var g=document.getElementById("galGrid");'
               'g.innerHTML=\'<div class="galCell cur sel" data-slot="0">'
               '<span class="num">1</span><span class="tick">\u2713</span></div>\';'
               'openTool("save");openCtx(0);})()',
}

# 截图脚本里点选项条的辅助函数：按「文字」找二级 / 三级选项，不依赖内部下标
HELPER = ('function pickLvl(t,a,b){openTool(t);'
          'var f=function(sel,txt){var n=document.querySelectorAll(sel+" b");'
          'for(var i=0;i<n.length;i++){if(n[i].textContent===txt)return n[i];}return null;};'
          'var x=f("#l2bar",a);if(x)x.click();'
          'if(b){var y=f("#l3bar",b);if(y)y.click();}};')

FRAME = u"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
html,body{{margin:0;background:#c9c3b8}}
iframe{{width:{w}px;height:{h}px;border:0;display:block}}
</style></head><body>
<iframe id="f" src="index.dev.html"></iframe>
<script>
document.getElementById("f").addEventListener("load", function(){{
  var w = this.contentWindow, st = {helper} + {state};
  if (!st) return;
  try {{ w.eval(st); }} catch(e) {{ document.title = "ERR " + e.message; }}
}});
</script>
</body></html>
"""


def find_edge():
    for p in EDGE_CANDIDATES:
        if os.path.isfile(p):
            return p
    raise SystemExit("找不到 Edge/Chrome，手动改 EDGE_CANDIDATES")


def main():
    args = [a for a in sys.argv[1:] if a]
    if "--list" in args:
        print("\n".join(STATES))
        return 0

    only = args[0] if args else None
    if only and only not in STATES:
        raise SystemExit("没有这个状态：%s（用 --list 看全部）" % only)

    edge = find_edge()
    tmp = os.path.join(PAGE, "_frame.html")
    rc = 0
    for name, code in STATES.items():
        if only and name != only:
            continue
        with io.open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(FRAME.format(w=VIEW_W, h=VIEW_H, helper=json.dumps(HELPER), state=json.dumps(code)))
        out = os.path.join(PAGE, "_v_%s.png" % name)
        subprocess.call([
            edge, "--headless=new", "--disable-gpu",
            "--allow-file-access-from-files",      # 否则没法 eval 进 iframe
            "--force-device-scale-factor=1",
            "--hide-scrollbars",
            "--virtual-time-budget=4000",          # 等首帧 + 面板动画 + Cropper 解码
            "--window-size=%d,%d" % (VIEW_W + PAD_W, VIEW_H + PAD_H),
            "--screenshot=" + out,
            "file:///" + tmp.replace("\\", "/"),
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ok = os.path.exists(out)
        print("%-8s %s" % (name, ("%d B" % os.path.getsize(out)) if ok else "失败"))
        rc = rc or (0 if ok else 1)

    if os.path.exists(tmp):
        os.remove(tmp)
    print("图在 page/_v_<state>.png")
    return rc


if __name__ == "__main__":
    sys.exit(main())
