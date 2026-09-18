#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_algo.py —— 验证「图像算法冻结」：M7 页面与新页面的核心算法函数必须逐字一致。

重构要求把 eink-warm 算法原样搬入（用户明确要求锁定不改）。本脚本从
    eink-frame/src/index.html   （旧 M7 页，已上机验证）
    page/index.html             （新页）
各抽取一遍核心算法函数体，规范化空白后逐函数比对，任一不一致即 FAIL。

用法：python tools/check_algo.py   （要求 moink/ 与 eink-frame/ 同级）
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OLD = os.path.join(os.path.dirname(ROOT), "eink-frame", "src", "index.html")
NEW = os.path.join(ROOT, "page", "index.html")

# 核心算法函数（含支撑函数）。这些必须原样保留。
# 注：drawCropInto 已于 page R1.0.12 按设计退役（裁剪改由内嵌 Cropper.js 的
#     getCroppedCanvas 供图），不再属于冻结比对范围。
FUNCS = [
    "s2l", "l2s", "rampLut", "rgb2hsl", "hue2rgb", "hsl2rgb", "warmAffinity",
    "autoLevels", "blur3", "warmMap", "quantize", "packIdx",
]


def script_of(path):
    s = open(path, encoding="utf-8").read()
    m = re.search(r"<script>\n(.*)\n</script>", s, re.S)
    return m.group(1)


def extract_fn(js, name):
    m = re.search(r"function\s+%s\s*\(" % re.escape(name), js)
    if not m:
        return None
    i = js.index("{", m.start())
    depth = 0
    j = i
    while j < len(js):
        c = js[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return js[m.start():j + 1]
        j += 1
    return None


def norm(s):
    # 去除全部空白做语义比对（本组函数无含空格的字符串字面量，安全）
    return re.sub(r"\s+", "", s)


def main():
    if not os.path.exists(OLD):
        print("SKIP: reference M7 page not found at", OLD)
        return 0
    old_js = script_of(OLD)
    new_js = script_of(NEW)

    ok = True
    for fn in FUNCS:
        a = extract_fn(old_js, fn)
        b = extract_fn(new_js, fn)
        if a is None or b is None:
            print("MISS  %-16s (old=%s new=%s)" % (fn, a is not None, b is not None))
            ok = False
            continue
        if norm(a) == norm(b):
            print("MATCH %-16s" % fn)
        else:
            print("DIFF  %-16s" % fn)
            ok = False

    print("RESULT:", "MATCH" if ok else "DIFF")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
