#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""serial_cap.py —— 实时落盘的串口录制（边跑边读，不用等结束）。

用法（受管 venv 解释器）：
    python tools/serial_cap.py [COM 口] [秒数] [输出文件]

例：
    python tools/serial_cap.py COM16 600 serial_cap.txt

为什么不用 `read > file` 或缓冲区攒到最后：
    固件日志级别被压到 ERROR，平时没有输出；现场复现往往只有几行。
    之前攒到最后一次性写盘，脚本没结束就什么都看不到（2026-11-16 踩过）。
    这里每读到一块就 write + flush，另一头可以随时 tail。

★★ 为什么必须显式放开 DTR/RTS（2026-11-16 踩过，白等三次录制）：
    ESP32-C3 的 USB-Serial/JTAG 把 RTS 接到 EN、DTR 接到 GPIO9。
    pyserial 打开端口时默认把两者置为 True —— 等于**一直按住复位**，
    于是全程 0 字节，看起来像"设备没反应"，其实是被脚本按住了。
    所以打开后立刻置 False，让芯片正常跑。
"""
import sys
import time

import serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM16"
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 600
out = sys.argv[3] if len(sys.argv) > 3 else "serial_cap.txt"

f = open(out, "wb", buffering=0)
t0 = time.time()
reopens = 0
bytes_total = 0
s = None


def _open():
    """打开并立刻放开 EN/DTR：否则芯片被按住复位，一个字节都读不到。"""
    ser = serial.Serial(port, 115200, timeout=0.2)
    ser.dtr = False
    ser.rts = False
    return ser


while time.time() - t0 < secs:
    if s is None:
        try:
            s = _open()
        except Exception:
            time.sleep(0.3)
            continue
    try:
        while time.time() - t0 < secs:
            d = s.read(4096)
            if d:
                f.write(d)
                f.flush()
                bytes_total += len(d)
    except Exception:
        reopens += 1
        try:
            s.close()
        except Exception:
            pass
        s = None

if s is not None:
    try:
        s.close()
    except Exception:
        pass
f.close()
print("captured %d bytes, reopens %d -> %s" % (bytes_total, reopens, out))
