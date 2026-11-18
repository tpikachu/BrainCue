// The OFFLINE tier's guard — test infrastructure, never part of the app.
//
// Loaded into the Electron MAIN process before any app code, via
// NODE_OPTIONS=--require (e2e/fixtures.ts does this for every offline test).
// It makes three things impossible rather than merely unlikely, and records
// every attempt so a test can prove it (E2E_GUARD_LOG, one JSON line each):
//
//  1. No outbound network. Main's fetch, http/https and Electron's `net`, and
//     every renderer request (webRequest, all sessions) to anything but
//     loopback are refused. Provider calls fail as an offline machine's would.
//  2. No real microphone, call audio or screen. The app's own permission and
//     display-media handlers GRANT capture (a live session needs them; the
//     display handler hands Chromium the call-audio loopback with no picker),
//     so they are replaced, whenever the app installs them, by ones that
//     refuse capture. Pages also get getUserMedia / getDisplayMedia that
//     reject before reaching main, and Chromium's FAKE capture device is
//     switched on as a last line: even a leak could only hear a test tone.
//  3. No window on the primary display when another exists (the developer's
//     screen) — windows are moved to a secondary display.
//
// The fixture reads the log after each test and fails the test if anything
// was ever GRANTED (it never should be, by construction).
const fs = require('fs');
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
const isLocal = (host) => {
  const h = String(host || '').replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
  return !h || h === '127.0.0.1' || h === 'localhost' || h === '::1';
};

// ---- 1. Network: Node-level (main) -------------------------------------------
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
      record({ kind: 'net', via: 'fetch', host: url.hostname, refused: true });
      return Promise.reject(new TypeError(`fetch failed (offline E2E: ${url.hostname} blocked)`));
    }
    return realFetch.call(this, input, init);
  };
}
for (const name of ['http', 'https']) {
  const mod = require(name);
  for (const fn of ['request', 'get']) {
    const orig = mod[fn];
    mod[fn] = function guardedRequest(...args) {
      const a = args[0];
      const host =
        typeof a === 'string' ? new URL(a).hostname : a instanceof URL ? a.hostname : a && (a.hostname || a.host);
      if (!isLocal(host)) {
        record({ kind: 'net', via: name, host: String(host), refused: true });
        const err = new Error(`connect ECONNREFUSED (offline E2E: ${host} blocked)`);
        err.code = 'ECONNREFUSED';
        throw err;
      }
      return orig.apply(this, args);
    };
  }
}

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
  const { app, net, session } = electron;
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

  // Electron's own network stack in main.
  if (net) {
    for (const fn of ['request', 'fetch']) {
      const orig = net[fn];
      if (typeof orig !== 'function') continue;
      net[fn] = function guardedNet(...args) {
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
