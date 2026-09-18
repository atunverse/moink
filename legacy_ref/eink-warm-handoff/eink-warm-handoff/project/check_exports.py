# -*- coding: utf-8 -*-
"""Independently re-decode every file the browser exported and cross-compare.

The browser writes these with hand-rolled encoders (a 4-bit indexed PNG and a
2bpp RAW packer), so PIL is used as an independent judge: whatever PIL reads
back must agree with the plain RGB PNG pixel for pixel.

Usage:
    python check_exports.py                 # newest of each export kind
    python check_exports.py odd-750x502     # only files whose name contains this
"""
import glob
import os
import sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DOWN = os.path.join(HERE, "downloads")
PAL = {(0, 0, 0): "黑", (255, 255, 255): "白", (255, 0, 0): "红", (255, 255, 0): "黄"}
LUT = np.array([[0, 0, 0], [255, 255, 255], [255, 0, 0], [255, 255, 0]], dtype=np.uint8)
TAG = sys.argv[1] if len(sys.argv) > 1 else ""

fail = []
missing = []


def one(kind):
    pat = os.path.join(DOWN, kind + "__*" + TAG + "*") if TAG else os.path.join(DOWN, kind + "__*")
    hits = sorted(glob.glob(pat), key=os.path.getmtime)
    if not hits:
        missing.append(kind)
        return None
    return hits[-1]


def describe(arr):
    n = arr.shape[0] * arr.shape[1]
    uniq, cnt = np.unique(arr.reshape(-1, 3), axis=0, return_counts=True)
    on = sum(c for u, c in zip(uniq, cnt) if tuple(int(v) for v in u) in PAL)
    chroma = sum(c for u, c in zip(uniq, cnt)
                 if tuple(int(v) for v in u) in ((255, 0, 0), (255, 255, 0))) / n
    return len(uniq), on / n, chroma, uniq, cnt


print("=" * 78)
print("导出文件独立校验" + ("   过滤: %s" % TAG if TAG else ""))
print("=" * 78)

# ---------------------------------------------------------------- baseline
ref_path = one("png-4color")
if ref_path is None:
    raise SystemExit("找不到基准文件（png-4color）—— 请先跑 test_e2e.py 或 test_edge.py")
ref_im = Image.open(ref_path)
ref = np.asarray(ref_im.convert("RGB"))
W, H = ref_im.size
print("\n[基准] %s" % os.path.basename(ref_path))
print("  %d bytes | PIL: %s %s %dx%d" % (os.path.getsize(ref_path), ref_im.format,
                                         ref_im.mode, W, H))
n_u, on, chroma, uniq, cnt = describe(ref)
print("  颜色种类 %d | 调色板内 %.2f%% | 红+黄 %.1f%%" % (n_u, on * 100, chroma * 100))
print("  " + "  ".join("%s %.1f%%" % (PAL[tuple(u)], c / (W * H) * 100)
                       for u, c in sorted(zip(uniq.tolist(), cnt.tolist()), key=lambda t: -t[1])))
if n_u != 4 or on != 1.0:
    fail.append("4color PNG 不是纯四色（%d 种颜色）" % n_u)

# ---------------------------------------------------------------- indexed PNG
f = one("png-indexed")
if f:
    im = Image.open(f)
    idx_arr = np.asarray(im.convert("RGB"))
    pal = im.getpalette() or []
    tbl = [tuple(pal[i * 3:i * 3 + 3]) for i in range(len(pal) // 3)]
    print("\n[四色索引 PNG] %s" % os.path.basename(f))
    print("  %d bytes | PIL: 格式=%s 模式=%s 尺寸=%sx%s" % (os.path.getsize(f), im.format,
                                                           im.mode, im.size[0], im.size[1]))
    print("  调色板 %d 项: %s" % (len(tbl), tbl))
    print("  与基准逐像素一致: %s" % np.array_equal(idx_arr, ref))
    if im.mode != "P":
        fail.append("索引 PNG 未被 PIL 识别为调色板模式（%s）" % im.mode)
    if im.size != (W, H):
        fail.append("索引 PNG 尺寸 %s != %s" % (im.size, (W, H)))
    if not np.array_equal(idx_arr, ref):
        fail.append("索引 PNG 解出的图像与基准不一致")
    if len(tbl) < 4 or set(tbl[:4]) != set(PAL):
        fail.append("索引 PNG 调色板不是四种墨水屏颜色: %s" % tbl)

# ---------------------------------------------------------------- BMP
f = one("bmp")
if f:
    im = Image.open(f)
    bmp = np.asarray(im.convert("RGB"))
    print("\n[BMP] %s" % os.path.basename(f))
    print("  %d bytes | PIL: %s %s %sx%s" % (os.path.getsize(f), im.format, im.mode,
                                             im.size[0], im.size[1]))
    print("  与基准逐像素一致: %s" % np.array_equal(bmp, ref))
    if not np.array_equal(bmp, ref):
        fail.append("BMP 与基准不一致")

# ---------------------------------------------------------------- RAW 2bpp
f = one("raw")
if f:
    data = np.fromfile(f, dtype=np.uint8)
    stride = (W + 3) // 4
    expect = stride * H
    print("\n[RAW 2bpp] %s" % os.path.basename(f))
    print("  %d bytes | 期望 %d (%d B/行 x %d 行)，每行 %d 像素（%s）"
          % (len(data), expect, stride, H, W, "整除 4" if W % 4 == 0 else "余 %d，末字节半填" % (W % 4)))
    if len(data) != expect:
        fail.append("RAW 长度 %d != %d" % (len(data), expect))
    else:
        bits = np.unpackbits(data.reshape(-1, 1), axis=1).reshape(-1)
        idx = (bits.reshape(-1, 2)[:, 0] * 2 + bits.reshape(-1, 2)[:, 1]).reshape(H, stride * 4)
        idx = idx[:, :W]
        print("  解包索引范围 %d..%d | 与基准一致: %s"
              % (idx.min(), idx.max(), np.array_equal(LUT[idx], ref)))
        if not np.array_equal(LUT[idx], ref):
            fail.append("RAW 解包结果与基准不一致")

# ---------------------------------------------------------------- dither-only
f = one("dither-only")
if f:
    d_only = np.asarray(Image.open(f).convert("RGB"))
    n_u2, on2, chroma2, _, _ = describe(d_only)
    diff = int((d_only != ref).any(axis=2).sum())
    print("\n[仅抖动图（无色转）] %s" % os.path.basename(f))
    print("  %d bytes | 颜色种类 %d | 调色板内 %.2f%% | 红+黄 %.1f%%"
          % (os.path.getsize(f), n_u2, on2 * 100, chroma2 * 100))
    print("  与「暖色映射后」不同的像素: %d (%.1f%%)" % (diff, diff / (W * H) * 100))
    if n_u2 != 4 or on2 != 1.0:
        fail.append("仅抖动图不是纯四色")

# ---------------------------------------------------------------- continuous
f = one("flat-continuous")
if f:
    flat = np.asarray(Image.open(f).convert("RGB"))
    n_u3, on3, chroma3, _, _ = describe(flat)
    print("\n[连续调彩图（未抖动）] %s" % os.path.basename(f))
    print("  %d bytes | 颜色种类 %d | 恰好落在调色板上的像素 %.2f%%"
          % (os.path.getsize(f), n_u3, on3 * 100))
    if n_u3 < 1000:
        fail.append("连续调彩图颜色种类只有 %d，不是连续调" % n_u3)

print("\n" + "=" * 78)
if missing:
    print("跳过（本次未生成）: %s" % ", ".join(missing))
if fail:
    print("结论: 存在问题 ❌")
    for m in fail:
        print("   -", m)
    sys.exit(1)
print("结论: 导出文件全部通过独立解码校验 ✅")
sys.exit(0)
