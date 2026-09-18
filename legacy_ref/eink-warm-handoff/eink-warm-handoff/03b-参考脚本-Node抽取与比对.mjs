// Template: run the JS shipped inside a single-file HTML tool under Node, with DOM stubs,
// then compare its output against binary reference files produced by a Python/numpy model.
//
// Adapt the CONFIG block and the comparison loop; the extraction + stubbing machinery is
// the part worth copying verbatim.
//
//   node extract_and_run_js.mjs
//
// Prerequisite: the HTML exposes its pure functions, e.g.
//   window.__tool = { convert, encode };

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

// ----------------------------------------------------------------- CONFIG
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const HTML = path.join(HERE, 'tool.html');          // the shipped artefact
const REF_DIR = path.join(HERE, 'xcheck');          // reference binaries live here
const API = '__tool';                               // window property holding the functions
const EPS = 1e-9;                                   // float gate; indices must be exact
// ------------------------------------------------------------------------

// 1. Extract the last <script> block, verbatim, from the shipped HTML.
const html = fs.readFileSync(HTML, 'utf8');
const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) throw new Error('no <script> found in ' + HTML);
const code = blocks[blocks.length - 1];
console.log(`extracted ${code.length} bytes of script`);

// 2. Catch-all Proxy used for every DOM object. Any property read, call, construction or
//    assignment succeeds and returns the same proxy, so all UI wiring executes harmlessly
//    while the pure functions stay reachable. List-returning members are special-cased so
//    `document.querySelectorAll(...).forEach(...)` iterates zero times.
function stub() {
  const target = function () {};
  const p = new Proxy(target, {
    get(t, k) {
      if (k === 'then') return undefined;            // do not look like a promise
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

// 3. Build the sandbox. window must be a real object because the script assigns to it.
//    Anything the script touches that Node does not expose globally has to be listed here.
const win = { addEventListener() {}, removeEventListener() {} };
const sandbox = {
  window: win,
  document: {
    getElementById: () => stub(),
    createElement: () => stub(),
    querySelectorAll: () => [],
    addEventListener() {},
    body: stub(),
  },
  console, setTimeout, clearTimeout, queueMicrotask,
  Image: stub(), FileReader: stub(),
  URL, Blob, Response, CompressionStream, DecompressionStream,
  TextEncoder, TextDecoder, navigator: {},
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: path.basename(HTML) + '.js' });

const api = win[API];
if (!api) throw new Error(`window.${API} was never assigned — the script threw part-way through`);
console.log(`${API} is available — the page script executes cleanly\n`);

// 4. Compare. Reference inputs/outputs are written by the Python model as raw binary.
const man = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'cases.json'), 'utf8'));
const readF64 = p => {
  const b = fs.readFileSync(p);
  return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const readU8 = p => new Uint8Array(fs.readFileSync(p));

const input = readF64(path.join(REF_DIR, 'input.f64'));   // the test input, flat
let totalBad = 0, worst = 0;

for (const [name, info] of Object.entries(man.cases)) {
  const { floatOut, u8Out } = api.convert(input, man.w, man.h, info.cfg); // <- adapt
  const refF = readF64(path.join(REF_DIR, `${name}_float.f64`));
  const refU = readU8(path.join(REF_DIR, `${name}_u8.u8`));

  let maxd = 0, exact = 0;
  for (let i = 0; i < refF.length; i++) {
    const d = Math.abs(refF[i] - floatOut[i]);
    if (d === 0) exact++;
    if (d > maxd) maxd = d;
  }
  let bad = 0;
  for (let i = 0; i < refU.length; i++) if (refU[i] !== u8Out[i]) bad++;

  totalBad += bad;
  worst = Math.max(worst, maxd);
  console.log(
    name.padEnd(22) +
    `${(exact / refF.length * 100).toFixed(2)}%`.padStart(10) + ' exact   ' +
    `maxΔ ${maxd.toExponential(1)}`.padStart(20) +
    `   mismatched samples: ${bad}`
  );
}

const pass = totalBad === 0 && worst < EPS;
console.log('\n' + (pass
  ? 'PASS — the shipped JS reproduces the reference exactly at output level.'
  : 'FAIL — see the table above; float deltas above 1e-9 or any sample mismatch are logic bugs.'));
process.exit(pass ? 0 : 1);
