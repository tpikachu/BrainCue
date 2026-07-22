import { contextBridge, ipcRenderer } from 'electron';
import { EVENTS, IPC } from '@shared/ipc';
import type { AnswerPrefs, ClientInfo, ConfirmRequest, SavePrompt, UpdateStatus } from '@shared/ipc';
import type {
  Application,
  ApplicationListItem,
  Contribution,
  ContributionDeltaEvent,
  ContributionDoneEvent,
  ContributionOpenEvent,
  ContributionPatchEvent,
  ContributionResetEvent,
  InterviewBrief,
  MeetingReport,
  MemoryItem,
  Presence,
  SparringFeedback,
  Story,
  VoiceAudioEvent,
  VoicePrefs,
  VoiceStateEvent,
} from '@shared/types';
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
      invoke<{ profiles: number; interviews: number; sessions: number; liveSessions: number }>(
        IPC.data.stats,
      ),
    wipeAll: () => invoke<{ wiped: boolean }>(IPC.data.wipeAll),
    loadSamples: () => invoke<{ profileId: string; jobs: number }>(IPC.data.loadSamples),
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
    page: (profileId: string, query: string, limit: number, offset: number) =>
      invoke<{ items: unknown[]; total: number }>(IPC.jobs.page, {
        profileId,
        query,
        limit,
        offset,
      }),
    get: (id: string) => invoke(IPC.jobs.get, { id }),
    save: (input: {
      id?: string;
      profileId: string;
      title: string;
      company: string | null;
      jdUrl: string | null;
      jdText: string | null;
      companyUrl: string | null;
      notes: string | null;
    }) =>
      invoke<{
        job: unknown;
        keyMissing: boolean;
        embedded: number;
        companyResearched: boolean;
        companyError: string | null;
      }>(IPC.jobs.save, input),
    setNotes: (id: string, notes: string | null) => invoke(IPC.jobs.setNotes, { id, notes }),
    brief: (id: string) => invoke<InterviewBrief>(IPC.jobs.brief, { id }),
    delete: (id: string) => invoke(IPC.jobs.delete, { id }),
  },
  applications: {
    page: (query: string, limit: number, offset: number) =>
      invoke<{ items: ApplicationListItem[]; total: number }>(IPC.applications.page, {
        query,
        limit,
        offset,
      }),
    get: (id: string) => invoke<Application>(IPC.applications.get, { id }),
    tailor: (input: {
      profileId: string | null;
      baseResumeText: string | null;
      jdText: string;
      questions: string[];
    }) =>
      invoke<{ application: Application; embedded: number; indexError: string | null }>(
        IPC.applications.tailor,
        input,
      ),
    answerQuestions: (id: string, questions: string[]) =>
      invoke<{ application: Application }>(IPC.applications.answerQuestions, { id, questions }),
    reindex: (id: string) => invoke<{ embedded: number }>(IPC.applications.reindex, { id }),
    exportPdf: (id: string) =>
      invoke<{ saved: boolean; filePath?: string }>(IPC.applications.exportPdf, { id }),
    delete: (id: string) => invoke<{ deleted: true }>(IPC.applications.delete, { id }),
  },
  notes: {
    list: (profileId: string) => invoke(IPC.notes.list, { profileId }),
    create: (profileId: string, content: string) =>
      invoke(IPC.notes.create, { profileId, content }),
    delete: (id: string) => invoke(IPC.notes.delete, { id }),
  },
  stories: {
    list: (profileId: string) => invoke<Story[]>(IPC.stories.list, { profileId }),
    generate: (profileId: string) => invoke<Story[]>(IPC.stories.generate, { profileId }),
    update: (
      id: string,
      patch: {
        title?: string;
        situation?: string;
        task?: string;
        action?: string;
        result?: string;
      },
    ) => invoke<Story>(IPC.stories.update, { id, patch }),
    delete: (id: string) => invoke<{ deleted: true }>(IPC.stories.delete, { id }),
  },
  session: {
    start: (
      profileId: string,
      interviewType: string,
      jobId: string | null = null,
      answerFormat = 'key_points',
      mode = 'interview',
      presence?: Presence,
    ) => invoke(IPC.session.start, { profileId, interviewType, jobId, answerFormat, mode, presence }),
    resume: (sessionId: string, answerFormat = 'key_points') =>
      invoke(IPC.session.resume, { sessionId, answerFormat }),
    setAnswerPrefs: (prefs: { interviewType?: string; format?: string; pronunciation?: boolean }) =>
      invoke<{ interviewType: string; format: string; pronunciation: boolean }>(
        IPC.session.setAnswerPrefs,
        prefs,
      ),
    askActive: (questionText: string) =>
      invoke<{ ok: boolean }>(IPC.session.askActive, { questionText }),
    setInterviewType: (sessionId: string, interviewType: string) =>
      invoke<{ ok: true }>(IPC.session.setInterviewType, { sessionId, interviewType }),
    setAnswering: (enabled: boolean) =>
      invoke<{ enabled: boolean; answered: boolean }>(IPC.session.setAnswering, { enabled }),
    regenerate: (questionId?: string) =>
      invoke<{ regenerated: boolean }>(IPC.session.regenerate, { questionId }),
    clearAnswer: () => invoke<{ cleared: boolean }>(IPC.session.clearAnswer),
    stop: (sessionId: string) => invoke(IPC.session.stop, { sessionId }),
    togglePause: (sessionId: string) => invoke(IPC.session.togglePause, { sessionId }),
    togglePauseActive: () =>
      invoke<{ paused: boolean; active: boolean }>(IPC.session.togglePauseActive),
    stopActive: () => invoke<{ stopped: boolean }>(IPC.session.stopActive),
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
    practiceStats: () => invoke(IPC.session.practiceStats),
    meetingReport: (sessionId: string) =>
      invoke<{ contributionId: string; report: MeetingReport }>(IPC.session.meetingReport, {
        sessionId,
      }),
  },
  contributions: {
    update: (
      id: string,
      patch: {
        title?: string | null;
        body?: string;
        meta?: Record<string, unknown> | null;
        status?: string;
      },
    ) => invoke<Contribution>(IPC.contributions.update, { id, ...patch }),
  },
  memory: {
    list: (profileId: string, opts: { status?: string; query?: string } = {}) =>
      invoke<MemoryItem[]>(IPC.memory.list, { profileId, ...opts }),
    review: (
      id: string,
      action: 'approve' | 'reject',
      edits: { content?: string; category?: string; packId?: string | null } = {},
    ) => invoke<MemoryItem>(IPC.memory.review, { id, action, ...edits }),
    update: (
      id: string,
      patch: {
        content?: string;
        category?: string;
        importance?: number;
        packId?: string | null;
        expiresAt?: number | null;
      },
    ) => invoke<MemoryItem>(IPC.memory.update, { id, ...patch }),
    archive: (id: string) => invoke<MemoryItem>(IPC.memory.archive, { id }),
    delete: (id: string) => invoke<{ deleted: true }>(IPC.memory.delete, { id }),
    setPackEnabled: (packId: string, enabled: boolean) =>
      invoke<{ packId: string; enabled: boolean }>(IPC.memory.setPackEnabled, { packId, enabled }),
  },
  // Voice/summon layer: push-to-talk controls + prefs. Raw PCM goes one-way
  // (send, no reply); synthesized speech arrives via events.onVoiceAudio.
  voice: {
    summon: () => invoke<{ state: string }>(IPC.voice.summon),
    commit: () => invoke<{ state: string }>(IPC.voice.commit),
    cancel: () => invoke<{ state: string }>(IPC.voice.cancel),
    interrupt: () => invoke<{ state: string }>(IPC.voice.interrupt),
    sendAudio: (pcm: ArrayBuffer) => ipcRenderer.send(IPC.voice.audio, { pcm }),
    playbackDone: (generation: number) =>
      invoke<{ state: string }>(IPC.voice.playbackDone, { generation }),
    getPrefs: () => invoke<VoicePrefs>(IPC.voice.getPrefs),
    setPrefs: (patch: Partial<VoicePrefs>) => invoke<VoicePrefs>(IPC.voice.setPrefs, patch),
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
        audioBase64: string;
        index: number;
        total: number;
      }>(IPC.mock.start, { profileId, voice, jobId, interviewType }),
    next: (sessionId: string) =>
      invoke<{
        done: boolean;
        question?: string;
        audioBase64?: string;
        index: number;
        total: number;
      }>(IPC.mock.next, { sessionId }),
    end: (sessionId: string) => invoke<{ ended: true }>(IPC.mock.end, { sessionId }),
  },
  sparring: {
    start: (profileId: string, voice: string, jobId: string | null, interviewType: string) =>
      invoke<{ sessionId: string; question: string; audioBase64: string; index: number; total: number }>(
        IPC.sparring.start,
        { profileId, voice, jobId, interviewType },
      ),
    answer: (sessionId: string, audioBase64: string, mime: string) =>
      invoke<{ transcript: string; feedback: SparringFeedback }>(IPC.sparring.answer, {
        sessionId,
        audioBase64,
        mime,
      }),
    next: (sessionId: string) =>
      invoke<{ done: boolean; question?: string; audioBase64?: string; index: number; total: number }>(
        IPC.sparring.next,
        { sessionId },
      ),
    end: (sessionId: string) => invoke<{ ended: true }>(IPC.sparring.end, { sessionId }),
  },
  capture: {
    region: () => invoke<{ image: string }>(IPC.capture.region),
    openSelector: () => invoke<{ opened: true }>(IPC.capture.openSelector),
    closeSelector: () => invoke<{ closed: true }>(IPC.capture.closeSelector),
    getFrame: () => invoke<{ image: string | null }>(IPC.capture.getFrame),
    solve: (text: string) => invoke<{ started: true }>(IPC.capture.solve, { text }),
    solveImage: (image: string) => invoke<{ started: true }>(IPC.capture.solveImage, { image }),
    quickSolve: () => invoke<{ started: true }>(IPC.capture.quickSolve),
    addRegion: (image: string) => invoke<{ added: true }>(IPC.capture.addRegion, { image }),
    solveBuffer: () => invoke<{ started: true }>(IPC.capture.solveBuffer),
    clearBuffer: () => invoke<{ cleared: true }>(IPC.capture.clearBuffer),
    resolveLast: () => invoke<{ started: true }>(IPC.capture.resolveLast),
  },
  overlay: {
    show: () => invoke(IPC.overlay.show),
    hide: () => invoke(IPC.overlay.hide),
    toggle: () => invoke(IPC.overlay.toggle),
    isVisible: () => invoke<{ visible: boolean }>(IPC.overlay.isVisible),
    setMode: (mode: 'compact' | 'expanded') => invoke(IPC.overlay.setMode, { mode }),
    setOpacity: (opacity: number) => invoke(IPC.overlay.setOpacity, { opacity }),
    setClickthrough: (enabled: boolean) => invoke(IPC.overlay.setClickthrough, { enabled }),
    copyText: (text: string) => invoke<{ copied: true }>(IPC.overlay.copyText, { text }),
  },
  privacy: {
    get: () => invoke<{ enabled: boolean; supported: boolean }>(IPC.privacy.get),
    toggle: () => invoke<{ enabled: boolean }>(IPC.privacy.toggle),
    set: (enabled: boolean) => invoke<{ enabled: boolean }>(IPC.privacy.set, { enabled }),
  },
  ui: {
    // Reply to a main-initiated in-window confirm (see events.onConfirmRequest).
    confirmResponse: (id: string, ok: boolean) =>
      invoke<{ ok: true }>(IPC.ui.confirmResponse, { id, ok }),
  },
  update: {
    getStatus: () => invoke<UpdateStatus>(IPC.update.getStatus),
    check: () => invoke<{ ok: true }>(IPC.update.check),
    install: () => invoke<{ ok: true }>(IPC.update.install),
  },
  // DEV-only DB explorer (handlers exist only in unpackaged builds).
  dev: {
    tables: () => invoke<{ name: string; rows: number }[]>(IPC.dev.tables),
    rows: (table: string, limit = 50, offset = 0) =>
      invoke<{ columns: string[]; rows: Record<string, unknown>[]; total: number }>(IPC.dev.rows, {
        table,
        limit,
        offset,
      }),
  },
  events: {
    onSessionState: (cb: (p: unknown) => void) => on(EVENTS.sessionState, cb),
    onTranscriptDelta: (cb: (p: unknown) => void) => on(EVENTS.transcriptDelta, cb),
    onQuestionDetected: (cb: (p: unknown) => void) => on(EVENTS.questionDetected, cb),
    onAnswerDelta: (cb: (p: unknown) => void) => on(EVENTS.answerDelta, cb),
    onAnswerMeta: (cb: (p: unknown) => void) => on(EVENTS.answerMeta, cb),
    onAnswerDone: (cb: (p: unknown) => void) => on(EVENTS.answerDone, cb),
    onAnswerReset: (cb: (p: unknown) => void) => on(EVENTS.answerReset, cb),
    onAnswerFollowup: (cb: (p: unknown) => void) => on(EVENTS.answerFollowup, cb),
    onContextSent: (cb: (p: unknown) => void) => on(EVENTS.contextSent, cb),
    // v2 generic contribution feed (the overlay's card surface). The legacy
    // answer* events above are dual-emitted for one more release.
    onContributionOpen: (cb: (p: ContributionOpenEvent) => void) =>
      on(EVENTS.contributionOpen, cb),
    onContributionDelta: (cb: (p: ContributionDeltaEvent) => void) =>
      on(EVENTS.contributionDelta, cb),
    onContributionPatch: (cb: (p: ContributionPatchEvent) => void) =>
      on(EVENTS.contributionPatch, cb),
    onContributionDone: (cb: (p: ContributionDoneEvent) => void) =>
      on(EVENTS.contributionDone, cb),
    onContributionReset: (cb: (p: ContributionResetEvent) => void) =>
      on(EVENTS.contributionReset, cb),
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
    onUpdateStatus: (cb: (p: UpdateStatus) => void) => on(EVENTS.updateStatus, cb),
    onOverlayClickthrough: (cb: () => void) => on(EVENTS.overlayClickthrough, cb),
    onClientInfo: (cb: (p: ClientInfo | null) => void) => on(EVENTS.clientInfo, cb),
    onAnswerPrefs: (cb: (p: AnswerPrefs) => void) => on(EVENTS.answerPrefs, cb),
    onAudioLevel: (cb: (p: { level: number }) => void) => on(EVENTS.audioLevel, cb),
    onTranscriberStatus: (
      cb: (p: { status: 'reconnecting' | 'connected' | 'disconnected' }) => void,
    ) => on(EVENTS.transcriberStatus, cb),
    onSavePrompt: (cb: (p: SavePrompt) => void) => on(EVENTS.savePrompt, cb),
    onCaptureBuffer: (cb: (p: { images: string[] }) => void) => on(EVENTS.captureBuffer, cb),
    onConfirmRequest: (cb: (p: ConfirmRequest) => void) => on(EVENTS.confirmRequest, cb),
    onVoiceState: (cb: (p: VoiceStateEvent) => void) => on(EVENTS.voiceState, cb),
    onVoiceAudio: (cb: (p: VoiceAudioEvent) => void) => on(EVENTS.voiceAudio, cb),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
