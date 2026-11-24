// The OFFLINE tier's guard — test infrastructure, never part of the app.
//
// Loaded into the Electron MAIN process before any app code, via
// NODE_OPTIONS=--require (e2e/fixtures.ts does this for every offline test).
// It makes three things impossible rather than merely unlikely, and records
// every attempt so a test can prove it (E2E_GUARD_LOG, one JSON line each):
//
//  1. No outbound network. Every TCP connection main opens — whatever opened
//     it: fetch (undici), http/https, ws, an SDK's own client, and EVERY hop
//     of a redirect — is checked where it is made (net.Socket#connect), and
//     refused unless it is to loopback (127.0.0.1, ::1, or an IPv4-mapped
//     ::ffff:127.0.0.1). Electron's `net` and every page request (webRequest,
//     all sessions) get the same check. Provider calls fail as an offline
//     machine's would. Earlier layers (fetch, http/https) refuse obvious cases
//     early with a clearer error; the socket check is the one that cannot be
//     walked around.
//  2. No real microphone, call audio or screen. The app's own permission and
//     display-media handlers GRANT capture (a live session needs them; the
//     display handler hands Chromium the call-audio loopback with no picker),
//     so they are replaced, whenever the app installs them, by ones that
//     refuse capture. Native screenshots (desktopCapturer.getSources — the
//     region solver and the loopback fallback) are refused before the real
//     API is called. Pages also get getUserMedia / getDisplayMedia that
//     reject before reaching main, and Chromium's FAKE capture device is
//     switched on as a last line: even a leak could only hear a test tone.
//  3. No window on the primary display when another exists (the developer's
//     screen) — windows are moved to a secondary display.
//
// The fixture reads the log after each test and fails the test if anything
// was ever GRANTED (it never should be, by construction).
const fs = require('fs');
const net = require('net');
const Module = require('module');

const LOG = process.env.E2E_GUARD_LOG || '';
function record(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  } catch {
    /* the log is evidence, never a reason to crash the app */
  }
}

const CAPTURE = new Set(['media', 'display-capture', 'audioCapture', 'videoCapture']);

/** A host as written in a URL, an options object or "host:port" — brackets
 *  and port removed WITHOUT cutting an IPv6 address apart. */
function hostOnly(raw) {
  let h = String(raw == null ? '' : raw).trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = h.slice(1, end < 0 ? undefined : end);
  } else if ((h.match(/:/g) || []).length === 1) {
    h = h.split(':')[0]; // "host:port" — an IPv6 address has two or more colons
  }
  return h.replace(/\.$/, '');
}

/** Loopback only: localhost, 127.0.0.1, ::1, and ::ffff:127.0.0.1 in any
 *  spelling. An empty or unparseable host is NOT local. */
function isLocal(raw) {
  const h = hostOnly(raw);
  if (h === 'localhost') return true;
  const v = net.isIP(h);
  if (v === 4) return h === '127.0.0.1';
  if (v !== 6) return false;
  let c = h;
  try {
    c = new URL(`http://[${h}]/`).hostname.slice(1, -1); // canonical form
  } catch {
    return false;
  }
  if (c === '::1') return true;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(c);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return [a >> 8, a & 255, b >> 8, b & 255].join('.') === '127.0.0.1';
  }
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(c);
  return !!dotted && dotted[1] === '127.0.0.1';
}

const refusal = (host) => {
  const err = new Error(`connect ECONNREFUSED (offline E2E: ${host} blocked)`);
  err.code = 'ECONNREFUSED';
  return err;
};

// ---- 1a. Every socket main opens (the layer nothing above can bypass) -------
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  // net.connect / tls.connect pass Node's normalized [options, cb] array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host;
  let pipe = false;
  if (first && typeof first === 'object') {
    pipe = typeof first.path === 'string' && first.path.length > 0;
    host = first.host == null ? 'localhost' : first.host; // Node's default
  } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
    pipe = true; // connect(path)
  } else {
    host = typeof args[1] === 'string' ? args[1] : 'localhost'; // connect(port[, host])
  }
  if (!pipe && !isLocal(host)) {
    record({ kind: 'net', via: 'socket', host: hostOnly(host), refused: true });
    process.nextTick(() => this.destroy(refusal(hostOnly(host))));
    return this;
  }
  return realConnect.apply(this, args);
};

// ---- 1b. Early, clearer refusals: fetch and http/https ----------------------
const realFetch = globalThis.fetch;
if (realFetch) {
  globalThis.fetch = function guardedFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    } catch {
      return realFetch.call(this, input, init);
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !isLocal(url.hostname)) {
      record({ kind: 'net', via: 'fetch', host: hostOnly(url.hostname), refused: true });
      return Promise.reject(new TypeError(`fetch failed (offline E2E: ${url.hostname} blocked)`));
    }
    // A redirect to anywhere else is refused at its socket (1a).
    return realFetch.call(this, input, init);
  };
}
for (const name of ['http', 'https']) {
  const mod = require(name);
  for (const fn of ['request', 'get']) {
    const orig = mod[fn];
    mod[fn] = function guardedRequest(...args) {
      const a = args[0];
      let host;
      if (typeof a === 'string') host = new URL(a).hostname;
      else if (a instanceof URL) host = a.hostname;
      else if (a && a.socketPath) host = 'localhost';
      else host = a && (a.hostname != null ? a.hostname : a.host != null ? a.host : 'localhost');
      if (!isLocal(host)) {
        record({ kind: 'net', via: name, host: hostOnly(host), refused: true });
        throw refusal(hostOnly(host));
      }
      return orig.apply(this, args);
    };
  }
}

module.exports = { isLocal, hostOnly };

// ---- Electron hooks: attach when the app first requires 'electron' -----------
let attached = false;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  const out = origLoad.call(this, request, ...rest);
  if (request === 'electron' && !attached && out && out.app) {
    attached = true;
    attach(out);
  }
  return out;
};

const REFUSE_IN_PAGE = `(() => {
  const md = navigator.mediaDevices;
  if (!md || md.__offlineGuard) return true;
  const refuse = (what) => () => {
    console.warn('[offline-guard] refused ' + what);
    return Promise.reject(new DOMException(what + ' refused by the offline E2E guard', 'NotAllowedError'));
  };
  md.getUserMedia = refuse('getUserMedia');
  md.getDisplayMedia = refuse('getDisplayMedia');
  md.__offlineGuard = true;
  return true;
})()`;

function attach(electron) {
  const { app, net: electronNet, session, desktopCapturer } = electron;
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

  // Native screenshots: refused BEFORE the real API runs, so no frame of any
  // screen or window is ever produced. (The app reads it as
  // `require('electron').desktopCapturer.getSources` at call time.)
  if (desktopCapturer && typeof desktopCapturer.getSources === 'function') {
    desktopCapturer.getSources = function refusedGetSources(options) {
      record({ kind: 'capture', via: 'desktopCapturer', types: options && options.types, granted: false });
      return Promise.reject(new Error('screen capture refused by the offline E2E guard'));
    };
  }

  // Electron's own network stack in main.
  if (electronNet) {
    for (const fn of ['request', 'fetch']) {
      const orig = electronNet[fn];
      if (typeof orig !== 'function') continue;
      electronNet[fn] = function guardedNet(...args) {
        const a = args[0];
        let host = '';
        try {
          host = typeof a === 'string' ? new URL(a).hostname : a && (a.url ? new URL(a.url).hostname : a.hostname || a.host);
        } catch {
          /* fall through */
        }
        if (!isLocal(host)) {
          record({ kind: 'net', via: `electron.net.${fn}`, host: String(host), refused: true });
          if (fn === 'fetch') return Promise.reject(new TypeError(`fetch failed (offline E2E: ${host} blocked)`));
          throw new Error(`offline E2E: ${host} blocked`);
        }
        return orig.apply(this, args);
      };
    }
  }

  // Capture handlers: whatever the app installs is wrapped so capture is
  // always refused. Patched on the prototype before the app's whenReady code
  // runs (this listener was registered first).
  app.whenReady().then(() => {
    const proto = Object.getPrototypeOf(session.defaultSession);
    const setReq = proto.setPermissionRequestHandler;
    proto.setPermissionRequestHandler = function (handler) {
      return setReq.call(this, (wc, permission, callback, details) => {
        if (CAPTURE.has(permission)) {
          record({ kind: 'capture', via: 'permission-request', permission, mediaTypes: details && details.mediaTypes, granted: false });
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
          record({ kind: 'capture', via: 'display-media', granted: false });
          // An empty grant refuses: getDisplayMedia rejects, as a cancelled picker would.
          try {
            callback({});
          } catch {
            /* some versions throw on an empty grant — the request is refused either way */
          }
        },
        opts,
      );
    };

    const guardSession = (s) => {
      s.setPermissionRequestHandler(null);
      s.setPermissionCheckHandler(null);
      s.setDisplayMediaRequestHandler(null);
      s.webRequest.onBeforeRequest((details, cb) => {
        let u;
        try {
          u = new URL(details.url);
        } catch {
          return cb({});
        }
        const remote = /^(https?|wss?):$/.test(u.protocol) && !isLocal(u.hostname);
        if (remote) record({ kind: 'net', via: 'renderer', host: u.hostname, refused: true });
        cb(remote ? { cancel: true } : {});
      });
    };
    guardSession(session.defaultSession);
    app.on('session-created', guardSession);
  });

  app.on('web-contents-created', (_e, wc) => {
    wc.on('dom-ready', () => wc.executeJavaScript(REFUSE_IN_PAGE).catch(() => {}));
    wc.on('console-message', (...args) => {
      // Electron 33+: (event) with event.message; older: (event, level, message).
      const msg = typeof args[2] === 'string' ? args[2] : args[0] && args[0].message;
      if (typeof msg === 'string' && msg.startsWith('[offline-guard] refused ')) {
        record({ kind: 'capture', via: 'page', api: msg.slice('[offline-guard] refused '.length), granted: false });
      }
    });
  });

  // Keep test windows off the developer's screen when a second display exists.
  if (process.env.E2E_KEEP_PRIMARY !== '1') {
    app.on('browser-window-created', (_e, w) => {
      const place = () => {
        try {
          const { screen } = electron;
          const primary = screen.getPrimaryDisplay();
          const other = screen.getAllDisplays().find((d) => d.id !== primary.id);
          if (!other) return;
          const b = w.getBounds();
          const wa = other.workArea;
          const inside = b.x >= wa.x && b.x < wa.x + wa.width && b.y >= wa.y && b.y < wa.y + wa.height;
          if (!inside) w.setBounds({ x: wa.x + 40, y: wa.y + 40, width: b.width, height: b.height });
        } catch {
          /* placement is a courtesy, never a failure */
        }
      };
      place();
      w.once('show', place);
      w.on('move', place);
    });
  }
}
