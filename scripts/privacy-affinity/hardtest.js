// HARD E2E privacy test: launch the BUILT app (isolated userData, CDP on) and
// hammer EVERY edge action that could wipe a window's capture-exclusion, while
// probe.js (separate process) records the REAL GetWindowDisplayAffinity of every
// app window at ~15ms. The invariant under test: while Privacy Mode is ON, the
// DASHBOARD and the CUE CARD (overlay) stay 0x11 (WDA_EXCLUDEFROMCAPTURE) the
// ENTIRE time — through nav/dropdown/hover storms, a live interview (loopback
// capture = the known wipe trigger), a full Cue Card control storm, an OS-level
// "hold-and-drag" move storm, the region selector (hides+reshows both windows),
// dashboard minimize/restore, privacy re-asserts, and pause/resume/stop.
//
//   npm run build && node scripts/privacy-affinity/hardtest.js
//
// Verdict is per-window and strict: any sustained (>1 share-frame) capturable
// sample on the dashboard or Cue Card is a FAIL. Sub-frame dips healed by the
// off-thread observer are reported but pass (below a single Meet/Zoom frame).
'use strict';
const { createRequire } = require('module');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const HERE = __dirname;
const req = createRequire(path.join(REPO, 'noop.js'));
const WebSocket = req('ws');
const electronBin = req('electron');
const koffi = req('koffi');

// --- OS window control (driver-side, for the move/resize storms) ---
const user32 = koffi.load('user32.dll');
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'bool', [
  'uint64', 'uint64', 'int', 'int', 'int', 'int', 'uint32',
]);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', ['uint64', 'void *']);
const SWP_NOSIZE = 0x0001, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_NOSENDCHANGING = 0x0400;
const MOVE_FLAGS = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING;
function rectOf(hwnd) {
  const b = Buffer.alloc(16);
  if (!GetWindowRect(BigInt(hwnd), b)) return null;
  return { x: b.readInt32LE(0), y: b.readInt32LE(4), r: b.readInt32LE(8), b: b.readInt32LE(12) };
}
function moveTo(hwnd, x, y) {
  SetWindowPos(BigInt(hwnd), 0n, Math.round(x), Math.round(y), 0, 0, MOVE_FLAGS);
}

const CDP_PORT = 9232;
const OUT = path.join(HERE, '.out', 'hard'); // under the gitignored .out/
const USER_DATA = path.join(OUT, 'userdata');
const APP_LOG = path.join(OUT, 'app.log');
const PROBE_LOG = path.join(OUT, 'probe.jsonl');
const MARKS_LOG = path.join(OUT, 'marks.json');
const FRAME_MS = 120; // ~ one frame of a 8fps screen share; dips healed faster are sub-frame

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marks = [];
function mark(label) {
  const t = Date.now();
  marks.push({ t, label });
  console.log(`[mark ${new Date(t).toISOString().slice(11, 23)}] ${label}`);
}
async function step(label, fn) {
  mark(label);
  try { await fn(); } catch (e) { console.log(`   ! step "${label}" failed: ${e.message}`); }
}

// ---------- minimal CDP client ----------
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
  async moveMouse(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' });
  }
  async clickAt(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await sleep(30);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }
  async clickText(text, { contains = false } = {}) {
    const rect = await this.eval(`(() => {
      const wanted = ${JSON.stringify(text)};
      const match = (el) => {
        if (!el.textContent || el.offsetParent === null) return false;
        const t = el.textContent.trim();
        return ${contains ? 't.includes(wanted)' : 't === wanted'};
      };
      let el = [...document.querySelectorAll('button, a, [role="option"], [role="menuitem"], [role="button"]')].find(match)
            || [...document.querySelectorAll('div, span, li, label')].find(match);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!rect) return false;
    await this.clickAt(rect.x, rect.y);
    return true;
  }
  // Click the first element matching a CSS selector (its visible center).
  async clickSel(sel) {
    const rect = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el || el.offsetParent === null) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!rect) return false;
    await this.clickAt(rect.x, rect.y);
    return true;
  }
  // Robustly pick the sample profile: open the profile Dropdown (the first
  // aria-haspopup=listbox trigger) and click the option whose text contains
  // `needle`. Verifies the jobs table appeared (profileId set); retries.
  async selectProfile(needle) {
    for (let attempt = 0; attempt < 4; attempt++) {
      // Interviews card only renders once a profile is chosen — our success signal.
      const done = await this.eval(`!!document.querySelector('h3') && [...document.querySelectorAll('h3')].some(h => h.textContent.trim() === 'Interviews')`).catch(() => false);
      if (done) return true;
      await this.eval(`document.body.click()`); // ensure any open dropdown closes
      await sleep(150);
      await this.clickSel('[aria-haspopup="listbox"]'); // open the profile dropdown
      await sleep(350);
      const clicked = await this.eval(`(() => {
        const needle = ${JSON.stringify(needle)};
        const opt = [...document.querySelectorAll('[role="option"] button, [role="listbox"] button, li button')]
          .find(b => b.offsetParent !== null && b.textContent.includes(needle));
        if (!opt) return false;
        opt.click();
        return true;
      })()`).catch(() => false);
      await sleep(500);
    }
    return await this.eval(`[...document.querySelectorAll('h3')].some(h => h.textContent.trim() === 'Interviews')`).catch(() => false);
  }
  // Click the first enabled row Start (or Resume) button in the jobs table.
  async startInterview() {
    return await this.eval(`(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => b.offsetParent !== null && !b.disabled && /^(Start|Resume)$/.test(b.textContent.trim()));
      if (!btn) return false;
      btn.click();
      return true;
    })()`).catch(() => false);
  }
  // Hover the centers of the first N visible interactive elements (tooltip storm).
  async hoverSweep(n = 12) {
    const rects = await this.eval(`(() => {
      const els = [...document.querySelectorAll('button, a, [title], nav *, aside *')]
        .filter(e => e.offsetParent);
      const seen = new Set(), out = [];
      for (const e of els) {
        const r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const k = Math.round(r.x)+','+Math.round(r.y);
        if (seen.has(k)) continue; seen.add(k);
        out.push({ x: r.x + r.width/2, y: r.y + r.height/2 });
        if (out.length >= ${n}) break;
      }
      return out;
    })()`);
    for (const r of rects || []) { await this.moveMouse(r.x, r.y); await sleep(60); }
  }
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return res.json();
}
async function waitForTarget(pred, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const t = (await targets()).find(pred); if (t) return t; } catch {}
    await sleep(250);
  }
  throw new Error('target not found');
}

// ---------- live view of the probe stream (to find HWNDs for the OS storms) ----------
const live = new Map(); // hwnd -> { title, vis, aff, rect }
// App windows carry EMPTY OS titles (only the loopback anchor is titled), so
// label by SIZE: dashboard is large; the Cue Card is 440x460 (compact) / 520x680
// (expanded), min 360x240; the anchor is 320x240 (excluded by width). A fullscreen
// region selector also lands in the DASHBOARD-class bucket — it too must be 0x11.
function labelOf(e) {
  if (e.title === 'BrainCueLoopbackAnchor') return 'anchor';
  if (!e.rect) return 'other';
  const w = e.rect[2] - e.rect[0], h = e.rect[3] - e.rect[1];
  if (w >= 900 && h >= 550) return 'DASHBOARD';
  if (w >= 360 && w <= 760 && h >= 220 && h <= 760) return 'OVERLAY';
  return `other(${e.title || 'untitled'} ${w}x${h})`;
}
function hwndFor(label) {
  for (const [h, s] of live) if (s.label === label && s.vis) return h;
  return null;
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  for (const f of [APP_LOG, PROBE_LOG]) fs.rmSync(f, { force: true });

  const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
  const apiKey = (envFile.match(/OPENAI_API_KEY=(.+)/) || [])[1]?.trim();
  if (!apiKey) throw new Error('no OPENAI_API_KEY in repo .env');

  const env = {
    ...process.env,
    BRAINCUE_E2E: '1',
    E2E_CDP_PORT: String(CDP_PORT),
    E2E_USER_DATA: USER_DATA,
    OPENAI_API_KEY: apiKey,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  mark('app launch');
  const app = spawn(electronBin, [REPO], { env, cwd: REPO });
  const appLog = fs.createWriteStream(APP_LOG);
  const onAppLine = (buf) => {
    appLog.write(buf);
    for (const line of buf.toString().split('\n')) if (line.includes('[privacy]')) console.log('  app>', line.trim());
  };
  app.stdout.on('data', onAppLine);
  app.stderr.on('data', onAppLine);

  const probe = spawn(process.execPath, [path.join(HERE, 'probe.js'), String(app.pid)], { cwd: REPO });
  const probeLog = fs.createWriteStream(PROBE_LOG);
  let probeBuf = '';
  probe.stdout.on('data', (d) => {
    probeLog.write(d);
    probeBuf += d.toString();
    let nl;
    while ((nl = probeBuf.indexOf('\n')) >= 0) {
      const line = probeBuf.slice(0, nl); probeBuf = probeBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.stats || !e.hwnd) continue;
      const prev = live.get(e.hwnd) || {};
      live.set(e.hwnd, { title: e.title, vis: e.vis, aff: e.aff, rect: e.rect, label: prev.label || labelOf(e) });
    }
  });
  probe.stderr.on('data', (d) => console.error('probe!', d.toString()));

  const kill = () => { try { probe.kill(); } catch {} try { app.kill(); } catch {} };
  process.on('exit', kill);

  // OS-level "hold and drag the Cue Card" — churn the overlay's window position
  // for `ms`, exactly the storm-drag the user described, but driven at the OS
  // level so it doesn't depend on synthetic-input hit-testing.
  async function moveStorm(label, ms) {
    const hwnd = hwndFor(label);
    if (!hwnd) { console.log(`   ! moveStorm: no ${label} hwnd yet`); return; }
    const r = rectOf(hwnd);
    if (!r) return;
    const ox = r.x, oy = r.y;
    const end = Date.now() + ms;
    let n = 0;
    while (Date.now() < end) {
      const dx = Math.round((Math.random() - 0.5) * 260);
      const dy = Math.round((Math.random() - 0.5) * 180);
      moveTo(hwnd, ox + dx, oy + dy);
      n++;
      await sleep(8);
    }
    moveTo(hwnd, ox, oy); // park it back
    console.log(`   moveStorm(${label}): ${n} moves over ${ms}ms`);
  }

  // Confirm-leak check: every main-initiated confirm (turn off Privacy Mode,
  // Reset settings, Delete all data) must render as an IN-WINDOW modal in a
  // protected window — NOT a native OS dialog (a separate aff-0 window a share
  // can see). Trigger each, assert the modal is in the DOM and no native aff-0
  // window appears, then CANCEL it (privacy stays on, nothing is wiped).
  async function findModalCdp(cancelText) {
    for (const cdp of [dash, over]) {
      const has = await cdp
        .eval(
          `[...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent.trim() === ${JSON.stringify(cancelText)})`,
        )
        .catch(() => false);
      if (has) return cdp;
    }
    return null;
  }
  async function confirmLeakCheck() {
    const cases = [
      { label: 'privacy-disable', trigger: 'window.api.privacy.set(false)', cancel: 'Keep it on' },
      { label: 'reset-settings', trigger: 'window.api.settings.resetApp()', cancel: 'Cancel' },
      { label: 'wipe-data', trigger: 'window.api.data.wipeAll()', cancel: 'Cancel' },
    ];
    const out = [];
    for (const c of cases) {
      mark(`confirm-leak: trigger ${c.label}`);
      // Fire WITHOUT awaiting: main awaits our answer, so this promise stays open.
      await dash.eval(`(() => { ${c.trigger}; return true; })()`);
      let host = null;
      for (let i = 0; i < 24 && !host; i++) {
        await sleep(150);
        host = await findModalCdp(c.cancel);
      }
      const inWindow = !!host;
      // A native dialog would be a NEW visible app window at aff !== 0x11.
      const nativeLeak = [...live.values()].some(
        (w) =>
          w.vis && w.aff !== 0x11 && String(w.label).startsWith('other') && w.title !== 'BrainCueLoopbackAnchor',
      );
      out.push({ label: c.label, inWindow, nativeLeak });
      mark(`confirm-leak ${c.label}: inWindow=${inWindow} nativeLeak=${nativeLeak}`);
      // CANCEL in whichever window hosted it (keeps privacy on / nothing wiped).
      if (host) {
        await host.eval(
          `(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === ${JSON.stringify(c.cancel)}); if (b) b.click(); return !!b; })()`,
        );
      }
      await sleep(500);
    }
    return out;
  }

  let dash, over;
  let confirmChecks = [];
  try {
    const dashT = await waitForTarget((t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('view='));
    const overT = await waitForTarget((t) => t.type === 'page' && t.url.includes('view=overlay'));
    dash = new Cdp(dashT.webSocketDebuggerUrl);
    over = new Cdp(overT.webSocketDebuggerUrl);
    await dash.ready; await over.ready;
    await dash.send('Runtime.enable'); await over.send('Runtime.enable');
    for (let i = 0; i < 60; i++) { if (await dash.eval('!!window.api').catch(() => false)) break; await sleep(250); }
    mark('api ready');

    // setup: tour OFF, samples IN, reload
    await dash.eval('window.api.settings.set({ tourDone: true })');
    const samples = await dash.eval('window.api.data.loadSamples()');
    mark('tour disabled + samples loaded: ' + JSON.stringify(samples));
    await dash.send('Page.enable');
    await dash.send('Page.reload');
    await sleep(3000);
    for (let i = 0; i < 40; i++) { if (await dash.eval('!!window.api').catch(() => false)) break; await sleep(250); }
    mark('dashboard reloaded');

    // ============ PHASE A — pre-session storms (privacy ON, no interview) ============
    const navLabels = await dash.eval(`[...document.querySelectorAll('nav a, aside a')].map(a => a.textContent.trim()).filter(Boolean)`);
    console.log('nav:', navLabels);
    await step('nav storm x2 (every page, twice, fast)', async () => {
      for (let pass = 0; pass < 2; pass++) {
        for (const label of navLabels) {
          if (/what'?s new/i.test(label)) continue;
          await dash.clickText(label);
          await sleep(300);
        }
      }
    });
    await step('hover storm (tooltip shield)', async () => { await dash.hoverSweep(16); });
    await step('dropdown storm on interview page', async () => {
      await dash.eval(`location.hash = '#/interview'`); await sleep(900);
      for (let i = 0; i < 3; i++) {
        await dash.clickText('Select a profile…'); await sleep(400);
        await dash.eval('document.body.click()'); await sleep(250); // close it
      }
    });
    await step('dashboard minimize', async () => { await dash.eval('window.api.window.minimize()'); });
    await sleep(1200);
    await step('dashboard restore', async () => { await dash.eval('window.api.window.maximizeToggle()'); });
    await sleep(800);
    await step('dashboard restore (unmaximize)', async () => { await dash.eval('window.api.window.maximizeToggle()'); });
    await sleep(800);
    await step('overlay hide', async () => { await over.eval('window.api.overlay.hide()'); });
    await sleep(900);
    await step('overlay show', async () => { await over.eval('window.api.overlay.show()'); });
    await sleep(900);
    await step('privacy re-assert (set true) x3 while ON', async () => {
      for (let i = 0; i < 3; i++) { await dash.eval('window.api.privacy.set(true)'); await sleep(200); }
    });
    await step('PRE-SESSION move storm on Cue Card (2s)', async () => { await moveStorm('OVERLAY', 2000); });

    // ============ PHASE B — go live (loopback capture = the wipe trigger) ============
    await dash.eval(`if (!location.hash.includes('/interview')) location.hash = '#/interview'`);
    await sleep(1000);
    const picked = await dash.selectProfile('Alex Rivera');
    mark(`profile selected (jobs table shown): ${picked}`);
    await sleep(900);
    mark('clicking Start');
    const started = await dash.startInterview();
    mark(`Start clicked: ${started}`);
    let liveOn = false;
    for (let i = 0; i < 30 && !liveOn; i++) {
      await sleep(500);
      liveOn = await over.eval(`[...document.querySelectorAll('button')].some(b => /Stop|Pause/.test(b.textContent))`).catch(() => false);
    }
    mark(`session live (Cue Card controls present): ${liveOn}`);
    await over.eval('window.api.overlay.show()'); // keep the Cue Card visible for the storms
    await sleep(600);

    // ---- full Cue Card control storm during the live session ----
    await step('Cue Card: expand/compact x4', async () => {
      for (let i = 0; i < 4; i++) {
        await over.eval(`window.api.overlay.setMode(${i % 2 ? "'compact'" : "'expanded'"})`);
        await sleep(300);
      }
    });
    await step('Cue Card: opacity sweep', async () => {
      for (const v of [0.6, 0.8, 1, 0.95]) { await over.eval(`window.api.overlay.setOpacity(${v})`); await sleep(200); }
    });
    await step('Cue Card: clickthrough on/off x3', async () => {
      for (let i = 0; i < 3; i++) {
        await over.eval('window.api.overlay.setClickthrough(true)'); await sleep(200);
        await over.eval('window.api.overlay.setClickthrough(false)'); await sleep(200);
      }
    });
    await step('Cue Card: interview type sweep', async () => {
      for (const t of ['behavioral', 'technical', 'coding', 'system_design', 'general']) {
        await over.eval(`window.api.session.setAnswerPrefs({ interviewType: '${t}' })`); await sleep(250);
      }
    });
    await step('Cue Card: format sweep', async () => {
      for (const f of ['explanation', 'detailed', 'story_teller', 'key_points']) {
        await over.eval(`window.api.session.setAnswerPrefs({ format: '${f}' })`); await sleep(250);
      }
    });
    await step('Cue Card: pronunciation toggle x2', async () => {
      await over.eval('window.api.session.setAnswerPrefs({ pronunciation: false })'); await sleep(250);
      await over.eval('window.api.session.setAnswerPrefs({ pronunciation: true })'); await sleep(250);
    });
    await step('Cue Card: Ask box (type + send)', async () => {
      await over.eval(`window.api.session.askActive('What is your greatest strength?')`);
    });
    await sleep(1500);
    await step('LIVE move storm on Cue Card (2.5s hold-drag)', async () => { await moveStorm('OVERLAY', 2500); });
    await step('LIVE move storm on Dashboard (1.5s)', async () => { await moveStorm('DASHBOARD', 1500); });

    // ---- region selector: hides + re-shows BOTH windows, captures the screen ----
    await step('open region selector (hides+reshows both windows)', async () => {
      await over.eval('window.api.capture.openSelector()');
    });
    await sleep(1600);
    await step('close region selector (Escape)', async () => {
      const selT = await targets().then((l) => l.find((t) => t.url.includes('view=selection'))).catch(() => null);
      if (selT) {
        const sel = new Cdp(selT.webSocketDebuggerUrl); await sel.ready;
        await sel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      }
    });
    await sleep(1500);

    // ---- pause / resume / re-assert / idle (watch for external periodic wipes) ----
    await step('pause', async () => { await over.eval('window.api.session.togglePauseActive()'); });
    await sleep(1500);
    await step('resume', async () => { await over.eval('window.api.session.togglePauseActive()'); });
    await sleep(1500);
    await step('privacy re-assert during live x2', async () => {
      for (let i = 0; i < 2; i++) { await dash.eval('window.api.privacy.set(true)'); await sleep(300); }
    });
    await step('idle 8s (observe any external periodic wipe + heal)', async () => { await sleep(8000); });

    // ---- stop ----
    await step('stop session', async () => { await over.eval('window.api.session.stopActive()'); });
    await sleep(2000);

    // ============ PHASE C — post-session confirm ============
    await step('post-session nav storm', async () => {
      for (const label of navLabels) { if (/what'?s new/i.test(label)) continue; await dash.clickText(label); await sleep(300); }
    });
    // Confirm-leak check: the 3 native-dialog gates are now in-window modals.
    confirmChecks = await confirmLeakCheck();
    await step('post-session move storm on Cue Card (1.5s)', async () => { await moveStorm('OVERLAY', 1500); });
    await sleep(1000);
    mark('done - shutting down');
  } finally {
    fs.writeFileSync(MARKS_LOG, JSON.stringify(marks, null, 1));
    await sleep(400);
    kill();
    await sleep(800);
  }

  // ---------- analysis ----------
  const cutoff = marks.find((m) => m.label === 'done - shutting down')?.t ?? Infinity;
  const startT = marks.find((m) => m.label === 'dashboard reloaded')?.t ?? 0; // ignore pre-boot noise
  const events = fs.readFileSync(PROBE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => !e.stats && e.t <= cutoff);
  const windows = new Map(); // hwnd -> {label, timeline}
  for (const e of events) {
    if (!windows.has(e.hwnd)) windows.set(e.hwnd, { label: labelOf(e), timeline: [] });
    windows.get(e.hwnd).timeline.push(e);
  }
  const nearestMark = (t) => {
    let best = null;
    for (const m of marks) if (m.t <= t && (!best || m.t > best.t)) best = m;
    return best ? `+${t - best.t}ms after "${best.label}"` : 'before first mark';
  };

  console.log('\n================ HARD AFFINITY REPORT ================');
  let fail = false;
  const critical = ['DASHBOARD', 'OVERLAY'];
  const summary = [];
  for (const [hwnd, w] of windows) {
    const isCritical = critical.includes(w.label);
    let dips = 0, maxDip = 0, worst = null;
    let visMs = 0, protMs = 0;
    for (let i = 0; i < w.timeline.length; i++) {
      const e = w.timeline[i];
      if (e.t < startT) continue;
      const next = w.timeline[i + 1];
      const dur = (next ? next.t : cutoff) - e.t;
      if (e.vis) { visMs += dur; if (e.aff === 0x11) protMs += dur; }
      if (e.vis && e.aff !== 0x11) {
        dips++;
        const healed = next && next.aff === 0x11;
        if (dur > maxDip) { maxDip = dur; worst = { e, dur, healed }; }
        const level = isCritical ? (healed && dur <= FRAME_MS ? 'sub-frame' : 'LEAK') : 'info';
        if (level === 'LEAK') fail = true;
        console.log(`  [${w.label}/${level}] aff=0x${(e.aff ?? 0).toString(16)} VISIBLE ${dur}ms — ${nearestMark(e.t)}`);
      }
    }
    const last = w.timeline[w.timeline.length - 1];
    const pct = visMs ? ((protMs / visMs) * 100).toFixed(3) : 'n/a';
    if (isCritical) {
      summary.push({ label: w.label, hwnd, dips, maxDip, pct, final: last });
      console.log(`  -- ${w.label} (hwnd ${hwnd}): visible ${visMs}ms, protected ${pct}% of visible time, ${dips} dip(s), maxDip ${maxDip}ms, final aff=0x${(last.aff ?? 0).toString(16)} vis=${last.vis}`);
    }
  }

  console.log('\n---------------- CRITICAL WINDOWS ----------------');
  // Only instances that were actually visible during the run matter (a destroyed
  // pre-reload window lingers invisible at 0x0 — never capturable).
  const visibleSummary = summary.filter((s) => s.final.vis || s.dips > 0 || s.pct !== 'n/a');
  for (const s of visibleSummary) {
    const finalOk = !s.final.vis || s.final.aff === 0x11; // hidden = not capturable
    const finalTxt = s.final.vis ? (s.final.aff === 0x11 ? '0x11 ✓' : '0x' + (s.final.aff ?? 0).toString(16) + ' ✗') : 'hidden ✓';
    console.log(`  ${s.label} (hwnd ${s.hwnd}): ${s.dips === 0 ? 'held 0x11 the ENTIRE run' : `${s.dips} sub-frame dip(s), max ${s.maxDip}ms (healed)`} · protected ${s.pct}% · final ${finalTxt}`);
    if (!finalOk) fail = true;
  }
  // both critical windows must have been seen visible at least once
  for (const need of critical) {
    if (!visibleSummary.find((s) => s.label === need && s.pct !== 'n/a')) {
      console.log(`  ! ${need} never observed VISIBLE by the probe — inconclusive`); fail = true;
    }
  }

  console.log('\n---------------- CONFIRM-LEAK CHECK ----------------');
  if (confirmChecks.length === 0) {
    console.log('  (skipped — no confirm checks ran)');
  }
  for (const c of confirmChecks) {
    const ok = c.inWindow && !c.nativeLeak;
    if (!ok) fail = true;
    console.log(
      `  ${c.label}: ${c.inWindow ? 'in-window modal ✓' : 'NO in-window modal ✗ (native dialog?)'}` +
        `${c.nativeLeak ? ' · NATIVE aff-0 window seen ✗' : ''}`,
    );
  }

  const breaches = (fs.readFileSync(APP_LOG, 'utf8').match(/capture protection wiped/g) || []).length;
  console.log(`\n  observer heals logged by the app: ${breaches}`);
  console.log(`\nVERDICT: ${fail ? 'FAIL — a critical window was capturable for >1 frame (or ended unprotected)' : 'PASS — dashboard & Cue Card stayed 0x11 through every edge action (any dips healed sub-frame)'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('driver error:', e); process.exit(2); });
