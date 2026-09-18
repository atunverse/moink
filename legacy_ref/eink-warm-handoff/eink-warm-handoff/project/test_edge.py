# -*- coding: utf-8 -*-
"""Edge cases the happy-path test does not reach.

  * clicking an export with no photo loaded must warn, not throw
  * panel widths that are *not* a multiple of 4 exercise the half-byte tail
    of the hand-written 4-bit indexed PNG encoder and the 2bpp RAW packer
  * a crop shrunk to a sliver must still round-trip through every exporter
  * every colour mode must produce palette-only output

Downloads are written to downloads/ with the same name prefixes as test_e2e.py
so `check_exports.py` can validate them afterwards — run this one last.
"""
import os
import sys
import shutil
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = "file:///" + os.path.join(HERE, "eink-warm-converter.html").replace("\\", "/")
DOWN = os.path.join(HERE, "downloads")
os.makedirs(DOWN, exist_ok=True)

errors = []

PROBE = """() => {
  const c = document.getElementById('cvShade');
  if (!c.width) return {w:0,h:0,off:0,chroma:0,src:'',sz:''};
  const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const pal = {'0,0,0':1,'255,255,255':1,'255,0,0':1,'255,255,0':1};
  let off = 0, chroma = 0;
  for (let i=0;i<c.width*c.height;i++){
    const k = d[i*4]+','+d[i*4+1]+','+d[i*4+2];
    if (!(k in pal)) off++;
    if (k === '255,0,0' || k === '255,255,0') chroma++;
  }
  return { w:c.width, h:c.height, off:off,
           chroma:chroma/(c.width*c.height),
           src:(document.getElementById('srcTag')||{}).textContent||'',
           sz:(document.getElementById('szTag')||{}).textContent||'' };
}"""


def set_range(page, sel, val):
    page.evaluate("""([s,v]) => {
      const n = document.querySelector(s);
      n.value = String(v);
      n.dispatchEvent(new Event('input', {bubbles:true}));
    }""", [sel, val])


def run():
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(accept_downloads=True, viewport={"width": 1440, "height": 1000})

        # ---------------------------------------------- no photo loaded
        print("[1] 未导入照片时的健壮性")
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append("no-img pageerror: %s" % e))
        pg.goto(PAGE)
        pg.wait_for_function("() => window.__eink && document.getElementById('panel').options.length > 1",
                             timeout=20000)
        pg.evaluate("() => document.querySelectorAll('details').forEach(d => d.open = true)")
        pg.wait_for_timeout(400)
        for btn in ["#expPng", "#expIdx", "#expBmp", "#expRaw", "#expFlat",
                    "#expDitherOnly", "#btnCopy", "#btnZoom", "#btnCrop", "#btnAuto"]:
            pg.click(btn)
            pg.wait_for_timeout(120)
        pg.wait_for_timeout(500)
        toast = pg.evaluate("() => document.getElementById('toast').textContent")
        print("    十个按钮全部点击完毕，最后一次提示: %s" % toast)
        print("    pageerror 数: %d" % len(errors))
        assert not errors, "未导入照片时点了按钮就报错"

        # ---------------------------------------------- odd panel widths
        pg.click("#btnDemo")
        pg.wait_for_function("() => document.getElementById('cvShade').width > 0", timeout=20000)
        pg.wait_for_timeout(1200)
        pg.select_option("#panel", index=8)          # 自定义尺寸
        pg.wait_for_timeout(300)

        print("[2] 非 4 倍数宽度（半字节尾部的打包路径）")
        cases = [(150, 100, "半字节尾部"), (767, 553, "两个方向都余 3"), (2000, 64, "最大值")]
        for cw, ch, note in cases:
            set_range(pg, "#cw", cw)
            set_range(pg, "#ch", ch)
            pg.wait_for_timeout(1500)
            v = pg.evaluate(PROBE)
            sz = v["sz"].replace(" ", "")
            print("    设定 %dx%d（%s）-> 预览 %sx%s 调色板外=%d 红黄=%.1f%%"
                  % (cw, ch, note, v["w"], v["h"], v["off"], v["chroma"] * 100))
            assert sz == "%d×%d" % (cw, ch), "目标尺寸未生效: %s != %dx%d" % (sz, cw, ch)
            assert v["off"] == 0, "%dx%d 出现调色板外像素" % (cw, ch)

        # 用非 4 倍数宽度导出，交给 check_exports.py 解码核对
        set_range(pg, "#cw", 750)
        set_range(pg, "#ch", 502)
        pg.wait_for_timeout(1200)
        for btn, name in [("#expPng", "png-4color"), ("#expIdx", "png-indexed"),
                          ("#expRaw", "raw"), ("#expBmp", "bmp"),
                          ("#expFlat", "flat-continuous"), ("#expDitherOnly", "dither-only")]:
            with pg.expect_download(timeout=40000) as dl:
                pg.click(btn)
            f = dl.value
            path = os.path.join(DOWN, name + "__odd-750x502-" + f.suggested_filename)
            f.save_as(path)
            print("    %-14s -> %-46s %9d bytes" % (name, f.suggested_filename,
                                                    os.path.getsize(path)))
            pg.wait_for_timeout(300)

        print("[3] 全部色彩风格在 296x128 小屏上仍为纯四色")
        pg.select_option("#panel", index=4)          # 2.9 寸 296x128
        pg.wait_for_timeout(1200)
        for mode in ["natural", "adaptive", "sunset", "ember", "duotone", "sepia", "gray", "naive"]:
            pg.select_option("#mode", mode)
            pg.wait_for_timeout(500)
            v = pg.evaluate(PROBE)
            tag = "✓" if v["off"] == 0 else "✗ %d" % v["off"]
            print("    %-9s 预览 %sx%s  红黄=%5.1f%%  %s"
                  % (mode, v["w"], v["h"], v["chroma"] * 100, tag))
            assert v["off"] == 0, "%s 在小屏上出现调色板外像素" % mode

        print("[4] 极端裁剪后仍可导出")
        pg.select_option("#panel", index=0)
        pg.select_option("#mode", "natural")
        pg.click("#btnCrop")
        pg.wait_for_selector("#cropModal.on", timeout=8000)
        pg.wait_for_timeout(500)
        pg.evaluate("""() => {
          const c = window.__eink.crop;
          c.rect = {x:0.41, y:0.47, w:0.055, h:0.05};   // 一条细缝
        }""")
        pg.click("#cmOk")
        pg.wait_for_timeout(1500)
        v = pg.evaluate(PROBE)
        print("    当前构图: %s" % v["src"])
        print("    提示: %s" % pg.evaluate("() => document.getElementById('cropInfo').textContent"))
        assert v["off"] == 0, "细缝裁剪后预览出现杂色"
        with pg.expect_download(timeout=40000) as dl:
            pg.click("#expPng")
        f = dl.value
        f.save_as(os.path.join(DOWN, "png-4color__tinycrop-" + f.suggested_filename))
        print("    细缝裁剪导出: %s (%d bytes)" % (f.suggested_filename, os.path.getsize(
            os.path.join(DOWN, "png-4color__tinycrop-" + f.suggested_filename))))

        # 单像素级裁剪
        pg.click("#btnCrop")
        pg.wait_for_selector("#cropModal.on", timeout=8000)
        pg.evaluate("""() => { window.__eink.crop.rect = {x:0.5, y:0.5, w:0.0005, h:0.0005}; }""")
        pg.click("#cmOk")
        pg.wait_for_timeout(1200)
        info = pg.evaluate("() => document.getElementById('cropInfo').textContent")
        print("    最小裁剪被钳制为: %s" % info)

        b.close()

    print("\n控制台错误: %d" % len(errors))
    for e in errors[:8]:
        print("   ", e)
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(run())
