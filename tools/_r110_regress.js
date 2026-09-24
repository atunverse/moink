/* R1.1.0（FB-010）门禁（R1.2.0 起新页 = page-R1.2.0.html）：
   A) 768x552 老路径零回归：备份页（R1.0.26）vs 新页
      crc16 / rotateCW / packIdx / frameWithHeader 逐字节一致
   B) 新几何：panelGeomOf 的 api 门槛；R1.1.2（FB-013）起
      mode 1 = 768x552（默认正解）、mode 2 = 800x600（对照档）
   C) 原生 800x600 帧：长度 120000、帧头版本 2、宽高正确、CRC 自洽
   D) 结构性伪影消除：原生 600 行打包结果无「强制重复行」
      （R1.0.11 的 552→600 最近邻拉伸会产生 48 行重复 = 摩尔纹根源）
/* 用法: node tools/_r110_regress.js [old_page.html] [new_page.html]
   不传参时默认用仓库根目录的 page-R1.0.26.html（基线）与 page-R1.2.0.html（本版）。
   R1.2.0 只动版本号显示与升级入口；纯函数段（crc16/rotateCW/packIdx/frameWithHeader/
   panelGeomOf）不应有任何变化，故本门禁仍按 R1.1.0 的零回归标准执行。 */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const REPO = path.resolve(__dirname, "..");

function pureSection(file) {
  const page = fs.readFileSync(file, "utf8");
  const m = page.match(/<script>\r?\n"use strict";\r?\n([\s\S]*?)\r?\n<\/script>/);
  if (!m) throw new Error("main script not found in " + file);
  const js = m[1];
  const cut = js.indexOf("var $ = function");
  if (cut < 0) throw new Error("pure-section marker missing");
  return js.slice(0, cut);
}
function sandboxOf(file) {
  const s = { window: {}, console: { log: function(){} }, Uint8Array, Float64Array,
              Int32Array, Math, JSON, Infinity, NaN, Date };
  s.globalThis = s;
  vm.createContext(s);
  vm.runInContext(pureSection(file), s, { filename: file });
  return s;
}

const OLD_PAGE = process.argv[2] || path.join(REPO, "page-R1.0.26.html");
const NEW_PAGE = process.argv[3] || path.join(REPO, "page-R1.2.0.html");
const oldS = sandboxOf(OLD_PAGE);
const newS = sandboxOf(NEW_PAGE);
console.log("old page: " + OLD_PAGE);
console.log("new page: " + NEW_PAGE);

let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (detail !== undefined ? "  -> " + detail : ""));
  if (!cond) fail++;
}
function byteEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; }; }

/* ---------- A. 768x552 零回归 ---------- */
{
  // CRC
  const v = new Uint8Array([0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39]);
  check("A1 crc16 identical", oldS.crc16(v) === newS.crc16(v),
        "0x" + newS.crc16(v).toString(16));

  // rotateCW（552x768 竖屏）随机图
  let diff = 0;
  for (let k = 0; k < 6; k++) {
    const r = rnd(900 + k * 31);
    const idx = new Uint8Array(552 * 768);
    for (let i = 0; i < idx.length; i++) idx[i] = (r() * 4) | 0;
    const a = oldS.rotateCW(idx, 552, 768), b = newS.rotateCW(idx, 552, 768);
    if (!byteEq(a, b)) diff++;
    const pa = oldS.packIdx(a), pb = newS.packIdx(b);
    if (!byteEq(pa, pb)) diff++;
    const fa = oldS.frameWithHeader(pa), fb = newS.frameWithHeader(pb);
    if (!byteEq(fa, fb)) diff++;
  }
  check("A2 768x552 rotateCW/packIdx/frame byte-identical (6 random cases)", diff === 0, diff + " diff");

  // 纯色打包（既有金标准）
  const white = new Uint8Array(768 * 552).fill(1);
  const bw = newS.packIdx(white);
  check("A3 packIdx all-white == 0x55 len105984",
        bw.length === 105984 && bw.every(function (b) { return b === 0x55; }));
}

/* ---------- B. 几何门槛 ---------- */
{
  check("B1 A1 + default mode 1 -> 768x552",
        newS.panelGeomOf(1, 1).w === 768 && newS.panelGeomOf(1, 1).h === 552);
  check("B1b A1 + leftover mode 3/4 -> 768x552 (safe fallback)",
        newS.panelGeomOf(1, 3).w === 768 && newS.panelGeomOf(1, 3).h === 552);
  check("B2 A0 ignores a1 mode",
        newS.panelGeomOf(0, 1).w === 768 && newS.panelGeomOf(0, 1).h === 552);
  vm.runInContext("DEV_API = 2;", newS);
  const gD = newS.panelGeomOf(1, 1), gN = newS.panelGeomOf(1, 2);
  check("B3 A1 + api2 + mode 2 (native800) -> 800x600",
        gN.w === 800 && gN.h === 600, gN.w + "x" + gN.h);
  check("B4 A1 + api2 + mode 1 (default) -> 768x552", gD.w === 768 && gD.h === 552);
  vm.runInContext("DEV_API = 1;", newS);
  check("B5 api<2 forces 768x552 even for native800 mode",
        newS.panelGeomOf(1, 2).w === 768 && newS.panelGeomOf(1, 2).h === 552);
  vm.runInContext("DEV_API = 2;", newS);
}

/* ---------- C. 原生 800x600 帧契约 ---------- */
{
  vm.runInContext("PANEL.w = 800; PANEL.h = 600; EW = 600; EH = 800;", newS);
  const idx = new Uint8Array(600 * 800);
  const r = rnd(4242);
  for (let i = 0; i < idx.length; i++) idx[i] = (r() * 4) | 0;
  const rot = newS.rotateCW(idx, 600, 800);
  check("C1 rotateCW 600x800 -> 800x600", rot.length === 480000);
  const payload = newS.packIdx(rot);
  check("C2 payload length 120000", payload.length === 120000, payload.length);
  const frame = newS.frameWithHeader(payload);
  check("C3 frame total 120016", frame.length === 120016, frame.length);
  check("C4 header version 2", frame[2] === 2, frame[2]);
  const w = (frame[4] << 8) | frame[5], h = (frame[6] << 8) | frame[7];
  const len = (frame[8] << 24) | (frame[9] << 16) | (frame[10] << 8) | frame[11];
  check("C5 width/height 800x600", w === 800 && h === 600, w + "x" + h);
  check("C6 len field 120000", len === 120000, len);
  check("C7 crc matches payload", ((frame[12] << 8) | frame[13]) === newS.crc16(payload));

  // 768x552 仍是版本 1
  vm.runInContext("PANEL.w = 768; PANEL.h = 552; EW = 552; EH = 768;", newS);
  const f2 = newS.frameWithHeader(new Uint8Array(105984));
  check("C8 768x552 frame版本 1", f2[2] === 1 && f2.length === 106000);
}

/* ---------- D. 无强制重复行（摩尔纹根源） ---------- */
{
  // 600 行渐变图：原生路径每行都不同；R1.0.11 的 552->600 最近邻拉伸会重复 48 行
  vm.runInContext("PANEL.w = 800; PANEL.h = 600; EW = 600; EH = 800;", newS);
  const idx = new Uint8Array(600 * 800);
  const rr = rnd(777);
  for (let i = 0; i < idx.length; i++) idx[i] = (rr() * 4) | 0;
  const payload = newS.packIdx(newS.rotateCW(idx, 600, 800));
  const RB = 200, rows = 600, seen = new Set();
  for (let r2 = 0; r2 < rows; r2++) seen.add(Buffer.from(payload.slice(r2 * RB, r2 * RB + RB)).toString("hex"));
  check("D1 600 packed rows all distinct (no forced duplication)", seen.size === rows, seen.size + "/" + rows);
}

console.log(fail === 0 ? "R1.2.0 REGRESS: ALL PASS" : ("R1.2.0 REGRESS: " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
