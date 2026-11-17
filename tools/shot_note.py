#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""六种便签版式的四色离线总览（真 renderTo 输出，不是示意图）。

用法：python tools/shot_note.py [tag]
输出：page/_t_note.png（3×2，每张 552×768 真机尺寸缩到 52%）
"""
import io
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shot_tpl as S

STATE = r"""
(function(){
  setMode(1, true);
  var names = { todo:"待办清单", memo:"备忘挂件", cornell:"康奈尔笔记",
                kanban:"看板", poster:"纯文字画报", dark:"票根挂件 · 墨黑" };
  var tiles = [];
  for (var i = 0; i < NOTE_LAYOUT_ORDER.length; i++){
    var k = NOTE_LAYOUT_ORDER[i], d = noteDoc();
    d.layout = k;
    d.theme = (k === "dark") ? "ink" : "paper";
    d.tok = null; d.cols = 3; d.scale = 1; d.density = "normal";
    d.raw = NOTE_SAMPLE[k];
    noteSyncBlocks();
    var cv = document.createElement("canvas");
    renderTo(cv, EW, EH);
    tiles.push({ name:names[k], cv:cv });
  }
  montage(tiles);
})()
"""

# montage: 3 列 × 0.52，单格 287×399，标题 26，间距 12
W = 3 * (287 + 12) + 12
H = 2 * (399 + 26 + 12) + 12


SINGLE = r"""
(function(){
  setMode(1, true);
  var d = noteDoc();
  d.layout = __L__; d.theme = __T__; d.tok = null;
  d.cols = 3; d.scale = 1; d.density = "normal";
  d.raw = NOTE_SAMPLE[__L__]; noteSyncBlocks();
  var cv = document.createElement("canvas");
  renderTo(cv, EW, EH);
  document.body.innerHTML = "";
  document.body.style.margin = "0";
  cv.style.display = "block";
  document.body.appendChild(cv);
})()
"""


def single(layout, theme):
    """1:1 真机尺寸单格图：确认小字在 552×768 下真的清楚，不受总览缩放影响。"""
    state = SINGLE.replace("__L__", json.dumps(layout)).replace("__T__", json.dumps(theme))
    tmp = os.path.join(S.PAGE, "_noteone.html")
    io.open(tmp, "w", encoding="utf-8", newline="\n").write(
        S.FRAME.format(w=552, h=768, montage=json.dumps(""), state=json.dumps(state)))
    out = os.path.join(S.PAGE, "_n_%s.png" % layout)
    subprocess.call([S.find_edge(), "--headless=new", "--disable-gpu",
                     "--allow-file-access-from-files",
                     "--force-device-scale-factor=1", "--hide-scrollbars",
                     "--virtual-time-budget=9000", "--window-size=552,768",
                     "--screenshot=" + out,
                     "file:///" + tmp.replace("\\", "/")],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.path.exists(tmp):
        os.remove(tmp)
    print("%s  %s" % (out, ("%d B" % os.path.getsize(out)) if os.path.exists(out) else "失败"))
    return out


def main():
    args = sys.argv[1:]
    if args and args[0] == "single":
        layout = args[1] if len(args) > 1 else "todo"
        theme = args[2] if len(args) > 2 else ("ink" if layout == "dark" else "paper")
        single(layout, theme)
        return 0
    tag = args[0] if args else "note"
    tmp = os.path.join(S.PAGE, "_noteframe.html")
    io.open(tmp, "w", encoding="utf-8", newline="\n").write(
        S.FRAME.format(w=W, h=H, montage=json.dumps(S.MONTAGE), state=json.dumps(STATE)))
    out = os.path.join(S.PAGE, "_t_%s.png" % tag)
    edge = S.find_edge()
    subprocess.call([edge, "--headless=new", "--disable-gpu",
                     "--allow-file-access-from-files",
                     "--force-device-scale-factor=1", "--hide-scrollbars",
                     "--virtual-time-budget=9000",
                     "--window-size=%d,%d" % (W, H),
                     "--screenshot=" + out,
                     "file:///" + tmp.replace("\\", "/")],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.path.exists(tmp):
        os.remove(tmp)
    print("%s  %s" % (out, ("%d B" % os.path.getsize(out)) if os.path.exists(out) else "失败"))
    return out


if __name__ == "__main__":
    main()
