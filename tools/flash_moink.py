#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
flash_moink.py —— 命令行刷机（整包 merged.bin @ 0x0）。

本板走 C3 芯片自带 USB-Serial/JTAG（VID 0x303a / PID 0x1001）。浏览器网页烧录器
（esptool.js / WebSerial）在这个板上会卡死在 `Stub running...`（一个字节都写不进，
芯片停在 stub，表现为不出热点 + 按键无反应），所以必须走本脚本。

用法：
    python tools/flash_moink.py                  # 自动选口 + 刷 moink_*_merged.bin
    python tools/flash_moink.py --list           # 只列串口
    python tools/flash_moink.py --port COM7      # 指定口
    python tools/flash_moink.py --bin xxx.bin    # 指定镜像
    python tools/flash_moink.py --no-stub        # 走 ROM 加载器（卡死兜底）
    python tools/flash_moink.py --keep           # 不自动拔插提示
    python tools/flash_moink.py --force          # 跳过整包检查（危险，别用）

★ 本脚本只往 0x0 写「整包」（bootloader@0x0 + 分区表@0x8000 + app@0x10000）。
  把单纯的 app 镜像（firmware.bin / moink_*_app.bin）按 0x0 写，会覆盖
  bootloader、分区表和 NVS —— 芯片从此没有可用分区表，表现为「开机一直重启、
  串口刷 SHA-256 comparison failed」。2026-11-16 实测踩过一次，故加整包检查。

注意：本机 COM4/COM5 是「蓝牙链接上的标准串行」虚拟口，没有 VID，必须跳过。
"""
import os
import sys
import glob
import argparse
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 真实 USB 设备的 VID 优先级（C3 原生 USB 最优先）
VID_PRIORITY = {0x303A: 0, 0x1A86: 1, 0x10C4: 2, 0x0403: 3}


def list_ports():
    try:
        from serial.tools import list_ports as lp
    except ImportError:
        print("pyserial missing; run under the managed venv python")
        return []
    out = []
    for p in lp.comports():
        vid = getattr(p, "vid", None)
        out.append((p.device, vid, getattr(p, "pid", None), p.description or ""))
    return out


def pick_port():
    ports = list_ports()
    real = [p for p in ports if p[1] is not None]   # 只认有 VID 的真实 USB
    if not real:
        return None
    real.sort(key=lambda p: (VID_PRIORITY.get(p[1], 99), p[0]))
    return real[0][0]


def find_merged():
    hits = sorted(glob.glob(os.path.join(ROOT, "moink_*_merged.bin")))
    return hits[-1] if hits else None


def looks_merged(path):
    """整包判据：0x0 是 ESP 镜像魔数、0x8000 是分区表魔数 0xAA50、0x10000 又是镜像魔数。

    单独给 app 镜像时 0x8000 处不是分区表，这里会判否 —— 那种文件只能写到
    0x10000，写到 0x0 会把 bootloader + 分区表 + NVS 一起盖掉。
    """
    try:
        with open(path, "rb") as f:
            head = f.read(0x10001)
    except OSError:
        return False
    if len(head) < 0x10001:
        return False
    return (head[0:1] == b"\xe9"
            and head[0x8000:0x8002] == b"\xaa\x50"
            and head[0x10000:0x10001] == b"\xe9")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--port", default=None)
    ap.add_argument("--bin", default=None)
    ap.add_argument("--baud", type=int, default=460800)
    ap.add_argument("--no-stub", action="store_true")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if args.list:
        for dev, vid, pid, desc in list_ports():
            tag = ("VID 0x%04X PID 0x%04X" % (vid, pid)) if vid is not None else "no VID (virtual)"
            print("%-8s %-28s %s" % (dev, tag, desc))
        return 0

    port = args.port or pick_port()
    if not port:
        print("no real USB serial device found (virtual ports without VID are skipped)")
        print("connect the board over its native USB and retry, or pass --port")
        return 1

    binfile = args.bin or find_merged()
    if not binfile or not os.path.exists(binfile):
        print("no merged bin found; run package_bins.py first")
        return 1

    if not args.force and not looks_merged(binfile):
        print("!! 拒绝烧录：%s 不是整包" % os.path.basename(binfile))
        print("   整包 = bootloader@0x0 + 分区表@0x8000 + app@0x10000；")
        print("   把 app 镜像按 0x0 写会覆盖 bootloader/分区表/NVS，设备将无法启动。")
        print("   先跑：python tools/package_bins.py <tag> 生成 moink_<tag>_merged.bin")
        print("   确认要强写请加 --force。")
        return 2

    print("flash  : %s" % binfile)
    print("port   : %s @ %d" % (port, args.baud))
    if not args.keep:
        print("hint   : if it hangs at 'Stub running...', unplug/replug USB and retry with --no-stub")

    cmd = [sys.executable, "-m", "esptool",
           "--chip", "esp32c3",
           "--port", port,
           "--baud", str(args.baud)]
    if args.no_stub:
        cmd.append("--no-stub")
    cmd += ["write_flash", "0x0", binfile]

    r = subprocess.run(cmd)
    if r.returncode == 0:
        print("done. 首次上电：旧热点 EinkFrame-* 会消失，改连 MoInk-* 热点。")
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
