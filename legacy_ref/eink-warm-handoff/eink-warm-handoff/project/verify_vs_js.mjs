// Cross-check the *shipped* HTML algorithm against the Python reference.
// The script is extracted from the HTML verbatim, run in a VM with DOM stubs,
// then compared pixel for pixel with the numpy implementation.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const X = path.join(dir, 'xcheck');

// ---------------------------------------------------------------- extract
const html = fs.readFileSync(path.join(dir, 'eink-warm-converter.html'), 'utf8');
const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) throw new Error('no <script> found in the HTML');
const code = blocks[blocks.length - 1];
fs.writeFileSync(path.join(X, 'extracted.js'), code);
console.log(`extracted ${code.length} bytes of script from the HTML`);

// ---------------------------------------------------------------- DOM stub
function catchAll() {
  const target = function () {};
  const p = new Proxy(target, {
    get(t, k) {
      if (k === 'then') return undefined;
      if (k === 'length') return 0;
      if (k === Symbol.toPrimitive) return () => '[stub]';
      if (k === Symbol.iterator) return undefined;
      if (k === 'toString') return () => '[stub]';
      if (k === 'forEach' || k === 'map' || k === 'filter') return () => [];
      return p;
    },
    set() { return true; },
    apply() { return p; },
    construct() { return p; },
  });
  return p;
}
const win = { addEventListener() {}, removeEventListener() {} };
const sandbox = {
  window: win,
  document: {
    getElementById: () => catchAll(),
    createElement: () => catchAll(),
    querySelectorAll: () => [],
    addEventListener() {},
    body: catchAll(),
  },
  console, setTimeout, clearTimeout, queueMicrotask,
  Image: catchAll(), FileReader: catchAll(), URL,
  Blob, Response, CompressionStream, DecompressionStream,
  TextEncoder, TextDecoder, navigator: {},
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'eink-warm-converter.js' });

const api = win.__eink;
if (!api) throw new Error('window.__eink was not exposed — script failed to finish');
console.log('script executed cleanly; __eink v' + api.version + ' available\n');

// ---------------------------------------------------------------- compare
const man = JSON.parse(fs.readFileSync(path.join(X, 'cases.json'), 'utf8'));
const { w: W, h: H } = man;
const u8 = fs.readFileSync(path.join(X, 'test_rgb.u8'));
const srcFlat = new Float64Array(W * H * 3);
for (let i = 0; i < srcFlat.length; i++) srcFlat[i] = u8[i];

const readF64 = p => {
  const b = fs.readFileSync(p);
  return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const readU8 = p => new Uint8Array(fs.readFileSync(p));

let totalMismatch = 0, worst = 0, checked = 0;
console.log('case                 pix-exact   max|Δ|   idx match   R+Y(js/py)');
console.log('-'.repeat(72));

for (const [name, info] of Object.entries(man.cases)) {
  const cfg = info.cfg;
  const mapped = api.warmMapFlat(srcFlat, W, H, cfg);
  const idx = api.ditherFlat(mapped, W, H, cfg.dither, cfg.ditherStrength);

  const refM = readF64(path.join(X, name + '_mapped.f64'));
  const refI = readU8(path.join(X, name + '_idx.u8'));

  let maxd = 0, exact = 0;
  for (let i = 0; i < refM.length; i++) {
    const d = Math.abs(refM[i] - mapped[i]);
    if (d === 0) exact++;
    if (d > maxd) maxd = d;
  }
  let diff = 0;
  for (let i = 0; i < refI.length; i++) if (refI[i] !== idx[i]) diff++;

  const jsChroma = api.statsFromIndex(idx).chroma;
  totalMismatch += diff;
  worst = Math.max(worst, maxd);
  checked++;

  console.log(
    name.padEnd(20) +
    `${(exact / refM.length * 100).toFixed(3)}%`.padStart(10) +
    `${maxd.toExponential(1)}`.padStart(10) +
    `${diff === 0 ? '100%' : (100 - diff / refI.length * 100).toFixed(3) + '%'}`.padStart(12) +
    `   ${(jsChroma * 100).toFixed(1)}/${(info.chroma * 100).toFixed(1)}`
  );
}

console.log('-'.repeat(72));
console.log(`cases checked      : ${checked}`);
console.log(`max float delta    : ${worst.toExponential(2)}  (relative ~1e-15 = last-bit rounding)`);
console.log(`total index diff   : ${totalMismatch} pixel(s)  <- this is the file that reaches the screen`);
const pass = totalMismatch === 0 && worst < 1e-9;
console.log(pass
  ? '\nRESULT: PASS — the shipped JS reproduces the numpy reference exactly at pixel level.'
  : '\nRESULT: FAIL — differences present, see table above.');
process.exit(pass ? 0 : 1);
