/* ==================================================================
   13-pack.js —— 2bpp 打包与帧头（与固件 frame.c 契约一致）
   ================================================================== */
/* ==================================================================
   帧头（16 字节，大端）+ CRC16，与固件 frame.c 一致
   ================================================================== */
function crc16(data){
  var crc = 0xFFFF;
  for (var i = 0; i < data.length; i++){
    crc ^= data[i] << 8;
    for (var b = 0; b < 8; b++){
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}
function frameWithHeader(payload){
  var hdr = new Uint8Array(16);
  var len = payload.length;
  var crc = crc16(payload);
  /* hdr[2]：1 = 768x552 载荷（R1.2.2 起唯一几何；原 800x600 对照档已删除）。 */
  hdr[0] = 0xA5; hdr[1] = 0x5A; hdr[2] = 1; hdr[3] = PANEL.id;
  hdr[4] = (PANEL.w >> 8) & 0xFF; hdr[5] = PANEL.w & 0xFF;
  hdr[6] = (PANEL.h >> 8) & 0xFF; hdr[7] = PANEL.h & 0xFF;
  hdr[8] = (len >>> 24) & 0xFF; hdr[9] = (len >>> 16) & 0xFF;
  hdr[10] = (len >>> 8) & 0xFF; hdr[11] = len & 0xFF;
  hdr[12] = (crc >>> 8) & 0xFF; hdr[13] = crc & 0xFF;
  hdr[14] = 0; hdr[15] = 0;
  var out = new Uint8Array(16 + len);
  out.set(hdr, 0); out.set(payload, 16);
  return out;
}
