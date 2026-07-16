// Separate-process ground-truth oracle: samples GetWindowDisplayAffinity for
// every top-level window of the target PID every ~15ms and emits a JSONL event
// whenever a window appears / its affinity or visibility changes.
// usage: node probe.js <pid>   (cwd must be the repo so koffi resolves)
'use strict';
const { createRequire } = require('module');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const req = createRequire(path.join(REPO, 'noop.js'));
const koffi = req('koffi');

const PID = Number(process.argv[2]);
if (!PID) {
  console.error('usage: node probe.js <pid>');
  process.exit(2);
}

const user32 = koffi.load('user32.dll');
const GetTopWindow = user32.func('__stdcall', 'GetTopWindow', 'uint64', ['uint64']);
const GetWindow = user32.func('__stdcall', 'GetWindow', 'uint64', ['uint64', 'uint32']);
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['uint64', 'void *']);
const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'bool', ['uint64']);
const GetWindowTextW = user32.func('__stdcall', 'GetWindowTextW', 'int', ['uint64', 'void *', 'int']);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', ['uint64', 'void *']);
const GetWindowDisplayAffinity = user32.func('__stdcall', 'GetWindowDisplayAffinity', 'bool', ['uint64', 'void *']);
const GW_HWNDNEXT = 2;

const pidBuf = Buffer.alloc(4);
const affBuf = Buffer.alloc(4);
const rectBuf = Buffer.alloc(16);
const titleBuf = Buffer.alloc(1024);

const last = new Map(); // hwnd(str) -> {aff, vis}
let samples = 0;

function tick() {
  const t = Date.now();
  let h = GetTopWindow(0n);
  while (h) {
    GetWindowThreadProcessId(h, pidBuf);
    if (pidBuf.readUInt32LE(0) === PID) {
      const n = GetWindowTextW(h, titleBuf, 512);
      const title = titleBuf.toString('utf16le', 0, Math.max(0, n) * 2);
      const vis = IsWindowVisible(h);
      let aff = null;
      if (GetWindowDisplayAffinity(h, affBuf)) aff = affBuf.readUInt32LE(0);
      let rect = null;
      if (GetWindowRect(h, rectBuf)) {
        rect = [
          rectBuf.readInt32LE(0),
          rectBuf.readInt32LE(4),
          rectBuf.readInt32LE(8),
          rectBuf.readInt32LE(12),
        ];
      }
      samples++;
      const key = h.toString();
      const prev = last.get(key);
      if (!prev || prev.aff !== aff || prev.vis !== vis) {
        last.set(key, { aff, vis });
        process.stdout.write(
          JSON.stringify({ t, hwnd: key, title, vis, aff, rect }) + '\n',
        );
      }
    }
    h = GetWindow(h, GW_HWNDNEXT);
  }
}

setInterval(tick, 15);
setInterval(() => {
  process.stdout.write(JSON.stringify({ t: Date.now(), stats: { samples } }) + '\n');
}, 5000);
