import { contextBridge, ipcRenderer } from 'electron';
import { EVENTS, IPC } from '@shared/ipc';
import type { Result } from '@shared/result';

/** invoke + unwrap the Result envelope so renderer code uses normal try/catch. */
async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, payload)) as Result<T>;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** Subscribe to a main->renderer push event. Returns an unsubscribe fn. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

type MockAnswerResult = {
  done: boolean;
  index: number;
  total: number;
  question?: string;
  questionId?: string;
  audioBase64?: string;
};

// Typed facade. The OpenAI key is never exposed — only booleans/data come back.
const api = {
  app: {
    getInfo: () => invoke<{ version: string; platform: string }>(IPC.app.getInfo),
  },
  dialog: {
    openFile: () => invoke<{ filePath: string | null }>(IPC.dialog.openFile, {}),
  },
  settings: {
    get: () => invoke(IPC.settings.get),
    set: (patch: unknown) => invoke(IPC.settings.set, patch),
    setApiKey: (key: string) => invoke(IPC.settings.setApiKey, { key }),
    clearApiKey: () => invoke(IPC.settings.clearApiKey),
    testApiKey: () => invoke(IPC.settings.testApiKey),
    listModels: () => invoke<string[]>(IPC.settings.listModels),
    setShortcuts: (shortcuts: Record<string, string>) =>
      invoke<{ shortcuts: Record<string, string> }>(IPC.settings.setShortcuts, { shortcuts }),
    resetShortcuts: () =>
      invoke<{ shortcuts: Record<string, string> }>(IPC.settings.resetShortcuts),
    suspendShortcuts: () => invoke<{ suspended: true }>(IPC.settings.suspendShortcuts),
    resumeShortcuts: () => invoke<{ resumed: true }>(IPC.settings.resumeShortcuts),
    resetApp: () =>
      invoke<{ reset: boolean; settings: unknown }>(IPC.settings.resetApp),
  },
  data: {
    stats: () =>
      invoke<{ profiles: number; sessions: number; liveSessions: number }>(IPC.data.stats),
    wipeAll: () => invoke<{ wiped: boolean }>(IPC.data.wipeAll),
  },
  window: {
    minimize: () => invoke<{ ok: true }>(IPC.window.minimize),
    maximizeToggle: () => invoke<{ maximized: boolean }>(IPC.window.maximizeToggle),
    close: () => invoke<{ ok: true }>(IPC.window.close),
    isMaximized: () => invoke<{ maximized: boolean }>(IPC.window.isMaximized),
  },
  profiles: {
    list: () => invoke(IPC.profiles.list),
    get: (id: string) => invoke(IPC.profiles.get, { id }),
    create: (input: unknown) => invoke(IPC.profiles.create, input),
    update: (id: string, patch: unknown) => invoke(IPC.profiles.update, { id, patch }),
    delete: (id: string) => invoke(IPC.profiles.delete, { id }),
    duplicate: (id: string) => invoke(IPC.profiles.duplicate, { id }),
  },
  documents: {
    extractFile: (filePath: string) =>
      invoke<{ text: string; mime: string; filename: string }>(IPC.documents.extractFile, {
        filePath,
      }),
    fetchUrl: (url: string) =>
      invoke<{ text: string; title: string | null }>(IPC.documents.fetchUrl, { url }),
    saveResume: (profileId: string, resumeText: string) =>
      invoke<{ keyMissing: boolean; parsed: boolean; embedded: number }>(
        IPC.documents.saveResume,
        { profileId, resumeText },
      ),
    reindexProfile: (profileId: string) => invoke(IPC.documents.reindexProfile, { profileId }),
  },
  jobs: {
    list: (profileId: string) => invoke(IPC.jobs.list, { profileId }),
    get: (id: string) => invoke(IPC.jobs.get, { id }),
    save: (input: {
      id?: string;
      profileId: string;
      title: string;
      company: string | null;
      jdUrl: string | null;
      jdText: string | null;
      companyUrl: string | null;
    }) =>
      invoke<{
        job: unknown;
        keyMissing: boolean;
        embedded: number;
        companyResearched: boolean;
        companyError: string | null;
      }>(IPC.jobs.save, input),
    delete: (id: string) => invoke(IPC.jobs.delete, { id }),
  },
  notes: {
    list: (profileId: string) => invoke(IPC.notes.list, { profileId }),
    create: (profileId: string, content: string) =>
      invoke(IPC.notes.create, { profileId, content }),
    delete: (id: string) => invoke(IPC.notes.delete, { id }),
  },
  session: {
    start: (
      profileId: string,
      interviewType: string,
      answerStyle: string,
      jobId: string | null = null,
    ) => invoke(IPC.session.start, { profileId, interviewType, answerStyle, jobId }),
    stop: (sessionId: string) => invoke(IPC.session.stop, { sessionId }),
    togglePause: (sessionId: string) => invoke(IPC.session.togglePause, { sessionId }),
    togglePauseActive: () =>
      invoke<{ paused: boolean; active: boolean }>(IPC.session.togglePauseActive),
    audioChunk: (sessionId: string, audio: ArrayBuffer, mime: string) =>
      invoke(IPC.session.audioChunk, { sessionId, audio, mime }),
    // One-way streaming audio (no response) for low-latency Realtime STT.
    sendRealtimeAudio: (sessionId: string, pcm: ArrayBuffer) =>
      ipcRenderer.send(IPC.session.realtimeAudio, { sessionId, pcm }),
    ask: (sessionId: string, questionText: string) =>
      invoke(IPC.session.ask, { sessionId, questionText }),
    list: () => invoke(IPC.session.list),
    get: (id: string) => invoke(IPC.session.get, { id }),
    delete: (id: string) => invoke(IPC.session.delete, { id }),
    generateReport: (sessionId: string) => invoke(IPC.session.generateReport, { sessionId }),
    getReport: (sessionId: string) => invoke(IPC.session.getReport, { sessionId }),
  },
  mock: {
    start: (
      profileId: string,
      voice: string,
      jobId: string | null = null,
      interviewType = 'general',
    ) =>
      invoke<{
        session: { id: string };
        question: string;
        questionId: string;
        audioBase64: string;
        index: number;
        total: number;
      }>(IPC.mock.start, { profileId, voice, jobId, interviewType }),
    answerText: (sessionId: string, text: string) =>
      invoke<MockAnswerResult>(IPC.mock.answerText, { sessionId, text }),
    answerAudio: (sessionId: string, audio: ArrayBuffer, mime: string) =>
      invoke<MockAnswerResult & { transcript: string }>(IPC.mock.answerAudio, {
        sessionId,
        audio,
        mime,
      }),
    end: (sessionId: string) => invoke(IPC.mock.end, { sessionId }),
  },
  capture: {
    region: () => invoke<{ image: string }>(IPC.capture.region),
    openSelector: () => invoke<{ opened: true }>(IPC.capture.openSelector),
    closeSelector: () => invoke<{ closed: true }>(IPC.capture.closeSelector),
    getFrame: () => invoke<{ image: string | null }>(IPC.capture.getFrame),
    solve: (text: string) => invoke<{ started: true }>(IPC.capture.solve, { text }),
    solveImage: (image: string) => invoke<{ started: true }>(IPC.capture.solveImage, { image }),
    quickSolve: () => invoke<{ started: true }>(IPC.capture.quickSolve),
  },
  overlay: {
    show: () => invoke(IPC.overlay.show),
    hide: () => invoke(IPC.overlay.hide),
    toggle: () => invoke(IPC.overlay.toggle),
    isVisible: () => invoke<{ visible: boolean }>(IPC.overlay.isVisible),
    setMode: (mode: 'compact' | 'expanded') => invoke(IPC.overlay.setMode, { mode }),
    setOpacity: (opacity: number) => invoke(IPC.overlay.setOpacity, { opacity }),
    setClickthrough: (enabled: boolean) => invoke(IPC.overlay.setClickthrough, { enabled }),
  },
  privacy: {
    get: () => invoke<{ enabled: boolean }>(IPC.privacy.get),
    toggle: () => invoke<{ enabled: boolean }>(IPC.privacy.toggle),
    set: (enabled: boolean) => invoke<{ enabled: boolean }>(IPC.privacy.set, { enabled }),
  },
  events: {
    onSessionState: (cb: (p: unknown) => void) => on(EVENTS.sessionState, cb),
    onTranscriptDelta: (cb: (p: unknown) => void) => on(EVENTS.transcriptDelta, cb),
    onQuestionDetected: (cb: (p: unknown) => void) => on(EVENTS.questionDetected, cb),
    onAnswerDelta: (cb: (p: unknown) => void) => on(EVENTS.answerDelta, cb),
    onAnswerMeta: (cb: (p: unknown) => void) => on(EVENTS.answerMeta, cb),
    onAnswerDone: (cb: (p: unknown) => void) => on(EVENTS.answerDone, cb),
    onContextSent: (cb: (p: unknown) => void) => on(EVENTS.contextSent, cb),
    onSessionError: (cb: (p: unknown) => void) => on(EVENTS.sessionError, cb),
    onOverlayApplySettings: (cb: (p: unknown) => void) => on(EVENTS.overlayApplySettings, cb),
    onShortcutFired: (cb: (p: unknown) => void) => on(EVENTS.shortcutFired, cb),
    onPrivacyChanged: (cb: (p: unknown) => void) => on(EVENTS.privacyChanged, cb),
    onOverlayVisibility: (cb: (p: unknown) => void) => on(EVENTS.overlayVisibility, cb),
    onNavigate: (cb: (p: unknown) => void) => on(EVENTS.navigate, cb),
    onWindowMaximized: (cb: (p: { maximized: boolean }) => void) =>
      on(EVENTS.windowMaximized, cb),
    onDataChanged: (cb: (p: unknown) => void) => on(EVENTS.dataChanged, cb),
    onSelectionReset: (cb: (p: { image: string }) => void) => on(EVENTS.selectionReset, cb),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
