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
});
app.on('window-all-closed', () => app.quit());
