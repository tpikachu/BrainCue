// PERF-01 live benchmark: the budget meter and run guard. This is test
// infrastructure and never part of the app.
//
// Loaded into the Electron MAIN process before any app code, via
// NODE_OPTIONS=--require. e2e/live-perf01.spec.ts does this through the
// `mainPreloads` fixture option. It does nothing unless PERF01_LEDGER names
// the run's ledger folder.
//
//  1. Budget, enforced before sending. Every provider request (fetch, http/
//     https, which the OpenAI SDK and the `ws` upgrade use) is held until its
//     body is complete. The meter then reserves a conservative upper bound
//     (meter-core.cjs reservationFor) and sends it only if the run's caps
//     still allow it. Otherwise the request is refused, as an offline
//     machine's would be, and the ledger is marked capped for the rest of
//     the run. Speech-to-text audio is metered by the second as it is sent.
//  2. One provider only. A main-process connection to any host other than
//     the provider hosts (PERF01_PROVIDER_HOSTS, default api.openai.com) or
//     loopback is refused at its socket.
//  3. No capture. Microphone, call-audio and screen capture are refused,
//     as in the offline guard. The benchmark streams its own synthesized
//     audio through the app's IPC instead.
//  4. Placement and visibility evidence. Every window is moved to a
//     secondary display (screen 1 is the user's). A snapshot of the
//     displays and windows (bounds, visible, minimized, display) is written
//     to windows.json for the driver's preflight.
'use strict';
const DIR = process.env.PERF01_LEDGER;
if (!DIR) return;
// Once per process. Electron can apply NODE_OPTIONS' --require twice under
// different path spellings (two module-cache keys). A second copy would
// wrap the hooks again and charge every request twice.
if (globalThis.__perf01Meter) return;
globalThis.__perf01Meter = true;
// Main only: an Electron utility process (the local STT worker) and a
// worker thread in main (the privacy worker) inherit the --require too, and
// neither is a provider client.
if (process.type && process.type !== 'browser') return;
if (!require('worker_threads').isMainThread) return;

const fs = require('fs');
const net = require('net');
const path = require('path');
const Module = require('module');
const core = require('./meter-core.cjs');

const caps = core.capsFromEnv(process.env);
const hosts = core.providerHosts(process.env);

let state = core.load(DIR);
state.processes.push({ pid: process.pid, startedAt: Date.now(), caps });
core.save(DIR, state);

function hostOnly(raw) {
  let h = String(raw == null ? '' : raw).trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = h.slice(1, end < 0 ? undefined : end);
  } else if ((h.match(/:/g) || []).length === 1) {
    h = h.split(':')[0];
  }
  return h.replace(/\.$/, '');
}
const isLoopback = (raw) => ['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(hostOnly(raw));
const isProvider = (raw) => hosts.includes(hostOnly(raw));

function refusal(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Reserve, decide, record. Returns the verdict. */
function meter(method, pathname, body, via) {
  state = core.load(DIR); // another process may have spent since this one started
  const r = core.reservationFor({ method, path: pathname, body });
  const verdict = core.decide(state, caps, r);
  core.commit(state, r, verdict);
  core.save(DIR, state);
  core.logRequest(DIR, {
    via,
    cls: r.cls,
    model: r.model,
    bytes: r.bytes,
    reservedPromptTokens: r.promptTokens,
    reservedCompletionTokens: r.completionTokens,
    unbounded: r.unbounded,
    sent: verdict.ok,
    ...(verdict.ok ? {} : { refused: verdict.reason }),
  });
  return verdict;
}

// ---- 2. Sockets: the provider and loopback only --------------------------------
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function meteredConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host;
  let pipe = false;
  if (first && typeof first === 'object') {
    pipe = typeof first.path === 'string' && first.path.length > 0;
    host = first.host == null ? 'localhost' : first.host;
  } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
    pipe = true;
  } else {
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  }
  if (!pipe && !isLoopback(host) && !isProvider(host)) {
    core.logRequest(DIR, { via: 'socket', host: hostOnly(host), sent: false, refused: 'host-not-allowed' });
    process.nextTick(() => this.destroy(refusal(`connect ECONNREFUSED (PERF-01: ${hostOnly(host)} is not the provider)`, 'ECONNREFUSED')));
    return this;
  }
  return realConnect.apply(this, args);
};

// ---- 1. http/https: hold the body, reserve, then send or refuse --------------
function target(args) {
  const a = args[0];
  const b = args[1] && typeof args[1] === 'object' && !(args[1] instanceof Function) ? args[1] : null;
  if (typeof a === 'string' || a instanceof URL) {
    const u = new URL(String(a));
    return { host: u.hostname, path: u.pathname + u.search, method: (b && b.method) || 'GET' };
  }
  const o = a || {};
  return { host: o.hostname != null ? o.hostname : o.host || 'localhost', path: o.path || '/', method: o.method || 'GET' };
}

for (const name of ['http', 'https']) {
  const mod = require(name);
  const realRequest = mod.request;
  mod.request = function meteredRequest(...args) {
    const t = target(args);
    if (!isProvider(t.host)) {
      if (isLoopback(t.host)) return realRequest.apply(this, args);
      core.logRequest(DIR, { via: name, host: hostOnly(t.host), sent: false, refused: 'host-not-allowed' });
      throw refusal(`PERF-01: ${hostOnly(t.host)} is not the provider`, 'ECONNREFUSED');
    }
    const req = realRequest.apply(this, args);
    const chunks = [];
    const realWrite = req.write;
    const realEnd = req.end;
    req.write = function heldWrite(chunk, enc, cb) {
      if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
      const done = typeof enc === 'function' ? enc : cb;
      if (typeof done === 'function') process.nextTick(done);
      return true;
    };
    req.end = function meteredEnd(chunk, enc, cb) {
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = undefined;
      } else if (typeof enc === 'function') {
        cb = enc;
        enc = undefined;
      }
      if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
      const body = Buffer.concat(chunks);
      const verdict = meter(t.method, t.path, body, name);
      if (!verdict.ok) {
        process.nextTick(() => req.destroy(refusal(`PERF-01 budget: request refused (${verdict.reason})`, 'PERF01_CAP')));
        return req;
      }
      if (body.length) realWrite.call(req, body);
      return realEnd.call(req, cb);
    };
    return req;
  };
  mod.get = function meteredGet(...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

// ---- 1. fetch (undici) -----------------------------------------------------
const realFetch = globalThis.fetch;
if (realFetch) {
  globalThis.fetch = function meteredFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    } catch {
      return realFetch.call(this, input, init);
    }
    if (!isProvider(url.hostname)) {
      if (isLoopback(url.hostname)) return realFetch.call(this, input, init);
      core.logRequest(DIR, { via: 'fetch', host: hostOnly(url.hostname), sent: false, refused: 'host-not-allowed' });
      return Promise.reject(new TypeError(`fetch failed (PERF-01: ${url.hostname} is not the provider)`));
    }
    const body = init && init.body;
    const text = typeof body === 'string' ? body : Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body) : body == null ? '' : null;
    // A streamed body cannot be sized before it is sent: reserve it as unbounded.
    const verdict = meter((init && init.method) || 'GET', url.pathname, text === null ? 'x'.repeat(core.UNBOUNDED_COMPLETION * 3) : text, 'fetch');
    if (!verdict.ok) return Promise.reject(new TypeError(`fetch failed (PERF-01 budget: ${verdict.reason})`));
    return realFetch.call(this, input, init);
  };
}

// ---- Module hooks: ws (speech-to-text audio) and electron (windows, capture) --
let wsPatched = false;
let electronAttached = false;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  const out = origLoad.call(this, request, ...rest);
  // `ws` by its shape, however it was required (bare name or resolved path).
  if (!wsPatched && out && out.WebSocketServer && out.prototype && typeof out.prototype.send === 'function') {
    wsPatched = true;
    patchWs(out);
  }
  if (request === 'electron' && !electronAttached && out && out.app) {
    electronAttached = true;
    attach(out);
  }
  return out;
};

function patchWs(WebSocket) {
  const realSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function meteredSend(data, opts, cb) {
    if (typeof data === 'string' && data.length < 4_000_000 && data.charCodeAt(0) === 123) {
      let m = null;
      try {
        m = JSON.parse(data);
      } catch {
        m = null;
      }
      if (m && m.type === 'input_audio_buffer.append' && typeof m.audio === 'string') {
        const seconds = core.audioSeconds(m.audio);
        state = core.load(DIR);
        const verdict = core.decideAudio(state, caps, seconds);
        core.commitAudio(state, seconds, verdict);
        core.save(DIR, state);
        if (!verdict.ok) {
          core.logRequest(DIR, { via: 'ws', cls: 'stt-audio', seconds, sent: false, refused: verdict.reason });
          const done = typeof opts === 'function' ? opts : cb;
          if (typeof done === 'function') process.nextTick(() => done(refusal(`PERF-01 budget: audio refused (${verdict.reason})`, 'PERF01_CAP')));
          return undefined;
        }
      } else if (m && m.type === 'session.update') {
        const stt = core.sttConfig(m);
        if (stt) {
          state = core.load(DIR);
          state.stt = { ...stt, pid: process.pid, at: Date.now() };
          core.save(DIR, state);
          core.logRequest(DIR, { via: 'ws', cls: 'stt-config', model: stt.model, sent: true });
        }
      }
    }
    return realSend.call(this, data, opts, cb);
  };
}

const CAPTURE = new Set(['media', 'display-capture', 'audioCapture', 'videoCapture']);

function attach(electron) {
  const { app, session, desktopCapturer, BrowserWindow } = electron;

  // ---- 3. No capture ----
  if (desktopCapturer && typeof desktopCapturer.getSources === 'function') {
    desktopCapturer.getSources = function refusedGetSources() {
      core.logRequest(DIR, { via: 'desktopCapturer', cls: 'capture', sent: false, refused: 'capture' });
      return Promise.reject(new Error('screen capture refused by the PERF-01 benchmark'));
    };
  }
  app.whenReady().then(() => {
    const proto = Object.getPrototypeOf(session.defaultSession);
    const setReq = proto.setPermissionRequestHandler;
    proto.setPermissionRequestHandler = function (handler) {
      return setReq.call(this, (wc, permission, callback, details) => {
        if (CAPTURE.has(permission)) {
          core.logRequest(DIR, { via: 'permission-request', cls: 'capture', permission, sent: false, refused: 'capture' });
          return callback(false);
        }
        return handler ? handler(wc, permission, callback, details) : callback(false);
      });
    };
    const setCheck = proto.setPermissionCheckHandler;
    proto.setPermissionCheckHandler = function (handler) {
      return setCheck.call(this, (wc, permission, origin, details) => {
        if (CAPTURE.has(permission)) return false;
        return handler ? handler(wc, permission, origin, details) : false;
      });
    };
    const setDisplay = proto.setDisplayMediaRequestHandler;
    proto.setDisplayMediaRequestHandler = function (_handler, opts) {
      return setDisplay.call(
        this,
        (_request, callback) => {
          core.logRequest(DIR, { via: 'display-media', cls: 'capture', sent: false, refused: 'capture' });
          try {
            callback({});
          } catch {
            /* refused either way */
          }
        },
        opts,
      );
    };
    session.defaultSession.setPermissionRequestHandler(null);
    session.defaultSession.setPermissionCheckHandler(null);
    session.defaultSession.setDisplayMediaRequestHandler(null);
    snapshotLoop();
  });

  // ---- 4. Placement: every window on a secondary display ----
  const moves = [];
  app.on('browser-window-created', (_e, w) => {
    const place = () => {
      try {
        const { screen } = electron;
        const primary = screen.getPrimaryDisplay();
        const other = screen.getAllDisplays().find((d) => d.id !== primary.id);
        if (!other) return;
        const b = w.getBounds();
        const wa = other.workArea;
        const inside = b.x >= wa.x && b.x + b.width <= wa.x + wa.width && b.y >= wa.y && b.y + b.height <= wa.y + wa.height;
        if (!inside) {
          const width = Math.min(b.width, wa.width - 80);
          const height = Math.min(b.height, wa.height - 80);
          w.setBounds({ x: wa.x + 40, y: wa.y + 40, width, height });
          moves.push({ at: Date.now(), windowId: w.id });
        }
      } catch {
        /* placement failures show up in the snapshot, not as a crash */
      }
    };
    place();
    w.once('show', place);
    w.on('move', place);
    w.on('resize', place);
  });

  function snapshot() {
    try {
      const { screen } = electron;
      const primary = screen.getPrimaryDisplay();
      const displays = screen.getAllDisplays().map((d) => ({ id: d.id, primary: d.id === primary.id, bounds: d.bounds }));
      const windows = BrowserWindow.getAllWindows().map((w) => {
        const b = w.getBounds();
        const d = screen.getDisplayMatching(b);
        let url = '';
        try {
          url = w.webContents.getURL();
        } catch {
          url = '';
        }
        const view = /[?&]view=([a-z]+)/.exec(url);
        // The app's page (file:// or the dev server) without ?view= is the
        // dashboard; anything else (about:blank, a helper window) is 'other'.
        const appPage = /^(file:|https?:\/\/(localhost|127\.0\.0\.1))/.test(url) && /index\.html|\/$|#/.test(url);
        let title = '';
        try {
          title = w.getTitle();
        } catch {
          title = '';
        }
        return {
          id: w.id,
          view: view ? view[1] : appPage ? 'dashboard' : 'other',
          page: url ? url.split(/[?#]/)[0].replace(/^.*[\\/]/, '') || url.slice(0, 40) : '(none)',
          title,
          visible: w.isVisible(),
          minimized: w.isMinimized(),
          bounds: b,
          displayId: d.id,
          onPrimary: d.id === primary.id,
        };
      });
      const file = path.join(DIR, 'windows.json');
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), pid: process.pid, displays, windows, moves: moves.slice(-20) }, null, 2));
      fs.renameSync(tmp, file);
    } catch {
      /* evidence only */
    }
  }
  function snapshotLoop() {
    snapshot();
    const t = setInterval(snapshot, 1000);
    if (t.unref) t.unref();
  }
}
