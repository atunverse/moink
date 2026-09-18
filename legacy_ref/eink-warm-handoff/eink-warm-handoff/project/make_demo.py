# -*- coding: utf-8 -*-
"""Build the final demonstration sheet + device-ready sample images.

Row 1 is a warm photo (beige bedding, pale skin tones) and row 2 a cold one.
The point of the sheet is the contrast between "原样抖动" and "自然暖调":
warm content gains red/yellow, cold content is left neutral instead of being
dragged into the warm band.
"""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import eink_warm as ew

# 华为 nova14 墨水屏手机壳 A0 屏
PANEL = (768, 552)
SHOW = (384, 276)           # half-size tiles keep the sheet readable

PHOTOS = [("samples/q19.jpg", "暖调照片 · 米色织物（低饱和暖色）"),
          ("samples/p7.jpg", "冷调照片 · 海滩（几乎全冷色相）")]

COLS = [("原始照片", None),
        ("原样四色抖动（未处理）", dict(mode="naive")),
        ("自然暖调（默认 · 保留观感）", dict(mode="natural")),
        ("全面暖色映射（红黄主导）", dict(mode="adaptive"))]

FONT = None
for cand in ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc",
             "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simsun.ttc"]:
    if os.path.exists(cand):
        FONT = cand
        break


def font(size):
    if FONT:
        try:
            return ImageFont.truetype(FONT, size)
        except Exception:
            pass
    return ImageFont.load_default()


def render(path):
    """cover-fit the photo into the panel and give back a uint8 array."""
    return ew.resize_rgb(np.asarray(Image.open(path).convert("RGB")),
                         PANEL[0], PANEL[1], fit="cover")


def build_sheet():
    cw, ch = SHOW
    gap, pad, top, cap = 16, 20, 118, 52
    w = pad * 2 + cw * len(COLS) + gap * (len(COLS) - 1)
    h = top + len(PHOTOS) * (ch + cap + gap) + pad
    sheet = Image.new("RGB", (w, h), (250, 248, 245))
    d = ImageDraw.Draw(sheet)

    d.text((pad, 20), "四色墨水屏（黑/白/红/黄）转换效果对比 · 768×552",
           font=font(24), fill=(36, 31, 26))
    d.text((pad, 56), "自然暖调只提亮本来就偏暖的色调，偏蓝的区域保持中性——冷调照片不会被强行染成橙红。",
           font=font(15), fill=(126, 116, 106))

    for ci, (name, _) in enumerate(COLS):
        x = pad + ci * (cw + gap)
        col = (198, 68, 26) if ci in (1, 2, 3) else (112, 102, 92)
        d.text((x, top - 30), name, font=font(16), fill=col)

    print("%-34s %s" % ("照片 / 模式", "  ".join("%-13s" % c[0][:10] for c in COLS)))
    for ri, (path, label) in enumerate(PHOTOS):
        src = render(path)
        y = top + ri * (ch + cap + gap)
        d.text((pad, y - 24), label, font=font(16), fill=(58, 50, 42))
        stats = []
        for ci, (_, cfg) in enumerate(COLS):
            x = pad + ci * (cw + gap)
            if cfg is None:
                tile = Image.fromarray(src).resize(SHOW, Image.LANCZOS)
                sheet.paste(tile, (x, y))
                d.rectangle([x - 1, y - 1, x + cw, y + ch], outline=(220, 212, 202))
                d.text((x + 2, y + ch + 10), "连续调原图", font=font(14), fill=(150, 140, 130))
                stats.append(None)
                continue
            full = dict(ew.DEFAULTS)
            full.update(cfg)
            mapped = ew.warm_map(src, full)
            idx = ew.dither(mapped, full["dither"], full["ditherStrength"])
            st = ew.stats_from_index(idx)
            stats.append(st)
            tile = Image.fromarray(ew.index_to_rgb(idx)).resize(SHOW, Image.NEAREST)
            sheet.paste(tile, (x, y))
            d.rectangle([x - 1, y - 1, x + cw, y + ch], outline=(220, 212, 202))
            line1 = "红+黄 %.1f%%" % (st["chroma"] * 100)
            line2 = "红 %.1f%%  黄 %.1f%%  黑+白 %.1f%%" % (
                st["red"] * 100, st["yellow"] * 100, st["bw"] * 100)
            # 冷色照片本来就没有红黄，标灰而不是标红：那不是缺陷。
            if st["chroma"] < 0.06:
                c1 = (122, 112, 102)
            elif st["chroma"] > 0.55:
                c1 = (176, 40, 25)      # 过饱和，画面被红黄吃掉
            else:
                c1 = (28, 108, 58)
            d.text((x + 2, y + ch + 8), line1, font=font(15), fill=c1)
            d.text((x + 2, y + ch + 27), line2, font=font(13), fill=(140, 130, 120))
        print("%-34s %s" % (label,
                            "  ".join("%-13s" % ("-" if s is None else "%.1f%%" % (s["chroma"] * 100))
                                      for s in stats)))

    out = os.path.join(HERE, "效果对比样张.png")
    sheet.save(out)
    print("saved", out, sheet.size)


def build_samples():
    for path, _ in PHOTOS:
        tag = os.path.basename(path).split(".")[0]
        src = render(path)
        for mname in ("natural", "adaptive"):
            cfg = dict(ew.DEFAULTS, mode=mname)
            idx = ew.dither(ew.warm_map(src, cfg), cfg["dither"], cfg["ditherStrength"])
            name = "样张_%s_%s_768x552_四色.png" % (tag, mname)
            Image.fromarray(ew.index_to_rgb(idx)).save(os.path.join(HERE, name))
            print("saved", name)


if __name__ == "__main__":
    build_sheet()
    build_samples()
