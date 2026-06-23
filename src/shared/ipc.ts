// Single source of truth for IPC channel names. See docs/05-IPC-MAP.md.

/** Request/response channels (ipcRenderer.invoke <-> ipcMain.handle). */
export const IPC = {
  app: {
    getInfo: 'app:get-info',
  },
  dialog: {
    openFile: 'dialog:open-file',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    setApiKey: 'settings:set-api-key',
    clearApiKey: 'settings:clear-api-key',
    testApiKey: 'settings:test-api-key',
    listModels: 'settings:list-models',
    setShortcuts: 'settings:set-shortcuts',
    resetShortcuts: 'settings:reset-shortcuts',
    suspendShortcuts: 'settings:suspend-shortcuts',
    resumeShortcuts: 'settings:resume-shortcuts',
  },
  profiles: {
    list: 'profiles:list',
    get: 'profiles:get',
    create: 'profiles:create',
    update: 'profiles:update',
    delete: 'profiles:delete',
    duplicate: 'profiles:duplicate',
  },
  documents: {
    extractFile: 'documents:extract-file',
    fetchUrl: 'documents:fetch-url',
    saveResume: 'documents:save-resume',
    reindexProfile: 'documents:reindex-profile',
  },
  jobs: {
    list: 'jobs:list',
    get: 'jobs:get',
    save: 'jobs:save', // create or update + parse + index
    delete: 'jobs:delete',
  },
  notes: {
    list: 'notes:list',
    create: 'notes:create',
    delete: 'notes:delete',
  },
  rag: {
    search: 'rag:search',
  },
  session: {
    start: 'session:start',
    stop: 'session:stop',
    togglePause: 'session:toggle-pause',
    togglePauseActive: 'session:toggle-pause-active',
    audioChunk: 'session:audio-chunk',
    realtimeAudio: 'session:realtime-audio',
    list: 'session:list',
    get: 'session:get',
    delete: 'session:delete',
    generateReport: 'session:generate-report',
    getReport: 'session:get-report',
    ask: 'session:ask',
  },
  mock: {
    start: 'mock:start',
    answerText: 'mock:answer-text',
    answerAudio: 'mock:answer-audio',
    end: 'mock:end',
  },
  capture: {
    region: 'capture:region',
    openSelector: 'capture:open-selector',
    closeSelector: 'capture:close-selector',
    getFrame: 'capture:get-frame',
    solve: 'capture:solve',
    solveImage: 'capture:solve-image',
    quickSolve: 'capture:quick-solve',
  },
  overlay: {
    show: 'overlay:show',
    hide: 'overlay:hide',
    toggle: 'overlay:toggle',
    isVisible: 'overlay:is-visible',
    setMode: 'overlay:set-mode',
    setOpacity: 'overlay:set-opacity',
    setClickthrough: 'overlay:set-clickthrough',
  },
  privacy: {
    toggle: 'privacy:toggle',
    set: 'privacy:set',
    get: 'privacy:get',
  },
} as const;

/** Push event channels (webContents.send -> ipcRenderer.on). */
export const EVENTS = {
  sessionState: 'session:state',
  transcriptDelta: 'session:transcript-delta',
  questionDetected: 'session:question-detected',
  answerDelta: 'session:answer-delta',
  answerMeta: 'session:answer-meta',
  answerDone: 'session:answer-done',
  contextSent: 'session:context',
  sessionError: 'session:error',
  overlayApplySettings: 'overlay:apply-settings',
  shortcutFired: 'shortcut:fired',
  privacyChanged: 'privacy:changed',
  overlayVisibility: 'overlay:visibility',
  navigate: 'app:navigate',
} as const;

export type IpcEventChannel = (typeof EVENTS)[keyof typeof EVENTS];
