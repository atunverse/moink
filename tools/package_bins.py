#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
package_bins.py [tag] —— 把编译产物打包成刷机/OTA 用的 bin。

用受管 venv 的解释器运行（里面装了 esptool 5.4）：
    python tools/package_bins.py r1

产出：
    moink_<tag>_merged.bin  整包（0x0）：bootloader + partitions + app，USB 刷机用
    moink_<tag>_app.bin     app 镜像：OTA 上传用（firmware.bin 的原样拷贝）

合并参数沿用已验证配置：esp32c3 / dio / 40m / 4MB。
"""
import os
import sys
import shutil
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(ROOT, ".pio", "build", "moink")


def esptool(args):
    """用当前解释器的 esptool 模块跑命令（venv 里已装）。"""
    cmd = [sys.executable, "-m", "esptool"] + args
    subprocess.run(cmd, check=True)


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "r1"

    boot = os.path.join(BUILD, "bootloader.bin")
    part = os.path.join(BUILD, "partitions.bin")
    app = os.path.join(BUILD, "firmware.bin")

    for p in (boot, part, app):
        if not os.path.exists(p):
            print("missing build artifact: %s" % p)
            return 1

    app_out = os.path.join(ROOT, "moink_%s_app.bin" % tag)
    merged = os.path.join(ROOT, "moink_%s_merged.bin" % tag)

    shutil.copyfile(app, app_out)
    print("app     -> %s (%d B)" % (app_out, os.path.getsize(app_out)))

    esptool([
        "--chip", "esp32c3", "merge_bin",
        "-o", merged,
        "--flash_mode", "dio",
        "--flash_freq", "40m",
        "--flash_size", "4MB",
        "0x0", boot,
        "0x8000", part,
        "0x10000", app,
    ])
    print("merged  -> %s (%d B)" % (merged, os.path.getsize(merged)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
