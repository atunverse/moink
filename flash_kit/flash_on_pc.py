#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
flash_on_pc.py —— 异地一键刷机助手（供 MoInk一键刷机.bat 调用，也可命令行单独运行）。

本板是 ESP32-C3 原生 USB-Serial/JTAG（VID 0x303a / PID 0x1001）。
不要用浏览器网页烧录器（WebSerial）——会卡死在 "Stub running..."，一个字节都写不进。

用法：
  python flash_on_pc.py                自动选口 + 刷同目录 moink_*_merged.bin
  python flash_on_pc.py --list         只列串口（含 VID 信息，虚拟口标 no VID）
  python flash_on_pc.py --port COM7    手动指定串口
  python flash_on_pc.py --baud 115200  降波特率
  python flash_on_pc.py --no-stub      走 ROM 加载器（卡在 Stub running... 的兜底）
"""
import argparse
import glob
import os
import subprocess
import sys

# 真实 USB 设备 VID 优先级（C3 原生 USB-JTAG 最优先；无 VID 的蓝牙虚拟口会被跳过）
VID_PRIORITY = {0x303A: 0, 0x1A86: 1, 0x10C4: 2, 0x0403: 3}


def list_ports():
    from serial.tools import list_ports as lp
    return [(p.device, getattr(p, "vid", None), getattr(p, "pid", None),
             p.description or "") for p in lp.comports()]


def pick_port():
    real = [p for p in list_ports() if p[1] is not None]   # 只认有 VID 的真实 USB
    if not real:
        return None
    real.sort(key=lambda p: (VID_PRIORITY.get(p[1], 99), p[0]))
    return real[0][0]


def find_merged():
    here = os.path.dirname(os.path.abspath(__file__))
    hits = sorted(glob.glob(os.path.join(here, "moink_*_merged.bin")))
    return hits[-1] if hits else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="只列串口")
    ap.add_argument("--port", default=None, help="手动指定串口，如 COM7")
    ap.add_argument("--bin", default=None, help="手动指定镜像文件")
    ap.add_argument("--baud", type=int, default=460800, help="波特率（默认 460800）")
    ap.add_argument("--no-stub", action="store_true", help="走 ROM 加载器（卡死兜底）")
    a = ap.parse_args()

    if a.list:
        print("全部串口（无 VID 的为蓝牙等虚拟口，刷机会自动跳过）：")
        for dev, vid, pid, desc in list_ports():
            tag = ("VID 0x%04X PID 0x%04X" % (vid, pid)) if vid else "no VID (virtual, skip)"
            print("  %-10s %-26s %s" % (dev, tag, desc))
        return 0

    port = a.port or pick_port()
    if not port:
        print("[错误] 没发现带 VID 的真实 USB 串口（无 VID 的蓝牙虚拟口已跳过）。")
        print("       请用数据线插好板子后重试；或用 --port COMx 手动指定；")
        print("       可用 --list 查看本机全部串口。")
        return 1

    binfile = a.bin or find_merged()
    if not binfile or not os.path.exists(binfile):
        print("[错误] 找不到 moink_*_merged.bin。")
        print("       请把固件和本脚本、bat 放在同一个文件夹里再运行。")
        return 1

    print("镜像 : %s（%d 字节）" % (os.path.basename(binfile), os.path.getsize(binfile)))
    print("串口 : %s @ %d" % (port, a.baud))
    print("方式 : 0x0 整包写入（含 bootloader + 分区表 + 固件，会整体覆盖旧固件）")
    print()

    cmd = [sys.executable, "-m", "esptool",
           "--chip", "esp32c3",
           "--port", port,
           "--baud", str(a.baud)]
    if a.no_stub:
        cmd.append("--no-stub")
    cmd += ["write_flash", "0x0", binfile]

    r = subprocess.run(cmd)

    if r.returncode == 0:
        print()
        print("[OK] 刷机完成！设备即将重启。")
        print("     手机 Wi-Fi 连接热点 MoInk-XXXX（默认开放），自动弹出控制页；")
        print("     或浏览器打开 http://192.168.4.1 。固件版本应显示 R1.1.1。")
    else:
        print()
        print("[失败] esptool 退出码 %d。" % r.returncode)
        if not a.no_stub:
            print("若日志卡在 'Stub running...'（C3 USB-JTAG 已知问题），请：")
            print("  1. 拔插一次 USB 线")
            print("  2. 再运行: python %s --no-stub" % os.path.basename(__file__))
        print("其他排查：换一根能传数据的 USB 线；设备管理器里确认出现串口。")
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
