#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_frame_post.py —— PC 直连传帧诊断（绕过手机页面，标准库零依赖）。

作用：从电脑直接 POST 一个「黑/白/黄/红 四色横条」测试帧到设备，
     ①看设备返回的真实结果（定位传图失败原因）
     ②屏幕显示四色条 = 顺便验证色码 + 180° 方向 + 整条刷新链路

用法：
  1. 电脑 WiFi 连上 MoInk-XXXX 热点（不动设备其他设置）
  2. 任意装了 Python 3 的机器上运行：
       python test_frame_post.py            （默认发 http://192.168.4.1）
       python test_frame_post.py 192.168.4.1
"""
import struct
import sys
import urllib.request

W, H = 768, 552
BLACK, WHITE, YELLOW, RED = 0x00, 0x01, 0x02, 0x03


def crc16_ccitt_false(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if (crc & 0x8000) else (crc << 1)
            crc &= 0xFFFF
    return crc


def build_frame():
    """四条横带：上→下 = 黑 / 白 / 黄 / 红（逻辑图方向）。"""
    rb = W >> 2
    idx = bytearray(W * H)
    band = H // 4
    for y in range(H):
        color = (BLACK, WHITE, YELLOW, RED)[min(y // band, 3)]
        row = y * W
        for x in range(W):
            idx[row + x] = color
    # 180° 契约：缓冲行 r = 逻辑行 H-1-r，字节内 2bit 组也倒
    payload = bytearray(rb * H)
    for r in range(H):
        src_row = (H - 1 - r) * W
        dst_row = r * rb
        for xb in range(rb):
            xa = W - 4 - (xb << 2)
            v = ((idx[src_row + xa + 3] & 3) << 6) | ((idx[src_row + xa + 2] & 3) << 4) \
              | ((idx[src_row + xa + 1] & 3) << 2) | (idx[src_row + xa] & 3)
            payload[dst_row + xb] = v
    hdr = struct.pack(">2sBBHHIHH",
                      b"\xA5\x5A", 1, 0,   # 魔数 / 版本1 / 面板0=A0(信息性)
                      W, H, len(payload),
                      crc16_ccitt_false(payload), 0)
    return hdr + bytes(payload)


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "192.168.4.1"
    url = "http://%s/api/frame" % host
    body = build_frame()
    print("POST %s  (%d 字节, 头16 + 载荷%d)" % (url, len(body), len(body) - 16))
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print("HTTP", resp.status, resp.read().decode(errors="replace"))
            print()
            print(">> 设备已收帧，屏幕应显示 上→下 = 黑/白/黄/红 四条横带（约15~25秒）。")
            print(">> 若条带颜色或顺序不对，请拍照发我。")
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode(errors="replace"))
        print(">> 设备拒绝了帧：把上面这行报错发我。")
    except Exception as e:
        print("连接失败：%s" % e)
        print(">> 检查电脑是否连上 MoInk-XXXX 热点；手机连着不影响，可同时在线。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
