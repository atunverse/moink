# Template: drive a single-file HTML tool in headless Chromium and check what it produces.
#
#   pip install playwright && python -m playwright install chromium
#   python browser_probe.py
#
# On Windows the browser install may end with a "[safe-delete] ... ETIMEDOUT" message; that
# is cleanup noise. Verify %LOCALAPPDATA%\ms-playwright\chromium-* contains
# INSTALLATION_COMPLETE and carry on.

import os
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = "file:///" + os.path.join(HERE, "tool.html").replace("\\", "/")
SAMPLE = os.path.join(HERE, "sample.png")
DOWNLOADS = os.path.join(HERE, "downloads")
os.makedirs(DOWNLOADS, exist_ok=True)

# Read the rendered canvas back and histogram its colours. Adapt the palette and the
# element id. Returning real numbers beats taking a screenshot you then have to eyeball.
PROBE = """() => {
  const c = document.getElementById('output');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const n = c.width * c.height;
  const seen = {};
  for (let i = 0; i < n; i++) {
    const k = d[i*4] + ',' + d[i*4+1] + ',' + d[i*4+2];
    seen[k] = (seen[k] || 0) + 1;
  }
  return { w: c.width, h: c.height, seen: seen, n: n,
           colours: Object.keys(seen).length };
}"""

errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()                       # chromium ships with the package
    ctx = browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 1000})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
    page.on("console", lambda m: errors.append("console: %s" % m.text)
            if m.type == "error" else None)

    page.goto(PAGE)
    page.wait_for_function("() => document.getElementById('output').width > 0", timeout=20000)

    # Controls inside <details> are invisible to select_option/fill and will time out.
    page.evaluate("() => document.querySelectorAll('details').forEach(d => d.open = true)")
    page.wait_for_timeout(500)

    # Drive the real file input rather than injecting state.
    page.set_input_files("#file", SAMPLE)
    page.wait_for_timeout(1500)

    v = page.evaluate(PROBE)
    print("rendered %sx%s, %s distinct colours" % (v["w"], v["h"], v["colours"]))
    expected = {"0,0,0", "255,255,255"}                  # <- adapt to the tool's palette
    off = sum(c for k, c in v["seen"].items() if k not in expected)
    print("pixels outside the expected palette:", off)

    # Sweep every control that changes the output, and re-assert each time.
    for value in ["a", "b", "c"]:                        # <- adapt
        page.select_option("#mode", value)
        page.wait_for_timeout(600)
        v = page.evaluate(PROBE)
        assert v["colours"] <= len(expected), "%s produced off-palette colours" % value

    # Every export button must yield a file; check the byte length against the format spec.
    for button, name in [("#exportPng", "png"), ("#exportBin", "bin")]:
        with page.expect_download(timeout=30000) as dl:
            page.click(button)
        f = dl.value
        path = os.path.join(DOWNLOADS, name + "-" + f.suggested_filename)
        f.save_as(path)
        print("%-12s %8d bytes  %s" % (name, os.path.getsize(path), f.suggested_filename))

    # Mobile viewport: no horizontal overflow.
    m = ctx.new_page()
    m.set_viewport_size({"width": 412, "height": 915})
    m.goto(PAGE)
    m.wait_for_timeout(1200)
    w = m.evaluate("() => [document.documentElement.scrollWidth,"
                   " document.documentElement.clientWidth]")
    print("mobile doc width %s / viewport %s -> %s" %
          (w[0], w[1], "ok" if w[0] <= w[1] + 1 else "HORIZONTAL OVERFLOW"))

    browser.close()

print("\nconsole/page errors:", len(errors))
for e in errors[:10]:
    print("  ", e)
raise SystemExit(0 if not errors else 1)
