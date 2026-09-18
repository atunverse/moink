#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_frame.py —— 帧契约金标准测试（api = 1）。

独立实现三样东西，与固件 frame.c / 页面 crc16() 交叉核对：
  1. CRC-16/CCITT-FALSE（poly 0x1021，init 0xFFFF，无反射、无终异或）
     —— 用标准测试向量 "123456789" 校验。
  2. 16 字节大端帧头（魔数 / 版本 / 面板 / 宽高 / 载荷长 / CRC16 / 保留）。
  3. packIdx 的 180° + 2bpp 打包契约：已知色块落点必须与固件期望一致。

三项全部通过才退出码 0；任一失败退出码 1。
"""

PASS = 0
FAIL = 1


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc


def frame_header(panel, w, h, payload):
    crc = crc16(payload)
    L = len(payload)
    return bytes([
        0xA5, 0x5A, 1, panel,
        (w >> 8) & 0xFF, w & 0xFF,
        (h >> 8) & 0xFF, h & 0xFF,
        (L >> 24) & 0xFF, (L >> 16) & 0xFF, (L >> 8) & 0xFF, L & 0xFF,
        (crc >> 8) & 0xFF, crc & 0xFF,
        0, 0,
    ])


def pack_idx(idx, w, h):
    """页面 packIdx() 的 Python 等价：行 H-1-r，列倒序，字节内 2bit 组倒序。"""
    RB = w >> 2
    out = bytearray(RB * h)
    for r in range(h):
        ro = (h - 1 - r) * w
        bo = r * RB
        for xb in range(RB):
            xa = w - 4 - (xb << 2)
            out[bo + xb] = (idx[ro + xa + 3] << 6) | (idx[ro + xa + 2] << 4) | \
                           (idx[ro + xa + 1] << 2) | idx[ro + xa]
    return bytes(out)


def main():
    ok = True

    # 1. CRC 标准向量
    if crc16(b"123456789") != 0x29B1:
        print("FAIL: crc16('123456789') = 0x%04X, expect 0x29B1" % crc16(b"123456789"))
        ok = False
    else:
        print("OK: crc16 golden vector 0x29B1")

    # 2. 帧头字段
    payload = bytes(range(256)) * 4
    hdr = frame_header(0, 768, 552, payload)
    assert len(hdr) == 16
    assert hdr[0] == 0xA5 and hdr[1] == 0x5A and hdr[2] == 1 and hdr[3] == 0
    assert (hdr[4] << 8 | hdr[5]) == 768
    assert (hdr[6] << 8 | hdr[7]) == 552
    L = (hdr[8] << 24) | (hdr[9] << 16) | (hdr[10] << 8) | hdr[11]
    assert L == len(payload)
    assert (hdr[12] << 8 | hdr[13]) == crc16(payload)
    print("OK: frame header fields (magic/ver/panel/w/h/len/crc)")

    # 3. packIdx 打包单元：四种纯色 -> 每字节 4 个同色 2bit 组
    w, h = 768, 552
    expect = {0: 0x00, 1: 0x55, 2: 0xAA, 3: 0xFF}
    for col, byte in expect.items():
        idx = [col] * (w * h)
        packed = pack_idx(idx, w, h)
        assert len(packed) == (w // 4) * h == 105984, "wrong buffer length"
        assert all(b == byte for b in packed), "solid colour %d packed wrong" % col
    print("OK: packIdx solid colours (K/W/Y/R) + 105984-byte buffer")

    # 4. 180 度落点：逻辑 (0,0)=红 应在缓冲最末行、最末字节的最低 2bit
    idx = [1] * (w * h)
    idx[0] = 3
    packed = pack_idx(idx, w, h)
    RB = w >> 2
    last_byte = packed[(h - 1) * RB + (RB - 1)]
    if (last_byte & 0x03) != 3:
        print("FAIL: packIdx logical(0,0)=red not at buffer tail low bits (got 0x%02x)" % last_byte)
        ok = False
    else:
        print("OK: packIdx 180-degree placement")

    print("RESULT:", "PASS" if ok else "FAIL")
    return PASS if ok else FAIL


if __name__ == "__main__":
    raise SystemExit(main())
