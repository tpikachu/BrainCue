// Run with the offline guard preloaded (node --require e2e/offline-guard.cjs):
// a FAKE Electron, so nothing can actually capture. It checks that the guard
// refuses native screenshots (desktopCapturer.getSources, called the way the
// app's screenshot service calls it) BEFORE the real API runs, and — as the
// control — that a media permission request is refused too.
// Prints one JSON object.
const Module = require('module');
const path = require('path');

const calls = { getSources: 0 };
class FakeSession {
  constructor() {
    this.handlers = {};
    this.webRequest = { onBeforeRequest() {} };
  }
  setPermissionRequestHandler(h) {
    this.handlers.request = h;
  }
  setPermissionCheckHandler(h) {
    this.handlers.check = h;
  }
  setDisplayMediaRequestHandler(h) {
    this.handlers.display = h;
  }
}
const defaultSession = new FakeSession();
const fakeElectron = {
  app: {
    commandLine: { appendSwitch() {} },
    whenReady: () => Promise.resolve(),
    on() {},
  },
  session: { defaultSession },
  net: {},
  screen: { getPrimaryDisplay: () => ({ id: 1 }), getAllDisplays: () => [{ id: 1 }] },
  desktopCapturer: {
    // The "real" capture transport: it must never be reached.
    getSources: async () => {
      calls.getSources += 1;
      return [{ id: 'screen:1', display_id: '1', thumbnail: {} }];
    },
  },
};

// Resolve 'electron' to the fake — the guard attaches on its first require.
const FAKE = path.join(__dirname, '__fake-electron__.js');
require.cache[FAKE] = { id: FAKE, filename: FAKE, loaded: true, exports: fakeElectron };
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'electron' ? FAKE : resolve.call(this, request, ...rest);
};

(async () => {
  const { desktopCapturer, session } = require('electron');
  await new Promise((r) => setTimeout(r, 0)); // the guard's whenReady patch

  // The app installs its handlers (which GRANT capture) — the guard must win.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  const media = await new Promise((r) => defaultSession.handlers.request(null, 'media', r, { mediaTypes: ['audio'] }));

  let screenshot;
  try {
    // Exactly how services/capture/screenshot.ts asks.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 2560, height: 1440 } });
    screenshot = 'GRANTED';
  } catch (e) {
    screenshot = `refused: ${e.message}`;
  }
  process.stdout.write(JSON.stringify({ media, screenshot, realGetSourcesCalls: calls.getSources }));
})();
