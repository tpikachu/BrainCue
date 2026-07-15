// Ground-truth Privacy Mode verification. Launches the BUILT app (isolated
// userData, privacy defaults ON) and takes an OS-level screen capture of the
// dashboard's own screen rect via a second Electron process's desktopCapturer
// (DXGI/WGC — the capture family real screen-share apps use, exactly what
// WDA_EXCLUDEFROMCAPTURE must defeat).
//
//   npm run build && node scripts/verify-privacy-capture.mjs
//
// PASS = privacy-on.png shows what's BEHIND the window (the app is excluded)
//        and privacy-off.png shows the app UI.
// Re-run after Windows feature updates and Electron upgrades: Chromium's
// DirectComposition path has been observed to bypass DWM's capture-exclusion
// filter on some Windows 11 builds (the v1.5.1 leak) — this catches it in
// minutes. Output lands in scripts/.privacy-verify/ (gitignored by *.png? no —
// DELETE the captures after checking; they contain your actual screen).
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require2 = createRequire(path.join(repo, 'noop.js'));
const electronBin = require2('electron');
const OUT = path.join(repo, 'scripts', '.privacy-verify');
const USER_DATA = path.join(OUT, 'userdata');
const CDP = 9224;
const beat = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const CAP_JS = path.join(OUT, 'cap.js');
fs.writeFileSync(
  CAP_JS,
  `const { app, desktopCapturer, screen } = require('electron');
app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  let img = sources[0].thumbnail;
  const [, , out, x, y, w, h] = process.argv;
  if (x !== undefined) img = img.crop({ x: Number(x), y: Number(y), width: Number(w), height: Number(h) });
  require('fs').writeFileSync(out, img.toPNG());
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
`,
);

const env = { ...process.env, BRAINCUE_E2E: '1', E2E_CDP_PORT: String(CDP), E2E_USER_DATA: USER_DATA };
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPENAI_API_KEY;

function shoot(rect, file) {
  const capEnv = { ...process.env };
  delete capEnv.ELECTRON_RUN_AS_NODE;
  execFileSync(electronBin, [CAP_JS, file, String(rect.x), String(rect.y), String(rect.w), String(rect.h)], {
    env: capEnv,
    stdio: 'ignore',
  });
}

const { chromium } = require2('playwright');
const proc = spawn(electronBin, [repo], { cwd: repo, env, stdio: 'ignore' });
try {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('CDP endpoint never came up');
    await beat(200);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  const ctx = browser.contexts()[0];
  let dash = null;
  for (let i = 0; i < 100 && !dash; i++) {
    dash = ctx.pages().find((p) => p.url() && !p.url().startsWith('about:') && !p.url().includes('view=')) ?? null;
    if (!dash) await beat(150);
  }
  if (!dash) throw new Error('dashboard window not found');
  await dash.waitForLoadState('domcontentloaded');
  await beat(3000);

  console.log('privacy state:', JSON.stringify(await dash.evaluate(() => window.api.privacy.get())));
  const rect = await dash.evaluate(() => ({
    x: window.screenX,
    y: window.screenY,
    w: window.outerWidth,
    h: window.outerHeight,
  }));

  shoot(rect, path.join(OUT, 'privacy-on.png'));
  console.log('privacy-on.png saved — the app must NOT be readable in it');

  await dash.evaluate(() => window.api.settings.set({ privacyMode: false }));
  await beat(1500);
  shoot(rect, path.join(OUT, 'privacy-off.png'));
  console.log('privacy-off.png saved — the app SHOULD be readable in it');
  console.log(`\nInspect both in ${OUT} and DELETE them afterwards (they contain your screen).`);
  await browser.close();
} finally {
  if (proc.pid && proc.exitCode === null) {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}
