// E2E driver: launch the BUILT app (isolated userData, CDP on), disable the
// tour, load sample data, explore the dashboard with trusted clicks, select the
// sample profile, START a real interview (loopback capture = the known
// protection-wipe trigger), and interact with the Cue Card — while probe.js
// (separate process) records the REAL GetWindowDisplayAffinity of every app
// window the whole time. Ends with a correlated PASS/FAIL report.
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

const CDP_PORT = 9231;
const OUT = path.join(HERE, '.out');
const USER_DATA = path.join(OUT, 'userdata');
const APP_LOG = path.join(OUT, 'app.log');
const PROBE_LOG = path.join(OUT, 'probe.jsonl');
const MARKS_LOG = path.join(OUT, 'marks.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marks = [];
function mark(label) {
  const t = Date.now();
  marks.push({ t, label });
  console.log(`[mark ${new Date(t).toISOString().slice(11, 23)}] ${label}`);
}

// ---------- minimal CDP client ----------
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
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
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
  async clickAt(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await sleep(40);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }
  // Click the center of the first VISIBLE element whose trimmed text equals
  // (or, with contains=true, includes) `text` — buttons/links/options first.
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
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return res.json();
}

async function waitForTarget(pred, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const list = await targets();
      const t = list.find(pred);
      if (t) return t;
    } catch { /* CDP not up yet */ }
    await sleep(250);
  }
  throw new Error('target not found');
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.rmSync(APP_LOG, { force: true });
  fs.rmSync(PROBE_LOG, { force: true });

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
    for (const line of buf.toString().split('\n')) {
      if (line.includes('[privacy]')) console.log('  app>', line.trim());
    }
  };
  app.stdout.on('data', onAppLine);
  app.stderr.on('data', onAppLine);

  const probe = spawn(process.execPath, [path.join(HERE, 'probe.js'), String(app.pid)], { cwd: REPO });
  const probeLog = fs.createWriteStream(PROBE_LOG);
  probe.stdout.pipe(probeLog);
  probe.stderr.on('data', (d) => console.error('probe!', d.toString()));

  const kill = () => {
    try { probe.kill(); } catch {}
    try { app.kill(); } catch {}
  };
  process.on('exit', kill);

  try {
    // --- attach to dashboard + overlay ---
    const dashT = await waitForTarget((t) => t.type === 'page' && t.url.includes('index.html') && !t.url.includes('view='));
    const overT = await waitForTarget((t) => t.type === 'page' && t.url.includes('view=overlay'));
    const dash = new Cdp(dashT.webSocketDebuggerUrl);
    const over = new Cdp(overT.webSocketDebuggerUrl);
    await dash.ready; await over.ready;
    await dash.send('Runtime.enable'); await over.send('Runtime.enable');

    // wait for preload api
    for (let i = 0; i < 60; i++) {
      if (await dash.eval('!!window.api').catch(() => false)) break;
      await sleep(250);
    }
    mark('api ready');

    // --- setup: tour OFF (it blocks interaction), sample data in ---
    await dash.eval('window.api.settings.set({ tourDone: true })');
    const samples = await dash.eval('window.api.data.loadSamples()');
    mark('tour disabled + samples loaded: ' + JSON.stringify(samples));
    await dash.send('Page.enable');
    await dash.send('Page.reload');
    await sleep(3000);
    for (let i = 0; i < 40; i++) {
      if (await dash.eval('!!window.api').catch(() => false)) break;
      await sleep(250);
    }
    mark('dashboard reloaded');

    // --- explore the dashboard: click through the real nav ---
    const navLabels = await dash.eval(
      `[...document.querySelectorAll('nav a, aside a')].map(a => a.textContent.trim()).filter(Boolean)`,
    );
    console.log('nav:', navLabels);
    for (const label of navLabels) {
      if (/what'?s new/i.test(label)) continue; // changelog page is inert; skip
      const ok = await dash.clickText(label);
      mark(`nav click "${label}" ${ok ? '' : '(NOT FOUND)'}`);
      await sleep(900);
    }

    // --- interview page: select the sample profile via the in-window dropdown ---
    await dash.eval(`location.hash = '#/interview'`);
    await sleep(1200);
    mark('on #/interview');

    const btns = await dash.eval(
      `[...document.querySelectorAll('button')].filter(b => b.offsetParent).map(b => b.textContent.trim()).slice(0, 40)`,
    );
    console.log('buttons on interview page:', btns);

    // the profile Select renders as a Dropdown trigger button showing the
    // placeholder; open it and pick the sample profile by contains-match
    await dash.clickText('Select a profile…');
    await sleep(600);
    const opts = await dash.eval(
      `[...document.querySelectorAll('button, [role="option"], li')].filter(b => b.offsetParent).map(b => b.textContent.trim()).filter(Boolean).slice(0, 20)`,
    );
    console.log('after opening dropdown:', opts);
    const picked = await dash.clickText('Alex Rivera', { contains: true });
    mark(`profile picked: ${picked}`);
    await sleep(1200);

    // --- START the interview (this fires getDisplayMedia -> the wipe trigger) ---
    const btns2 = await dash.eval(
      `[...document.querySelectorAll('button')].filter(b => b.offsetParent).map(b => b.textContent.trim()).slice(0, 40)`,
    );
    console.log('buttons after profile pick:', btns2);
    mark('clicking Start');
    const started = await dash.clickText('Start');
    mark(`Start clicked: ${started}`);

    // wait for the session to actually go live (a Stop/Pause/End control appears)
    let live = false;
    for (let i = 0; i < 20 && !live; i++) {
      await sleep(500);
      live = await dash.eval(
        `[...document.querySelectorAll('button')].some(b => b.offsetParent && /^(stop|end|pause)/i.test(b.textContent.trim()))`,
      ).catch(() => false);
    }
    mark(`session live: ${live}`);
    const liveState = await dash.eval(
      `[...document.querySelectorAll('button')].filter(b => b.offsetParent).map(b => b.textContent.trim()).slice(0, 40)`,
    );
    console.log('buttons after Start:', liveState);

    // --- interact with the Cue Card during the live session ---
    for (let i = 0; i < 3; i++) {
      await over.clickAt(200 + i * 30, 120 + i * 20);
      mark(`overlay click #${i + 1}`);
      await sleep(1500);
    }
    await sleep(8000); // let the session run; observer + probe watch

    // --- stop the session if a stop control exists ---
    for (const label of ['Stop', 'End', 'Stop session', 'End session']) {
      if (await dash.clickText(label)) { mark(`clicked "${label}"`); break; }
    }
    await sleep(2500);
    mark('done - shutting down');
  } finally {
    fs.writeFileSync(MARKS_LOG, JSON.stringify(marks, null, 1));
    await sleep(300);
    kill();
    await sleep(700);
  }

  // ---------- analysis ----------
  // Ignore probe events after shutdown began: killing the app tears its windows
  // down with the observer already dead — a harness artifact, not app behavior.
  const cutoff = marks.find((m) => m.label === 'done - shutting down')?.t ?? Infinity;
  const events = fs.readFileSync(PROBE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.t <= cutoff);
  const windows = new Map(); // hwnd -> {label, timeline:[{t, aff, vis}]}
  const label = (e) => {
    if (e.title === 'BrainCueLoopbackAnchor') return 'anchor';
    if (!e.rect) return 'other';
    const w = e.rect[2] - e.rect[0], h = e.rect[3] - e.rect[1];
    if (w >= 900 && h >= 550) return 'DASHBOARD';
    if (e.title.includes('BrainCue') && w > 100) return 'OVERLAY';
    return `other(${e.title || 'untitled'} ${w}x${h})`;
  };
  for (const e of events) {
    if (e.stats) continue;
    if (!windows.has(e.hwnd)) windows.set(e.hwnd, { label: label(e), timeline: [] });
    windows.get(e.hwnd).timeline.push(e);
  }
  const nearestMark = (t) => {
    let best = null;
    for (const m of marks) if (m.t <= t && (!best || m.t > best.t)) best = m;
    return best ? `${t - best.t}ms after "${best.label}"` : 'before first mark';
  };

  console.log('\n================ AFFINITY REPORT ================');
  let fail = false;
  for (const [hwnd, w] of windows) {
    console.log(`\n-- ${w.label} (hwnd ${hwnd}) --`);
    for (let i = 0; i < w.timeline.length; i++) {
      const e = w.timeline[i];
      if (e.aff === 0x11) continue; // protected — the expected steady state
      const next = w.timeline[i + 1];
      const dur = next ? next.t - e.t : Date.now() - e.t;
      const visTxt = e.vis ? 'VISIBLE' : 'hidden';
      const capturable = e.vis && e.aff !== 0x11;
      if (capturable && (w.label === 'DASHBOARD' || w.label === 'OVERLAY')) {
        const healed = next && next.aff === 0x11;
        const level = healed && dur <= 150 ? 'transient' : 'LEAK';
        if (level === 'LEAK') fail = true;
        console.log(
          `  [${level}] aff=0x${(e.aff ?? 0).toString(16)} ${visTxt} for ${dur}ms — ${nearestMark(e.t)}`,
        );
      } else {
        console.log(
          `  (info) aff=${e.aff === null ? 'null' : '0x' + e.aff.toString(16)} ${visTxt} ${dur}ms — ${nearestMark(e.t)}`,
        );
      }
    }
    const lastState = w.timeline[w.timeline.length - 1];
    console.log(`  final: aff=${lastState.aff === null ? 'null' : '0x' + lastState.aff.toString(16)} vis=${lastState.vis}`);
  }
  console.log(`\nVERDICT: ${fail ? 'FAIL — sustained capturable state detected' : 'PASS — no sustained leaks; any dips healed within 150ms'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('driver error:', e);
  process.exit(2);
});
