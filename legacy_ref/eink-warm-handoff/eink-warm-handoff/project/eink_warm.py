# -*- coding: utf-8 -*-
"""
4-color e-ink warm-tone converter -- reference implementation (numpy).

Pipeline
--------
  tone(brightness/contrast/gamma) -> autolevels -> unsharp
  -> warm mapping (hue-squeeze into the red-yellow band, or gradient-map)
  -> chroma shaping
  -> error-diffusion dither onto {black, white, red, yellow}

This file is the source of truth; the browser tool in
`eink-warm-converter.html` is a line-by-line port of it, and
`verify_vs_js.py` checks the two agree pixel for pixel.
"""

import numpy as np

# ---------------------------------------------------------------- palette
K, W, R, Y = 0, 1, 2, 3  # black, white, red, yellow
PALETTE = np.array(
    [[0.0, 0.0, 0.0], [255.0, 255.0, 255.0], [255.0, 0.0, 0.0], [255.0, 255.0, 0.0]],
    dtype=np.float64,
)

# ---------------------------------------------------------------- ramps
# Every ramp is monotonic in luminance and lives entirely inside the
# red-orange-yellow band, i.e. inside the gamut the panel can actually reach.
RAMPS = {
    "sunset": [
        (0.00, (0, 0, 0)),
        (0.10, (26, 6, 4)),
        (0.26, (92, 18, 12)),
        (0.42, (168, 40, 16)),
        (0.56, (214, 86, 18)),
        (0.70, (236, 140, 26)),
        (0.84, (248, 200, 60)),
        (0.93, (255, 235, 150)),
        (1.00, (255, 255, 255)),
    ],
    "ember": [
        (0.00, (0, 0, 0)),
        (0.12, (40, 4, 0)),
        (0.28, (120, 10, 4)),
        (0.44, (196, 28, 6)),
        (0.58, (232, 74, 6)),
        (0.72, (246, 140, 10)),
        (0.86, (252, 204, 26)),
        (0.95, (255, 240, 110)),
        (1.00, (255, 255, 255)),
    ],
    "duotone": [
        (0.00, (0, 0, 0)),
        (0.30, (150, 20, 10)),
        (0.55, (235, 80, 10)),
        (0.78, (250, 190, 20)),
        (1.00, (255, 255, 255)),
    ],
    "sepia": [
        (0.00, (22, 14, 8)),
        (0.25, (92, 66, 38)),
        (0.50, (150, 116, 72)),
        (0.72, (202, 172, 124)),
        (0.88, (232, 212, 172)),
        (1.00, (255, 250, 236)),
    ],
}

_MODES = ["natural", "adaptive", "sunset", "ember", "duotone", "sepia", "gray", "naive"]

DEFAULTS = {
    # natural | adaptive | sunset | ember | duotone | sepia | gray | naive
    "mode": "natural",
    "brightness": 0.0,      # -100..100
    "contrast": 0.0,        # -100..100
    "gamma": 1.0,           # 0.3..2.5
    "saturation": 1.00,     # global chroma gain (natural/adaptive) | ramp mix (lut modes)
    "warmCast": 0.40,       # adaptive only: blend toward the warm ramp
    "castRamp": "sunset",   # adaptive only: which ramp the cast blends toward
    "warmCenter": 30.0,     # hue anchor (deg): 0=red 30=orange 60=yellow
    "warmSpan": 58.0,       # adaptive only: how much of the hue circle is kept
    # ---- natural mode: hue-selective warm enhancement, no global remap ----
    "warmBoost": 0.60,      # how far already-warm hues are pushed to full saturation
    "coolPull": 0.25,       # how far cool hues may drift towards the warm band
    "coolCap": 60.0,        # hard ceiling (deg) on that drift
    "coolDesat": 0.25,      # how much cool hues are pulled towards neutral
    "warmPull": 0.12,       # gentle cohesion pull of warm hues towards warmCenter
    "warmPullCap": 18.0,    # ceiling (deg) on the warm-side pull
    "autoLevels": 1.0,      # 0/1
    "autoClip": 0.005,      # percentile clipped at each end
    "sharpen": 0.30,        # 0..1.5 luma unsharp amount
    "invert": 0.0,
    "dither": "fs",         # fs | atkinson | bayer | none
    "ditherStrength": 0.85,
}


# ================================================================ helpers
def luma(x):
    """Rec.709 luma of an (H,W,3) float array."""
    return x[..., 0] * 0.2126 + x[..., 1] * 0.7152 + x[..., 2] * 0.0722


def ramp_lut(name, n=256):
    """Expand a stop list into an (n,3) lookup table."""
    stops = RAMPS[name]
    xs = np.array([s[0] for s in stops], dtype=np.float64)
    cs = np.array([s[1] for s in stops], dtype=np.float64)
    t = np.arange(n, dtype=np.float64) / (n - 1.0)
    out = np.empty((n, 3), dtype=np.float64)
    for c in range(3):
        out[:, c] = np.interp(t, xs, cs[:, c])
    return out


def _pct_from_hist(hist, q, total):
    """Nearest-rank percentile from a 256-bin histogram (identical in JS)."""
    target = q * total
    c = 0.0
    for i in range(256):
        c += hist[i]
        if c >= target:
            return float(i)
    return 255.0


def auto_levels(x, clip):
    """Luma-preserving auto contrast, applied equally to all channels."""
    L = luma(x)
    idx = np.clip(np.floor(L + 0.5), 0, 255).astype(np.int32)
    hist = np.bincount(idx.ravel(), minlength=256).astype(np.float64)
    total = float(L.size)
    lo = _pct_from_hist(hist, clip, total)
    hi = _pct_from_hist(hist, 1.0 - clip, total)
    if hi - lo < 8.0:  # flat image -- leave it alone
        return x
    scale = (246.0 - 18.0) / (hi - lo)
    return (x - lo) * scale + 18.0


def _binomial_blur3(x):
    """Separable 1-2-1 blur with clamped edges, on an (H,W,C) array."""
    h, w, c = x.shape
    p = np.pad(x, ((0, 0), (1, 1), (0, 0)), mode="edge")
    t = p[:, 0:w, :] + 2.0 * p[:, 1:w + 1, :] + p[:, 2:w + 2, :]
    p = np.pad(t, ((1, 1), (0, 0), (0, 0)), mode="edge")
    t = p[0:h, :, :] + 2.0 * p[1:h + 1, :, :] + p[2:h + 2, :, :]
    return t * 0.0625  # /16


def unsharp(x, amount):
    if amount <= 0.0:
        return x
    return x + amount * (x - _binomial_blur3(x))


def rgb_to_hsl(x):
    """x in 0..1 -> h,s,l each (H,W) in 0..1."""
    r, g, b = x[..., 0], x[..., 1], x[..., 2]
    mx = np.max(x, axis=-1)
    mn = np.min(x, axis=-1)
    l = (mx + mn) * 0.5
    d = mx - mn
    den = np.where(l > 0.5, 2.0 - mx - mn, mx + mn)
    s = np.where(d > 1e-12, d / np.maximum(den, 1e-12), 0.0)
    s = np.clip(s, 0.0, 1.0)

    rc = (mx - r) / np.maximum(d, 1e-12)
    gc = (mx - g) / np.maximum(d, 1e-12)
    bc = (mx - b) / np.maximum(d, 1e-12)
    hr = bc - gc
    hg = 2.0 + rc - bc
    hb = 4.0 + gc - rc
    h = np.where(mx == r, hr, np.where(mx == g, hg, hb))
    h = (h / 6.0) % 1.0
    h = np.where(d > 1e-12, h, 0.0)
    return h, s, l


def _hue2rgb(p, q, t):
    t = t % 1.0
    out = np.where(
        t < 1.0 / 6.0,
        p + (q - p) * 6.0 * t,
        np.where(
            t < 0.5,
            q,
            np.where(t < 2.0 / 3.0, p + (q - p) * (2.0 / 3.0 - t) * 6.0, p),
        ),
    )
    return out


def hsl_to_rgb(h, s, l):
    q = np.where(l < 0.5, l * (1.0 + s), l + s - l * s)
    p = 2.0 * l - q
    r = _hue2rgb(p, q, h + 1.0 / 3.0)
    g = _hue2rgb(p, q, h)
    b = _hue2rgb(p, q, h - 1.0 / 3.0)
    return np.stack([r, g, b], axis=-1)


# --------------------------------------------------- warm-hue affinity
# Saturation boost applied to warm hues: s -> s^(1 - WARM_SAT_K*g) where
# g = warmBoost * affinity, so the strength ramps in smoothly with both the
# slider and how warm the hue is.  A power curve is used instead of the
# obvious "approach full saturation" lerp because a lerp towards 1.0 pushes
# near-neutral warm tones (beige bedding, pale skin, dusty brick) most of the
# way to pure red -- the photo stops looking like itself.  The power curve is
# monotonic and maps 0->0, 1->1, so it keeps the *ratios* between warm
# colours: muted stays relatively muted, vivid becomes vivid.
WARM_SAT_K = 0.75

# The warm band the panel can actually reach is red -> orange -> yellow,
# i.e. hue 340..360 plus 0..70.  Everything else is "cool" as far as the
# screen is concerned: mixing black/white/red/yellow cannot average to a
# blue or a cyan, so those pixels would dither down to plain black & white.
#
# `warm_affinity` is the weighting that drives the natural mode: 1 for hues
# that already sit in the warm band, falling smoothly to 0 across the 50
# degrees on either side (violet/magenta on one side, yellow-green on the
# other).  Cool hues are not dragged into the warm band -- they only get a
# bounded nudge and a partial desaturation, so the photo keeps its identity
# while the skin / wood / sunset tones that *are* warm become vivid.
def warm_affinity(hdeg):
    """Hue in degrees (0..360) -> warm affinity in 0..1.

    Full strength inside 350..360/0..60 (red -> orange -> yellow), fading to
    zero across the following 50 degrees on either side.  Yellow-green sits
    on the shoulder, so foliage only gets a light touch instead of being
    dragged into the warm band outright.
    """
    t_hi = np.clip((hdeg - 300.0) / 50.0, 0.0, 1.0)   # 300 -> 350 : 0 -> 1
    t_lo = np.clip((hdeg - 60.0) / 50.0, 0.0, 1.0)    #  60 -> 110 : 1 -> 0
    return np.where(hdeg > 300.0, t_hi * t_hi * (3.0 - 2.0 * t_hi),
                    np.where(hdeg < 110.0, 1.0 - t_lo * t_lo * (3.0 - 2.0 * t_lo), 0.0))


# ================================================================ dither
FS = ((1, 0, 7.0 / 16.0), (-1, 1, 3.0 / 16.0), (0, 1, 5.0 / 16.0), (1, 1, 1.0 / 16.0))
ATK = ((1, 0, 1.0 / 8.0), (2, 0, 1.0 / 8.0), (-1, 1, 1.0 / 8.0),
       (0, 1, 1.0 / 8.0), (1, 1, 1.0 / 8.0), (0, 2, 1.0 / 8.0))

BAYER8 = np.array([
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
], dtype=np.float64) / 64.0 - 0.5


def dither(img, mode="fs", strength=0.85, palette=PALETTE):
    """Error-diffuse an (H,W,3) float image onto `palette`. Returns index map.

    Deliberately written as a flat scalar loop: it is fast, and it ports
    one-to-one to a JS Float64Array so both implementations agree exactly.
    """
    h, w, _ = img.shape
    pal = [[float(c) for c in p] for p in palette]
    npal = len(pal)
    out = np.zeros((h, w), dtype=np.int32)
    flat = np.ascontiguousarray(img, dtype=np.float64).reshape(-1).tolist()

    def nearest(o):
        r, g, b = flat[o], flat[o + 1], flat[o + 2]
        bidx, bdist = 0, float("inf")
        for k in range(npal):
            p = pal[k]
            dr = r - p[0]
            dg = g - p[1]
            db = b - p[2]
            d = dr * dr + dg * dg + db * db
            if d < bdist:
                bdist, bidx = d, k
        return bidx

    if mode == "none":
        for y in range(h):
            base = y * w * 3
            for x in range(w):
                out[y, x] = nearest(base + x * 3)
        return out

    if mode == "bayer":
        amp = strength * 128.0
        bay = (BAYER8.tolist())
        for y in range(h):
            row = y & 7
            base = y * w * 3
            for x in range(w):
                o = base + x * 3
                off = bay[row][x & 7] * amp
                flat[o] = min(255.0, max(0.0, flat[o] + off))
                flat[o + 1] = min(255.0, max(0.0, flat[o + 1] + off))
                flat[o + 2] = min(255.0, max(0.0, flat[o + 2] + off))
                out[y, x] = nearest(o)
        return out

    kernel = FS if mode == "fs" else ATK
    for y in range(h):
        ltr = (y % 2 == 0)
        base = y * w * 3
        for i in range(w):
            x = i if ltr else w - 1 - i
            o = base + x * 3
            k = nearest(o)
            out[y, x] = k
            if strength <= 0.0:
                continue
            p = pal[k]
            er = (flat[o] - p[0]) * strength
            eg = (flat[o + 1] - p[1]) * strength
            eb = (flat[o + 2] - p[2]) * strength
            for dx, dy, wgt in kernel:
                nx = x + (dx if ltr else -dx)
                ny = y + dy
                if 0 <= nx < w and ny < h:
                    no = (ny * w + nx) * 3
                    flat[no] += er * wgt
                    flat[no + 1] += eg * wgt
                    flat[no + 2] += eb * wgt
    return out


# ================================================================ pipeline
def warm_map(rgb_u8, p=None):
    """RGB uint8 (H,W,3) -> warm-mapped float (H,W,3) in 0..255."""
    cfg = dict(DEFAULTS)
    if p:
        cfg.update({k: v for k, v in p.items() if k in DEFAULTS})

    x = rgb_u8.astype(np.float64)

    if cfg["invert"]:
        x = 255.0 - x
    if cfg["brightness"]:
        x = x + cfg["brightness"]
    if cfg["contrast"]:
        c = 1.0 + cfg["contrast"] / 100.0
        x = (x - 128.0) * c + 128.0
    if cfg["gamma"] != 1.0:
        x = 255.0 * np.power(np.clip(x, 0.0, 255.0) / 255.0, cfg["gamma"])
    x = np.clip(x, 0.0, 255.0)

    if cfg["autoLevels"]:
        x = np.clip(auto_levels(x, cfg["autoClip"]), 0.0, 255.0)

    x = np.clip(unsharp(x, cfg["sharpen"]), 0.0, 255.0)

    # 对照模式：不做任何色彩映射，直接把原图丢给四色抖动
    if cfg["mode"] == "naive":
        return x.copy()

    mode = cfg["mode"]

    if mode == "natural":
        # Hue-selective enhancement.  Warm hues keep their hue and simply get
        # pushed towards full saturation -- that is what makes skin / brick /
        # sunset pop as red and yellow dots instead of washing out to white.
        # Cool hues are nudged towards the warm band by a bounded amount and
        # partly desaturated, so they stay recognisable and land on a clean
        # neutral dither instead of turning into mud.
        h, s, l = rgb_to_hsl(x / 255.0)
        hd = h * 360.0
        wa = warm_affinity(hd)
        # warm side: power-curve saturation boost (monotonic, keeps ratios)
        g = np.clip(cfg["warmBoost"] * wa, 0.0, 1.0)
        s2 = np.power(s, 1.0 - WARM_SAT_K * g)
        # cool side: partial pull towards neutral
        s2 = s2 * (1.0 - np.clip(cfg["coolDesat"] * (1.0 - wa), 0.0, 1.0))
        s2 = np.clip(s2 * cfg["saturation"], 0.0, 1.0)

        # ---- hue shift -------------------------------------------------
        # Both terms are blended by `wa` instead of being switched on a hard
        # `hd > 60` test.  A hard switch leaves a 3..5 degree jump where the
        # warm branch applies the cohesion pull and the cool branch does not;
        # that jump posterises smooth gradients *and* makes the whole result
        # hinge on the last bit of a float, which is exactly the kind of
        # thing that makes two implementations disagree at the seam.
        #
        # cool drift: bring cool hues down towards the warm band, capped
        drift = -cfg["coolPull"] * (1.0 - wa) * (hd - 60.0)
        drift = np.clip(drift, -cfg["coolCap"], 0.0)
        # warm cohesion: nudge hues towards warmCenter, capped
        d2 = ((cfg["warmCenter"] - hd + 540.0) % 360.0) - 180.0
        pull = np.clip(cfg["warmPull"] * d2, -cfg["warmPullCap"], cfg["warmPullCap"])
        h2 = hd + drift + wa * pull
        h2 = ((h2 % 360.0) + 360.0) % 360.0
        y = hsl_to_rgb(h2 / 360.0, s2, l) * 255.0
        return np.clip(y, 0.0, 255.0)

    L = np.clip(luma(x), 0.0, 255.0)
    li = np.clip(np.floor(L + 0.5), 0, 255).astype(np.int32)

    if mode == "adaptive":
        h, s, l = rgb_to_hsl(x / 255.0)
        # squeeze the whole hue circle into [center-span/2, center+span/2]
        hd = cfg["warmCenter"] + (h - 0.5) * cfg["warmSpan"]
        h2 = (hd % 360.0) / 360.0
        y = hsl_to_rgb(h2, s, l) * 255.0
        # the cast ramp is indexed by the pixel's brightness *after* hue mapping,
        # so the warm tint tracks what is actually on screen
        lm = np.clip(luma(y), 0.0, 255.0)
        lm = np.clip(np.floor(lm + 0.5), 0, 255).astype(np.int32)
        ramp = ramp_lut(cfg["castRamp"])[lm]
        cast = cfg["warmCast"]
        y = y * (1.0 - cast) + ramp * cast
        h3, s3, l3 = rgb_to_hsl(np.clip(y, 0.0, 255.0) / 255.0)
        s3 = np.clip(s3 * cfg["saturation"], 0.0, 1.0)
        y = hsl_to_rgb(h3, s3, l3) * 255.0
    elif mode == "gray":
        y = np.stack([L, L, L], axis=-1)
    else:
        ramp = ramp_lut(mode)[li]
        amt = float(np.clip(cfg["saturation"], 0.0, 1.5))
        gray = np.stack([L, L, L], axis=-1)
        y = gray * (1.0 - amt) + ramp * amt

    return np.clip(y, 0.0, 255.0)


def convert(rgb_u8, p=None, scale=None, letterbox=(255, 255, 255)):
    """Full pipeline: RGB uint8 -> dithered palette-index image + stats."""
    cfg = dict(DEFAULTS)
    if p:
        cfg.update({k: v for k, v in p.items() if k in DEFAULTS})
    src = rgb_u8
    if scale:
        src = resize_rgb(src, scale[0], scale[1], letterbox)
    mapped = warm_map(src, cfg)
    idx = dither(mapped, cfg["dither"], cfg["ditherStrength"])
    return idx, mapped


def stats_from_index(idx):
    n = idx.size
    counts = [int((idx == i).sum()) for i in range(4)]
    return {
        "black": counts[K] / n,
        "white": counts[W] / n,
        "red": counts[R] / n,
        "yellow": counts[Y] / n,
        "chroma": (counts[R] + counts[Y]) / n,
        "bw": (counts[K] + counts[W]) / n,
    }


# ================================================================ resample
def resize_rgb(src, w, h, letterbox=(255, 255, 255), fit="cover"):
    """Nearest-neighbour is deliberately avoided; PIL box/bilinear via numpy."""
    from PIL import Image

    sh, sw = src.shape[:2]
    if fit == "stretch":
        box = (0, 0, sw, sh)
        tw, th = w, h
    else:
        sr = sw / sh
        tr = w / h
        if (sr > tr) == (fit == "cover"):
            th = sh
            tw = int(round(sh * tr))
        else:
            tw = sw
            th = int(round(sw / tr))
        tw = min(tw, sw)
        th = min(th, sh)
        box = ((sw - tw) // 2, (sh - th) // 2, (sw - tw) // 2 + tw, (sh - th) // 2 + th)

    im = Image.fromarray(src.astype(np.uint8), "RGB").crop(box)
    if fit == "stretch":
        im = im.resize((w, h), Image.LANCZOS)
        return np.asarray(im).astype(np.uint8)
    im = im.resize((tw, th), Image.LANCZOS)
    canvas = Image.new("RGB", (w, h), tuple(int(v) for v in letterbox))
    canvas.paste(im, ((w - tw) // 2, (h - th) // 2))
    return np.asarray(canvas).astype(np.uint8)


def index_to_rgb(idx):
    return PALETTE[idx].astype(np.uint8)
