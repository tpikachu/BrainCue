# Electron Main / Renderer / Overlay Architecture

## Windows

### Main (Dashboard) window
```ts
new BrowserWindow({
  width: 1280, height: 800, minWidth: 960, minHeight: 600,
  show: false,
  webPreferences: {
    preload: <preload.js>,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
})
// loads renderer entry: index.html
```
- Standard chrome, resizable. Hosts all management UI.
- Shown on `ready-to-show`.

### Overlay window
```ts
new BrowserWindow({
  width: 420, height: 280,
  frame: false,
  transparent: true,
  alwaysOnTop: true,        // level: 'screen-saver'
  resizable: true,
  skipTaskbar: true,
  focusable: false,         // toggled; non-focusable so it never steals focus
  hasShadow: false,
  webPreferences: { /* same secure prefs */ },
})
overlay.setAlwaysOnTop(true, 'screen-saver')
overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
// loads renderer entry: index.html?view=overlay
```
- **Always-on-top**: `setAlwaysOnTop(true, 'screen-saver')`.
- **Compact/Expanded**: renderer changes layout; main resizes window
  (`overlay.setBounds`) on `overlay:set-mode`.
- **Opacity**: `overlay.setOpacity(0..1)` on `overlay:set-opacity`.
- **Font size**: handled purely in renderer (CSS var).
- **Show/Hide**: global shortcut toggles `overlay.show()/hide()`.
- **Privacy Mode**: `overlay.setContentProtection(true)` excludes it from screen
  capture on supported OSes.
- **Click-through (optional)**: `overlay.setIgnoreMouseEvents(true,{forward:true})`
  for a passive mode.

### Selection window (coding mode)
Created on demand by `Ctrl+Shift+S` / the "Coding mode" button. Frameless,
transparent, `alwaysOnTop`, sized to the primary display's `bounds`. The screen
is captured *before* the window shows (so the selector isn't in the frame); the
transparent window lets the user see the live desktop while drag-selecting. The
renderer crops the frozen frame (`capture:get-frame`) at devicePixelRatio scale,
calls `capture:solve-image` (Vision reads the crop), then closes. Loads
`index.html?view=selection`.

## Window lifecycle

```
requestSingleInstanceLock()        // duplicate launch focuses the 1st window & quits
app.whenReady()
  ├─ initDb()            // open SQLite, run migrations
  ├─ registerIpc()       // all ipcMain.handle / ipcMain.on
  ├─ createMainWindow()
  ├─ createOverlayWindow()  // created up front, kept hidden, so it's subscribed early
  ├─ registerGlobalShortcuts()
  └─ getPrivacy()        // apply privacy mode

app.on('second-instance')   -> focus the existing main window
app.on('window-all-closed') -> quit (except macOS convention)
app.on('before-quit')       -> unregister shortcuts
```

**Single instance:** the app takes `requestSingleInstanceLock()` before creating
windows. A second launch can't (it would fail to register the global shortcuts
held by the first instance and hit "Access is denied" on the shared GPU/disk
cache), so it focuses the existing window and exits.

**Window reveal (never-invisible guarantee):** the main window is created with
`show:false` and revealed on the **first** of `ready-to-show`, `did-finish-load`,
or a 5s fallback timeout. On some hybrid-GPU laptops (e.g. NVIDIA Optimus on MSI)
`ready-to-show` can be delayed or never fire — the fallback guarantees the app is
never a visible-less process.

**GPU escape hatch:** if a machine renders the window surface incorrectly (blank
window), launch with `--disable-gpu` or set `AI_DISABLE_GPU=1` to fall back to
software rendering (`app.disableHardwareAcceleration()`). GPU-process crashes are
logged via `child-process-gone`.

## Global shortcuts (defaults, user-rebindable later)

Defined in `src/main/shortcuts.ts`. The "action" is an internal dispatch name
(not an IPC channel) handled directly in the main process.

| Shortcut | Action | Internal action |
|---|---|---|
| `CmdOrCtrl+Shift+Space` | Toggle overlay show/hide | `overlay:toggle` |
| `CmdOrCtrl+Shift+P` | Pause / resume AI | `session:toggle-pause` |
| `CmdOrCtrl+Shift+Enter` | Solve coding problem from clipboard | `capture:quick` |
| `CmdOrCtrl+Shift+S` | Region select → solve from image | `capture:region` |
| `CmdOrCtrl+Shift+H` | Toggle Privacy Mode | `privacy:toggle` |
| `CmdOrCtrl+Shift+\` | Toggle overlay click-through | `overlay:toggle-clickthrough` |

Registered with `globalShortcut.register`; all unregistered on `before-quit`.

## Renderer entry points

All three windows load the **same** `index.html` → `src/renderer/main.tsx`, which
mounts a different React root based on the `?view=` query (`loadRenderer.ts`):

- (none) / `?view=dashboard` → Dashboard root (`dashboard/App.tsx`, router)
- `?view=overlay`           → Overlay root (`overlay/Overlay.tsx`)
- `?view=selection`         → Region selector (`selection/RegionSelector.tsx`)

A single html entry is used because separate html files don't always serve from
the dev server. All roots share `src/renderer/lib`, `components`, and Tailwind.

## Event push (main → overlay/dashboard)

Main broadcasts to windows via `webContents.send`. Overlay subscribes:

| Event | Payload |
|---|---|
| `session:transcript-delta` | `{ text, isFinal }` |
| `session:question-detected` | `DetectedQuestion` |
| `session:answer-delta` | `{ questionId, token }` |
| `session:answer-done` | `{ questionId }` |
| `session:state` | `{ status, paused }` |
| `overlay:apply-settings` | `{ opacity, fontSize, mode }` |
