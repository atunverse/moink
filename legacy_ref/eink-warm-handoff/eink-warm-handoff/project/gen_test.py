# -*- coding: utf-8 -*-
"""Generate a deterministic test image + Python reference outputs for JS cross-check."""
import json
import os
import sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eink_warm as ew

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xcheck")
os.makedirs(OUT, exist_ok=True)

W, H = 160, 120
rng = np.random.RandomState(20260914)


def build_test_image():
    """Hue wheel + neutral ramp + primaries + noise: hits every branch of rgb2hsl."""
    img = np.zeros((H, W, 3), dtype=np.uint8)
    yy, xx = np.mgrid[0:H, 0:W]
    # left third: full hue sweep at mid lightness
    hue = (xx / (W / 3.0)) * 360.0
    t = np.clip(hue / 60.0, 0, 6)
    c = np.clip((xx / (W / 3.0)) % 1.0, 0, 1)
    hh = (xx / (W / 3.0)) % 6.0
    x = 1.0 - np.abs((hh % 2.0) - 1.0)
    r = np.select([hh < 1, hh < 2, hh < 3, hh < 4, hh < 5],
                  [1, x, 0, 0, x], default=1.0)
    g = np.select([hh < 1, hh < 2, hh < 3, hh < 4, hh < 5],
                  [x, 1, 1, x, 0], default=0.0)
    b = np.select([hh < 1, hh < 2, hh < 3, hh < 4, hh < 5],
                  [0, 0, x, 1, 1], default=x)
    v = 0.15 + 0.8 * (yy / H)
    tri = np.stack([r, g, b], -1) * v[..., None] * 255.0
    img[:, : W // 3] = tri[:, : W // 3].astype(np.uint8)

    # middle third: neutral ramp (r=g=b) + exact 0 / 255 edges
    mid = slice(W // 3, 2 * W // 3)
    ramp = (yy / (H - 1.0) * 255.0)[..., None]
    img[:, mid] = np.repeat(ramp, 3, axis=-1)[:, : mid.stop - mid.start].astype(np.uint8)
    img[0, mid] = 0
    img[H - 1, mid] = 255

    # right third: saturated primaries + a strip of the four palette colours
    right = slice(2 * W // 3, W)
    cols = [0, 255, 255, 0, 128, 0, 255, 0, 0, 255, 255, 0]
    band = (H // 3) // max(1, len(cols) // 3)
    for i in range(0, (mid.stop - W // 3) and len(cols) // 3):
        pass
    prim = np.array([[255, 0, 0], [255, 255, 0], [0, 0, 255], [0, 255, 0],
                     [0, 255, 255], [255, 0, 255]], dtype=np.uint8)
    for i, p in enumerate(prim):
        y0 = i * (H // len(prim))
        y1 = H if i == len(prim) - 1 else (i + 1) * (H // len(prim))
        img[y0:y1, right] = p
    # sprinkle noise so errordiffusion顺序差异会立刻暴露
    noise = rng.randint(0, 40, size=(H, W // 4, 3))
    img[:, 120:160] = np.clip(img[:, 120:160].astype(int) + noise - 20, 0, 255).astype(np.uint8)
    return img


CASES = {
    # ---- natural: hue-selective warm enhancement (the new default) ----
    "natural_default": dict(ew.DEFAULTS, mode="natural"),
    "natural_boost_max": dict(ew.DEFAULTS, mode="natural", warmBoost=1.0, warmPull=0.5),
    "natural_boost_off": dict(ew.DEFAULTS, mode="natural", warmBoost=0.0, coolDesat=0.0),
    "natural_cool_neutral": dict(ew.DEFAULTS, mode="natural", coolPull=0.0, coolDesat=0.0,
                                 warmPull=0.0),
    "natural_cool_hard": dict(ew.DEFAULTS, mode="natural", coolPull=0.8, coolCap=10,
                              coolDesat=0.8, warmCenter=0),
    "natural_sat_gain": dict(ew.DEFAULTS, mode="natural", saturation=2.0, warmBoost=0.5),
    "natural_atkinson": dict(ew.DEFAULTS, mode="natural", dither="atkinson", ditherStrength=0.6),
    # ---- adaptive: full hue squeeze into the warm band ----
    "adaptive_default": dict(ew.DEFAULTS, mode="adaptive"),
    "adaptive_tuned": dict(ew.DEFAULTS, mode="adaptive", warmCast=0.58, saturation=1.9,
                           warmCenter=18, warmSpan=110, castRamp="ember"),
    "adaptive_span_min": dict(ew.DEFAULTS, mode="adaptive", warmCenter=0, warmSpan=8),
    "adaptive_center_hi": dict(ew.DEFAULTS, mode="adaptive", warmCenter=60, warmSpan=140,
                               castRamp="sepia"),
    # ---- tone / misc ----
    "tone_heavy": dict(ew.DEFAULTS, mode="adaptive", brightness=-25, contrast=45, sharpen=1.2,
                       autoLevels=False, saturation=1.1),
    "tone_bright": dict(ew.DEFAULTS, mode="natural", brightness=30, contrast=-20, sharpen=0.0,
                        autoClip=0.02, ditherStrength=0.0),
    "invert_on": dict(ew.DEFAULTS, mode="adaptive", invert=True, warmCast=0.2),
    "sunset": dict(ew.DEFAULTS, mode="sunset", saturation=1.0),
    "ember": dict(ew.DEFAULTS, mode="ember", saturation=0.8, dither="atkinson"),
    "duotone": dict(ew.DEFAULTS, mode="duotone", saturation=1.2, dither="bayer"),
    "sepia": dict(ew.DEFAULTS, mode="sepia", saturation=1.0, sharpen=0.9),
    "gray": dict(ew.DEFAULTS, mode="gray", dither="none"),
    "naive_ctrl": dict(ew.DEFAULTS, mode="naive", dither="fs", ditherStrength=0.85),
    "naive_tone": dict(ew.DEFAULTS, mode="naive", brightness=20, contrast=30,
                       autoLevels=False, dither="bayer"),
}

if __name__ == "__main__":
    src = build_test_image()
    Image.fromarray(src).save(os.path.join(OUT, "test_image.png"))
    src.tofile(os.path.join(OUT, "test_rgb.u8"))

    manifest = {}
    for name, cfg in CASES.items():
        mapped = ew.warm_map(src, cfg)
        idx = ew.dither(mapped, cfg["dither"], cfg["ditherStrength"])
        mapped.astype(np.float64).tofile(os.path.join(OUT, name + "_mapped.f64"))
        idx.astype(np.uint8).tofile(os.path.join(OUT, name + "_idx.u8"))
        st = ew.stats_from_index(idx)
        manifest[name] = dict(cfg={k: (bool(v) if isinstance(v, (bool, np.bool_)) else v)
                                   for k, v in cfg.items()},
                              chroma=st["chroma"])
        print(f"{name:<20} R+Y={st['chroma']*100:5.1f}%  black={st['black']*100:5.1f}%")

    with open(os.path.join(OUT, "cases.json"), "w", encoding="utf-8") as f:
        json.dump({"w": W, "h": H, "cases": manifest}, f, indent=1)
    print("\nwritten to", OUT)
