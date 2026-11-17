#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 page/src/ 下的模块合并成单文件页面，一次产出两份（内容相同、用途不同）。

    page/index.dev.html   测试/源码页：原样保留全部注释与缩进，门禁、截图、
                          本地调试一律用它。check_algo.py 逐字比对的算法段
                          也只有在这一份里才是完整的。
    page/index.html       成品页：零注释 + 紧凑，供 tools/make_index_header.py
                          内嵌进 src/index_html.h（合并进固件）—— R1.4.0 起这是控制页的唯一来源。

固件只认单个 HTML（内嵌 gzip），所以开发期分模块、
发布前合并。**源码 page/src/ 永远保留注释**，压缩只发生在成品产物上。

用法：
    python page/build.py             # 两份都写
    python page/build.py --dev-only  # 只写测试页（--raw 同义，调试时用）
    python page/build.py --check     # 只校验，不写文件

校验内容：
    1. JS 里 $("id") / getElementById("id") 引用的元素，HTML 里必须存在
       （动态生成的 o-* / d-* 除外，它们都有 null 保护）
    2. HTML 里的 id 有重复就报错
    3. 成品页必须零注释、保留 use strict / var $ = function 两个锚点
    4. 输出体积

★ 压缩只做三件绝对安全的事：去掉 <!-- --> 与 /* */ 注释、去掉每行首尾空白
  与空行。不改名、不并行、不动字符串，JS 自动分号插入所需的换行原样保留。
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "src")
VENDOR = os.path.join(HERE, "vendor")
OUT_PROD = os.path.join(HERE, "index.html")
OUT_DEV = os.path.join(HERE, "index.dev.html")

# 合并顺序 = 依赖顺序。脚本之间共享同一个全局作用域，
# 函数声明会提升，但顶层 var 赋值按顺序执行，所以被依赖的必须在前。
JS_ORDER = [
    "10-core.js",       # 常量、几何、$
    "11-algo.js",       # 图像算法【冻结】
    "12-render.js",     # 合成与实时重绘
    "13-pack.js",       # 2bpp 打包 / 帧头
    "20-state.js",      # DOM 句柄、配置持久化
    "21-preview.js",    # 预览调度
    "30-crop.js",       # 裁剪
    "31-pick.js",       # 选图
    "32-style.js",      # 风格参数
    "33-text.js",       # 文字对象
    "34-tpl.js",        # 特效模板（六种蒙版，现场绘制）
    "35-date.js",       # 日期控件（点阵 / 数码管 / 普通）
    "36-note.js",       # 便签：文档模型 / 四色主题 / 六种版式
    "37-note-ui.js",    # 便签面板接线
    "40-upload.js",     # 上传
    "41-gallery.js",    # 图槽
    "50-ui.js",         # 界面控制层
    "60-device.js",     # 设备设置
    "61-ota.js",        # 升级
    "70-boot.js",       # 启动（必须最后）
]

CSS_ORDER = [
    ("src", "01-style.css"),
]

# 动态生成 / 有 null 保护的 id 前缀
ID_EXEMPT_RE = re.compile(r"^(o-|d-)")

PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="moink-page-version" content="{ver}">
<meta name="theme-color" content="#faf7f2">
<title>墨印 · MoInk</title>
<style>
{css}
</style>
</head>
<body>

{body}

<script>
{js}
</script>

<script>
{foot}
</script>
</body>
</html>
"""

FOOTER_DEV = """/* 页脚版本：从 meta 读，避免版本号写两遍 */
(function(){{
  var m = document.querySelector('meta[name="moink-page-version"]');
  var e = document.getElementById("footVer");
  if (m && m.content && e) e.textContent = " · 版本 " + m.content;
}})();"""

FOOTER_PROD = """(function(){{
  var m = document.querySelector('meta[name="moink-page-version"]');
  var e = document.getElementById("footVer");
  if (m && m.content && e) e.textContent = " · 版本 " + m.content;
}})();"""


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def strip_comments(s):
    """去掉 /* */ 注释，保护引号字符串。本工程 JS 不用 // 行注释：
    // 只出现在字符串（http://、file://）与正则（/^image\\//）里，原样保留。
    多行注释换成等量换行，单行注释换成一个空格，避免把两个 token 粘起来。"""
    out = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c in ('"', "'", '`'):
            q = c
            out.append(c)
            i += 1
            while i < n:
                ch = s[i]
                out.append(ch)
                if ch == "\\" and i + 1 < n:
                    out.append(s[i + 1])
                    i += 2
                    continue
                i += 1
                if ch == q:
                    break
            continue
        if c == "/" and i + 1 < n and s[i + 1] == "*":
            j = s.find("*/", i + 2)
            j = n if j < 0 else j + 2
            seg = s[i:j]
            out.append("\n" * seg.count("\n") if "\n" in seg else " ")
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


def compact_lines(s):
    """逐行去首尾空白、删空行。保留每个换行 = 保留 JS 的 ASI 语义。"""
    return "\n".join(x for x in (ln.strip() for ln in s.split("\n")) if x)


def slim(s):
    return compact_lines(strip_comments(s))


def slim_body(s):
    """HTML 正文：去注释 + 压行。正文没有 <pre> / 非空 textarea / <script>，
    行首缩进不属于任何文本内容，去掉不影响渲染与 textContent。"""
    return compact_lines(re.sub(r"<!--.*?-->", "", s, flags=re.S))


def version():
    txt = read(os.path.join(ROOT, "src", "version.h"))
    m = re.search(r'#define\s+MOINK_VERSION\s+"([^"]+)"', txt)
    if not m:
        raise SystemExit("version.h 里找不到 MOINK_VERSION")
    return m.group(1)


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def main():
    check_only = "--check" in sys.argv
    dev_only = ("--dev-only" in sys.argv) or ("--raw" in sys.argv)

    body = read(os.path.join(SRC, "02-body.html")).rstrip()

    css_parts = []
    for where, name in CSS_ORDER:
        p = os.path.join(VENDOR if where == "vendor" else SRC, name)
        css_parts.append("/* ==== %s ==== */\n%s" % (name, read(p).strip()))
    css = "\n\n".join(css_parts)

    js_parts = []
    for name in JS_ORDER:
        p = os.path.join(SRC, name)
        if not os.path.isfile(p):
            raise SystemExit("缺少模块：%s" % name)
        js_parts.append(read(p).strip())
    js = "\n\n".join(js_parts)

    # ---------- 两份产物 ----------
    ver = version()
    html_dev = PAGE.format(ver=ver, css=css, body=body, js=js, foot=FOOTER_DEV)

    css_prod = slim(css)
    js_prod = "\n\n".join(slim(code) for code in js_parts)
    body_prod = slim_body(body)
    html_prod = PAGE.format(ver=ver, css=css_prod, body=body_prod,
                            js=js_prod, foot=FOOTER_PROD)

    # ---------- 校验 ----------
    html_ids = re.findall(r'\bid="([A-Za-z0-9_-]+)"', body)
    dup = {i for i in html_ids if html_ids.count(i) > 1}
    errors = []
    if dup:
        errors.append("HTML 里 id 重复：" + "、".join(sorted(dup)))

    used = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', js))
    used |= set(re.findall(r'getElementById\("([A-Za-z0-9_-]+)"\)', js))
    missing = sorted(
        u for u in used
        if u not in html_ids and not ID_EXEMPT_RE.match(u)
    )
    if missing:
        errors.append("JS 引用了 HTML 中不存在的 id：" + "、".join(missing))

    html_set = set(html_ids)
    unused = sorted(
        i for i in html_set
        if i not in used and not ID_EXEMPT_RE.match(i)
    )

    # 成品页必须一个注释都不剩；两个锚点是 smoke_page.js 切脚本的依据
    # 注意：正文里 accept="image/*" / "font/*" 是 MIME 通配符，不是注释，
    # 所以只能查成对的 /* ... */ 与 <!-- ... -->，不能查裸 "/*"。
    block = re.compile(r"/\*[\s\S]*?\*/")
    errors += [e for e in [
        "成品页仍有 HTML 注释" if "<!--" in html_prod else "",
        "成品页仍有块注释" if (block.search(css_prod) or block.search(js_prod)
                            or block.search(body_prod) or block.search(FOOTER_PROD)) else "",
        "成品页主脚本首行丢了 use strict" if not js_prod.startswith('"use strict";') else "",
        "成品页 DOM 段锚点丢了" if "var $ = function" not in js_prod else "",
        "测试页丢了注释（不应压缩）" if not block.search(html_dev) else "",
    ] if e]

    size_prod = len(html_prod.encode("utf-8"))
    size_dev = len(html_dev.encode("utf-8"))
    print("页面版本   %s" % ver)
    print("模块       JS %d 个 / CSS %d 个" % (len(JS_ORDER), len(CSS_ORDER)))
    print("测试页     %d B (%.1f KB)  保留注释 → index.dev.html" % (size_dev, size_dev / 1024))
    print("成品页     %d B (%.1f KB)  零注释   → index.html" % (size_prod, size_prod / 1024))
    print("省下       %d B (%.1f KB)" % (size_dev - size_prod, (size_dev - size_prod) / 1024))
    if unused:
        print("提示       以下 id 没有任何 JS 引用（可能多余）：%s" % "、".join(unused))

    if errors:
        print("\n校验失败：")
        for e in errors:
            print("  ✗ " + e)
        return 1
    print("校验       PASS（成品页零注释 / 测试页保留注释）")

    if check_only:
        print("（--check 模式，未写文件）")
        return 0

    write_atomic(OUT_DEV, html_dev)
    print("已写入     %s" % OUT_DEV)
    if not dev_only:
        write_atomic(OUT_PROD, html_prod)
        print("已写入     %s" % OUT_PROD)
    return 0


if __name__ == "__main__":
    sys.exit(main())
