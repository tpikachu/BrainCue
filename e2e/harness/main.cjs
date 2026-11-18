// Minimal Electron main for renderer harnesses (startModal.race.spec.ts): one
// HIDDEN window (nothing appears on any screen), a CDP port for Playwright, no
// app code, no database, no audio, no network. The spec routes the page's URL
// to the harness bundle itself.
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('remote-debugging-port', process.env.HARNESS_CDP_PORT || '9339');
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.setPath('userData', process.env.HARNESS_USER_DATA || require('path').join(require('os').tmpdir(), 'braincue-harness'));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true },
  });
  void win.loadURL('about:blank');
  // Screenshots need a window that paints: a hidden one stops repainting on
  // some pages. When asked (HARNESS_SHOW_X), show it WITHOUT focus at that x —
  // the second monitor (x >= 1920); never the primary screen.
  const showX = Number(process.env.HARNESS_SHOW_X || 0);
  if (showX >= 1920) {
    win.setBounds({ x: showX + 40, y: 40, width: 1100, height: 900 });
    win.showInactive();
  }

  // Screenshots (opt-in, 127.0.0.1 only): Electron's own capture of the hidden
  // window. CDP captures wait for a compositor frame that a hidden window
  // does not always produce.
  const port = Number(process.env.HARNESS_CAPTURE_PORT || 0);
  if (port) {
    require('http')
      .createServer(async (req, res) => {
        try {
          const img = await win.webContents.capturePage();
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(img.toPNG());
        } catch (e) {
          res.writeHead(500);
          res.end(String(e));
        }
      })
      .listen(port, '127.0.0.1');
  }
});
app.on('window-all-closed', () => app.quit());
