# -*- coding: utf-8 -*-
"""End-to-end browser test for the shipped HTML tool.

Exercises the real UI in headless Chromium: import, colour modes, auto tune,
dither kernels, panel presets, all six exports, the crop/rotate editor, the
1:1 viewer and a phone viewport.  Any console error fails the run.
"""
import os
import sys
import json
import shutil
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = "file:///" + os.path.join(HERE, "eink-warm-converter.html").replace("\\", "/")
SHOTS = os.path.join(HERE, "shots")
DOWN = os.path.join(HERE, "downloads")
os.makedirs(SHOTS, exist_ok=True)
os.makedirs(DOWN, exist_ok=True)

errors, logs = [], []
PAL = {"0,0,0": "black", "255,255,255": "white", "255,0,0": "red", "255,255,0": "yellow"}

# Reads the on-screen dithered canvas and the live stat readouts.
PROBE = """() => {
  const c = document.getElementById('cvShade');
  const g0 = id => (document.getElementById(id)||{textContent:'-'}).textContent;
  const base = {
    w:c.width, h:c.height, black:0, white:0, red:0, yellow:0, offPalette:0,
    stRed:g0('pRed'), stYellow:g0('pYellow'), stChroma:g0('pChroma'),
    verdict:g0('verdict'), verdictClass:(document.getElementById('verdict')||{}).className||'',
    srcTag:g0('srcTag'), szTag:g0('szTag'), cropInfo:g0('cropInfo'),
    mode:(document.getElementById('mode')||{}).value,
    imgW:(window.__eink.state.img||{}).width||0,
    imgH:(window.__eink.state.img||{}).height||0
  };
  if (!c.width || !c.height) return base;
  const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const seen = {};
  for (let i=0;i<c.width*c.height;i++){
    const k = d[i*4]+','+d[i*4+1]+','+d[i*4+2];
    seen[k] = (seen[k]||0)+1;
  }
  const n = c.width*c.height;
  let offPalette = 0;
  for (const k of Object.keys(seen)) if (!(k in {'0,0,0':1,'255,255,255':1,'255,0,0':1,'255,255,0':1})) offPalette += seen[k];
  base.black = (seen['0,0,0']||0)/n;
  base.white = (seen['255,255,255']||0)/n;
  base.red   = (seen['255,0,0']||0)/n;
  base.yellow= (seen['255,255,0']||0)/n;
  base.offPalette = offPalette;
  return base;
}"""


def check(page, label, expect_palette_only=True):
    v = page.evaluate(PROBE)
    tag = "✓" if (not expect_palette_only or v["offPalette"] == 0) else "✗ 调色板外 %d px" % v["offPalette"]
    print("    %-22s 红+黄=%5.1f%%  红=%5.1f%% 黄=%5.1f%%  黑=%5.1f%%  白=%5.1f%%  %s"
          % (label, (v["red"] + v["yellow"]) * 100, v["red"] * 100, v["yellow"] * 100,
             v["black"] * 100, v["white"] * 100, tag))
    return v


def set_range(page, sel, val):
    """Set a range slider the way a drag would: value + input event."""
    page.evaluate("""([s,v]) => {
      const n = document.querySelector(s);
      n.value = String(v);
      n.dispatchEvent(new Event('input', {bubbles:true}));
    }""", [sel, val])


def run():
    res = {}
    shutil.rmtree(DOWN, ignore_errors=True)
    shutil.rmtree(SHOTS, ignore_errors=True)
    os.makedirs(DOWN, exist_ok=True)
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 1080})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))

        def on_console(m):
            logs.append("%s: %s" % (m.type, m.text))
            if m.type == "error":
                errors.append("console.error: %s" % m.text)

        page.on("console", on_console)
        page.goto(PAGE)
        page.wait_for_function("() => window.__eink && document.getElementById('panel').options.length > 1",
                               timeout=20000)
        page.evaluate("() => document.querySelectorAll('details').forEach(d => d.open = true)")
        page.wait_for_timeout(500)

        print("[0] 默认状态")
        print("    默认色彩风格:", page.input_value("#mode"),
              "| 默认屏幕:", page.evaluate("() => document.getElementById('panel').selectedOptions[0].textContent"),
              "| 预览:", page.evaluate("() => document.getElementById('szTag').textContent"),
              "| 空状态提示:", page.evaluate("() => document.getElementById('verdict').textContent"))
        res["v_default"] = page.evaluate(PROBE)

        # `[hidden]` must actually win over the layout classes, otherwise
        # controls belonging to another mode stay on screen.
        print("[0b] 参数区块可见性（[hidden] 是否真正生效）")
        VIS = """() => {
          const disp = s => Array.from(document.querySelectorAll(s)).map(e => getComputedStyle(e).display);
          return { natural: disp('.m-natural'), adaptive: disp('.m-adaptive'),
                   cust: getComputedStyle(document.getElementById('custWrap')).display };
        }"""

        def vis(mode, panel):
            page.select_option("#mode", mode)
            page.select_option("#panel", index=panel)
            page.wait_for_timeout(500)
            return page.evaluate(VIS)

        vv = vis("natural", 0)
        print("    natural + 固定尺寸: m-natural=%s  m-adaptive=%s  自定义宽高=%s"
              % (vv["natural"], vv["adaptive"], vv["cust"]))
        assert all(d != "none" for d in vv["natural"]), "natural 模式的参数被隐藏了"
        assert all(d == "none" for d in vv["adaptive"]), "natural 模式下仍显示 adaptive 参数"
        assert vv["cust"] == "none", "非自定义尺寸时仍显示宽高滑杆"
        res["vis_natural"] = vv

        vv = vis("adaptive", 8)
        print("    adaptive + 自定义尺寸: m-natural=%s  m-adaptive=%s  自定义宽高=%s"
              % (vv["natural"], vv["adaptive"], vv["cust"]))
        assert all(d == "none" for d in vv["natural"]), "adaptive 模式下仍显示 natural 参数"
        assert all(d != "none" for d in vv["adaptive"]), "adaptive 参数被隐藏了"
        assert vv["cust"] != "none", "自定义尺寸时未显示宽高滑杆"
        res["vis_adaptive"] = vv

        page.select_option("#mode", "natural")
        page.select_option("#panel", index=0)
        page.wait_for_timeout(400)

        print("[1] 内置示例照片")
        page.click("#btnDemo")
        page.wait_for_function("() => document.getElementById('cvShade').width > 0", timeout=20000)
        page.wait_for_timeout(1400)
        v = check(page, "内置示例")
        res["boot_demo"] = v
        page.screenshot(path=os.path.join(SHOTS, "01-boot.png"), full_page=True)

        print("[2] 导入冷色调实拍照片 p7.jpg")
        page.set_input_files("#file", os.path.join(HERE, "samples", "p7.jpg"))
        page.wait_for_function("() => document.getElementById('srcTag').textContent.indexOf('×') > 0", timeout=20000)
        page.wait_for_timeout(1600)
        v = check(page, "natural@冷色调图")
        print("        源: %s | 输出: %s" % (v["srcTag"], v["szTag"]))
        print("        判定: %s | %s" % (v["verdictClass"], v["verdict"][:78]))
        res["cold_natural"] = v
        page.screenshot(path=os.path.join(SHOTS, "02-cold-natural.png"), full_page=True)

        print("[3] 导入暖色调实拍照片 q19.jpg")
        page.set_input_files("#file", os.path.join(HERE, "samples", "q19.jpg"))
        page.wait_for_timeout(1800)
        v = check(page, "natural@暖色调图")
        print("        判定: %s" % v["verdict"][:78])
        res["warm_natural"] = v
        page.screenshot(path=os.path.join(SHOTS, "03-warm-natural.png"), full_page=True)

        print("[4] 全部色彩风格")
        for mode in ["natural", "adaptive", "sunset", "ember", "duotone", "sepia", "gray", "naive"]:
            page.select_option("#mode", mode)
            page.wait_for_timeout(750)
            res["mode_" + mode] = check(page, mode)
        page.select_option("#mode", "natural")
        page.wait_for_timeout(600)

        print("[5] 自然暖调参数扫描")
        for hid, vals in [("#warmBoost", [0.0, 0.4, 1.0]), ("#coolPull", [0.0, 0.5, 0.8])]:
            for val in vals:
                set_range(page, hid, val)
                page.wait_for_timeout(520)
                check(page, "%s=%s" % (hid.lstrip('#'), val))
        set_range(page, "#warmBoost", 0.6)
        set_range(page, "#coolPull", 0.25)
        page.wait_for_timeout(500)

        print("[6] 一键智能优化")
        page.click("#btnAuto")
        page.wait_for_timeout(1500)
        res["auto"] = check(page, "auto")
        print("        优化后参数: warmBoost=%s coolPull=%s brightness=%s"
              % (page.input_value("#warmBoost"), page.input_value("#coolPull"), page.input_value("#brightness")))

        print("[7] 抖动算法")
        for dm in ["fs", "atkinson", "bayer", "none"]:
            page.select_option("#dither", dm)
            page.wait_for_timeout(650)
            check(page, dm)
        page.select_option("#dither", "fs")
        page.wait_for_timeout(500)

        print("[8] 目标屏幕预设")
        for idx, want in [(0, "768"), (1, "800"), (7, "1600")]:
            page.select_option("#panel", index=idx)
            page.wait_for_timeout(1300)
            v = check(page, page.evaluate("() => document.getElementById('panel').selectedOptions[0].textContent"))
            assert v["szTag"].startswith(want), "panel size mismatch: %s" % v["szTag"]
        page.select_option("#panel", index=0)          # 华为 nova14 768x552
        page.wait_for_timeout(1200)
        res["nova14"] = page.evaluate(PROBE)
        page.screenshot(path=os.path.join(SHOTS, "04-nova14.png"), full_page=True)

        print("[9] 适配方式")
        for fit in ["cover", "contain", "stretch"]:
            page.select_option("#fit", fit)
            page.wait_for_timeout(900)
            check(page, "fit=" + fit)
        page.select_option("#fit", "cover")
        page.wait_for_timeout(700)

        print("[10] 六种导出")
        page.select_option("#panel", index=0)
        page.wait_for_timeout(900)
        export_buttons = [("#expPng", "png-4color", True), ("#expIdx", "png-indexed", True),
                          ("#expBmp", "bmp", True), ("#expRaw", "raw", False),
                          ("#expFlat", "flat-continuous", False),
                          ("#expDitherOnly", "dither-only", True)]
        for btn, name, palette_only in export_buttons:
            with page.expect_download(timeout=40000) as dl:
                page.click(btn)
            f = dl.value
            path = os.path.join(DOWN, name + "__" + f.suggested_filename)
            f.save_as(path)
            size = os.path.getsize(path)
            print("    %-8s -> %-46s %9d bytes" % (name, f.suggested_filename, size))
            res["dl_" + name] = {"file": path, "name": f.suggested_filename,
                                 "size": size, "palette_only": palette_only}
            page.wait_for_timeout(400)

        print("[11] 复制到剪贴板（无授权时应给出提示而不是崩）")
        page.click("#btnCopy")
        page.wait_for_timeout(900)
        print("        结果: %s" % page.evaluate("() => document.getElementById('outInfo').textContent"))

        print("[12] 裁剪 / 旋转编辑器")
        page.click("#btnCrop")
        page.wait_for_selector("#cropModal.on", timeout=8000)
        page.wait_for_timeout(700)
        before = page.evaluate("() => ({w:window.__eink.crop.rw, h:window.__eink.crop.rh, rot:window.__eink.crop.rot})")
        print("        打开: 旋转 %s°  底图 %sx%s" % (before["rot"], before["w"], before["h"]))
        page.screenshot(path=os.path.join(SHOTS, "05-crop-open.png"))

        page.click("#cmRotR")
        page.wait_for_timeout(600)
        after_rot = page.evaluate("() => ({w:window.__eink.crop.rw, h:window.__eink.crop.rh, rot:window.__eink.crop.rot})")
        print("        右旋 90°: 旋转 %s°  底图 %sx%s" % (after_rot["rot"], after_rot["w"], after_rot["h"]))
        assert after_rot["rot"] == 90 and (after_rot["w"], after_rot["h"]) == (before["h"], before["w"]), \
            "rotation did not swap the base dimensions"

        # real pointer drag: grab the SE corner handle and pull it inwards
        box = page.locator("#cmCanvas").bounding_box()
        st = page.evaluate("() => ({dw:window.__eink.crop.dw, dh:window.__eink.crop.dh, r:window.__eink.crop.rect})")
        se_x = box["x"] + st["r"]["x"] * box["width"] + st["r"]["w"] * box["width"] - 2
        se_y = box["y"] + st["r"]["y"] * box["height"] + st["r"]["h"] * box["height"] - 2
        page.mouse.move(se_x, se_y)
        page.mouse.down()
        page.mouse.move(se_x - box["width"] * 0.22, se_y - box["height"] * 0.10, steps=12)
        page.mouse.up()
        page.wait_for_timeout(400)
        dragged = page.evaluate("() => window.__eink.crop.rect")
        print("        拖动右下角后裁剪框: w=%.3f h=%.3f (原 1.000)" % (dragged["w"], dragged["h"]))
        assert dragged["w"] < 0.98, "drag on the corner handle did nothing"

        page.select_option("#cmAspect", "1")       # 1:1
        page.wait_for_timeout(500)
        sq = page.evaluate("() => window.__eink.crop.rect")
        print("        锁定 1:1 后比例 h/w=%.3f" % (sq["h"] / sq["w"]))
        page.screenshot(path=os.path.join(SHOTS, "06-crop-drag.png"))

        page.select_option("#cmAspect", "-1")      # screen ratio
        page.wait_for_timeout(500)
        sw = page.evaluate("() => window.__eink.crop.rect")
        ps = page.evaluate("() => [ +document.getElementById('cw').value, +document.getElementById('ch').value ]")
        print("        锁定屏幕比例 h/w=%.3f  期望=%.3f" % (sw["h"] / sw["w"], ps[1] / ps[0]))

        page.click("#cmOk")
        page.wait_for_timeout(1600)
        v = page.evaluate(PROBE)
        print("        确认后构图: %s | 提示: %s" % (v["cropInfo"], v["cropInfo"]))
        res["crop"] = {"before": before, "after_rot": after_rot, "dragged": dragged,
                       "aspect_1_1": sq, "aspect_screen": sw, "info": v["cropInfo"],
                       "imgW": v["imgW"], "imgH": v["imgH"]}
        page.screenshot(path=os.path.join(SHOTS, "07-crop-applied.png"), full_page=True)
        check(page, "裁剪后")

        print("[13] 重置裁剪")
        page.click("#btnCrop")
        page.wait_for_selector("#cropModal.on", timeout=8000)
        page.click("#cmReset")
        page.wait_for_timeout(400)
        r = page.evaluate("() => ({rot:window.__eink.crop.rot, r:window.__eink.crop.rect})")
        print("        重置后 rot=%s rect=%.2f,%.2f,%.2f,%.2f" % (r["rot"], r["r"]["x"], r["r"]["y"], r["r"]["w"], r["r"]["h"]))
        page.click("#cmCancel")
        page.wait_for_timeout(400)

        print("[14] 1:1 实际像素查看")
        page.click("#btnZoom")
        page.wait_for_selector("#zoom.on", timeout=8000)
        page.wait_for_timeout(600)
        z = page.evaluate("() => { const c=document.getElementById('cvZoom'); return {w:c.width,h:c.height,on:document.getElementById('zoom').classList.contains('on')}; }")
        print("        弹窗打开:%s 画布 %sx%s" % (z["on"], z["w"], z["h"]))
        assert z["on"] and z["w"] == 768 and z["h"] == 552, "zoom canvas is not the full panel size"
        page.screenshot(path=os.path.join(SHOTS, "08-zoom.png"))
        page.click("#zoomClose")
        page.wait_for_timeout(300)

        print("[15] 恢复默认")
        page.click("#btnReset")
        page.wait_for_timeout(1200)
        print("        mode=%s warmBoost=%s coolPull=%s panel=%s"
              % (page.input_value("#mode"), page.input_value("#warmBoost"),
                 page.input_value("#coolPull"), page.evaluate("() => document.getElementById('panel').selectedIndex")))
        check(page, "reset")

        print("[16] 手机竖屏（Android 视口）")
        m = ctx.new_page()
        m.set_viewport_size({"width": 412, "height": 915})
        m.goto(PAGE)
        m.wait_for_function("() => window.__eink && document.getElementById('panel').options.length > 1", timeout=20000)
        m.click("#btnDemo")
        m.wait_for_function("() => document.getElementById('cvShade').width > 0", timeout=20000)
        m.wait_for_timeout(1500)
        m.screenshot(path=os.path.join(SHOTS, "09-mobile.png"), full_page=True)
        mw = m.evaluate("() => ({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth})")
        print("        文档宽 %s / 视口宽 %s -> %s" % (mw["sw"], mw["cw"],
              "无横向溢出 ✓" if mw["sw"] <= mw["cw"] + 1 else "有横向溢出 ✗"))
        res["mobile"] = mw
        assert mw["sw"] <= mw["cw"] + 1, "horizontal overflow on mobile"

        browser.close()

    res["errors"] = errors
    res["logs"] = logs[-30:]
    with open(os.path.join(HERE, "browser_test.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print("\n控制台错误: %d" % len(errors))
    for e in errors[:10]:
        print("   ", e)
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(run())
