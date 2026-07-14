// Single source of truth for IPC channel names. See docs/05-IPC-MAP.md.

import type { AnswerFormat, InterviewType } from './types';

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
    resetApp: 'settings:reset-app',
  },
  data: {
    stats: 'data:stats',
    wipeAll: 'data:wipe-all',
    loadSamples: 'data:load-samples',
  },
  window: {
    minimize: 'window:minimize',
    maximizeToggle: 'window:maximize-toggle',
    close: 'window:close',
    isMaximized: 'window:is-maximized',
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
    page: 'jobs:page',
    get: 'jobs:get',
    save: 'jobs:save', // create or update + parse + index
    setNotes: 'jobs:set-notes', // update just the client notes (no re-parse)
    brief: 'jobs:brief', // generate a grounded pre-interview prep brief
    delete: 'jobs:delete',
  },
  notes: {
    list: 'notes:list',
    create: 'notes:create',
    delete: 'notes:delete',
  },
  applications: {
    page: 'applications:page',
    get: 'applications:get',
    tailor: 'applications:tailor', // the Tailor Resume op: LLM → profile/job/app rows + index
    answerQuestions: 'applications:answer-questions', // answer more questions later (appended)
    reindex: 'applications:reindex', // re-embed the JD + tailored chunks (recovery/refresh)
    exportPdf: 'applications:export-pdf', // tailored resume → ATS-friendly PDF (save dialog)
    delete: 'applications:delete',
  },
  stories: {
    list: 'stories:list',
    generate: 'stories:generate', // extract STAR stories from the résumé (replaces all)
    update: 'stories:update', // edit one story's text
    delete: 'stories:delete',
  },
  session: {
    start: 'session:start',
    resume: 'session:resume',
    stop: 'session:stop',
    togglePause: 'session:toggle-pause',
    togglePauseActive: 'session:toggle-pause-active',
    stopActive: 'session:stop-active',
    audioChunk: 'session:audio-chunk',
    realtimeAudio: 'session:realtime-audio',
    list: 'session:list',
    get: 'session:get',
    delete: 'session:delete',
    generateReport: 'session:generate-report',
    getReport: 'session:get-report',
    practiceStats: 'session:practice-stats', // Practice Loop aggregates (Reports)
    ask: 'session:ask',
    askActive: 'session:ask-active',
    setInterviewType: 'session:set-interview-type',
    setAnswerPrefs: 'session:set-answer-prefs',
    setAnswering: 'session:set-answering', // coding: toggle auto-answering the interviewer
    regenerate: 'session:regenerate',
    clearAnswer: 'session:clear-answer',
  },
  mock: {
    start: 'mock:start',
    next: 'mock:next',
    end: 'mock:end',
  },
  sparring: {
    start: 'sparring:start', // two-way voice mock: ask the first question
    answer: 'sparring:answer', // transcribe the spoken answer + return coaching feedback
    next: 'sparring:next', // ask the next (follow-up) question
    end: 'sparring:end',
  },
  capture: {
    region: 'capture:region',
    openSelector: 'capture:open-selector',
    closeSelector: 'capture:close-selector',
    getFrame: 'capture:get-frame',
    solve: 'capture:solve',
    solveImage: 'capture:solve-image',
    quickSolve: 'capture:quick-solve',
    addRegion: 'capture:add-region', // add a captured region to the multi-image buffer
    solveBuffer: 'capture:solve-buffer', // solve all buffered screenshots in one call
    clearBuffer: 'capture:clear-buffer',
    resolveLast: 'capture:resolve-last', // re-solve the most recent coding problem
  },
  overlay: {
    show: 'overlay:show',
    hide: 'overlay:hide',
    toggle: 'overlay:toggle',
    isVisible: 'overlay:is-visible',
    setMode: 'overlay:set-mode',
    setOpacity: 'overlay:set-opacity',
    setClickthrough: 'overlay:set-clickthrough',
    copyText: 'overlay:copy-text', // write text to the OS clipboard (per-card "Copy")
  },
  privacy: {
    toggle: 'privacy:toggle',
    set: 'privacy:set',
    get: 'privacy:get',
  },
  update: {
    check: 'update:check',
    install: 'update:install',
    getStatus: 'update:get-status',
  },
  // DEV-only (handlers registered only when !app.isPackaged): a read-only DB explorer.
  dev: {
    tables: 'dev:tables',
    rows: 'dev:rows',
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
  answerReset: 'session:answer-reset', // regenerate: clear the Cue Card answer, keep the transcript
  answerFollowup: 'session:answer-followup', // post-stream predicted interviewer follow-up
  contextSent: 'session:context',
  sessionError: 'session:error',
  overlayApplySettings: 'overlay:apply-settings',
  shortcutFired: 'shortcut:fired',
  privacyChanged: 'privacy:changed',
  overlayVisibility: 'overlay:visibility',
  navigate: 'app:navigate',
  windowMaximized: 'window:maximized',
  dataChanged: 'data:changed',
  selectionReset: 'selection:reset',
  updateStatus: 'update:status',
  overlayClickthrough: 'overlay:clickthrough', // global shortcut -> overlay toggles click-through
  clientInfo: 'session:client-info', // the live session's client (job) notes, for the Cue Card
  answerPrefs: 'session:answer-prefs', // current format/length/pronunciation, for the Cue Card toggles
  audioLevel: 'session:audio-level', // throttled mic level (0-1) for the Cue Card meter
  transcriberStatus: 'session:transcriber-status', // STT socket lifecycle: reconnecting | connected
  savePrompt: 'session:save-prompt', // a session just stopped → ask the dashboard to save/discard it
  captureBuffer: 'capture:buffer', // current multi-image problem captures, for the Cue Card strip
} as const;

/** Pushed to the dashboard when a session stops, to prompt save-or-discard. */
export interface SavePrompt {
  sessionId: string;
  interviewType: InterviewType;
  jobTitle: string | null;
  questionCount: number;
}

/** Client (job) + profile context pushed to the Cue Card while a session is live,
 *  so the user can confirm what the AI is grounding answers in. */
export interface ClientInfo {
  company: string | null;
  title: string;
  notes: string | null;
  profileName: string | null; // whose profile is answering
  hasResume: boolean; // profile has a parsed resume
  hasJd: boolean; // the interview (job) has a parsed JD
  hasCompany: boolean; // company research was parsed
}

/** Live answer preferences pushed to the Cue Card so its toggles stay in sync. */
export interface AnswerPrefs {
  interviewType: InterviewType;
  format: AnswerFormat;
  pronunciation: boolean;
}

export type IpcEventChannel = (typeof EVENTS)[keyof typeof EVENTS];

/** Auto-update lifecycle state pushed to the renderer (EVENTS.updateStatus). */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error';
  /** Current app version (always set). */
  currentVersion: string;
  /** The newer version, when one is available/downloading/downloaded. */
  version?: string;
  /** Download progress 0–100 (during 'downloading'). */
  percent?: number;
  /** Human-readable error (during 'error'). */
  message?: string;
}
