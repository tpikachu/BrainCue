# Folder Structure

```
AI_Inter/
├─ docs/                        # this design set
├─ electron.vite.config.ts      # main + preload + renderer build config
├─ electron-builder.yml         # packaging (win/mac/linux, icons)
├─ drizzle.config.ts            # drizzle-kit (schema -> migrations)
├─ drizzle/                     # generated SQL migrations + meta (bundled into the app)
├─ package.json
├─ tsconfig.json / tsconfig.node.json / tsconfig.web.json
├─ tailwind.config.js / postcss.config.js
├─ vitest.config.ts
├─ .gitignore
├─ index.html                   # single renderer entry (dashboard/overlay/selection roots chosen at runtime)
│
├─ scripts/
│  ├─ run-electron-vite.mjs     # dev/preview launcher
│  ├─ clean-release.mjs         # kill running app + wipe release/ (pre-package)
│  └─ generate-icon.mjs         # icon.svg -> icon.png + icon.ico
│
├─ resources/                   # build resources (not packed into app)
│  ├─ icon.svg                  # icon source
│  ├─ icon.png                  # 1024² master (mac/linux)
│  └─ icon.ico                  # multi-resolution Windows icon
│
├─ src/
│  ├─ shared/                   # imported by BOTH main and renderer (types/constants only)
│  │  ├─ ipc.ts                 # IPC + EVENTS channel name constants
│  │  ├─ types.ts               # domain types (Profile, Job, Session, ...)
│  │  └─ result.ts              # Result<T> envelope
│  │
│  ├─ main/                     # MAIN PROCESS (Node, trusted)
│  │  ├─ index.ts               # entry: lifecycle, init order
│  │  ├─ env.ts                 # isDev, paths, env var access
│  │  ├─ shortcuts.ts           # global shortcut registration
│  │  ├─ windows/
│  │  │  ├─ mainWindow.ts  overlayWindow.ts  selectionWindow.ts
│  │  │  └─ loadRenderer.ts     # dev-URL vs file load + diagnostics
│  │  ├─ ipc/
│  │  │  ├─ index.ts            # registerIpc(): wires all handlers
│  │  │  ├─ helpers.ts          # handle() wrapper + zod validation
│  │  │  ├─ broadcast.ts        # push events to dashboard/overlay
│  │  │  ├─ settings.ipc.ts  profiles.ipc.ts  documents.ipc.ts
│  │  │  ├─ jobs.ipc.ts  notes.ipc.ts  session.ipc.ts  mock.ipc.ts
│  │  │  ├─ capture.ipc.ts  overlay.ipc.ts  dialog.ipc.ts
│  │  ├─ db/
│  │  │  ├─ index.ts            # better-sqlite3 + drizzle init + migrate
│  │  │  ├─ schema.ts           # drizzle table definitions
│  │  │  └─ repositories/       # typed data access per entity
│  │  │     ├─ profiles.repo.ts  jobs.repo.ts
│  │  │     ├─ sessions.repo.ts  settings.repo.ts
│  │  ├─ services/
│  │  │  ├─ openai/             # see 06-OPENAI-SERVICE.md
│  │  │  │  ├─ client.ts  models.ts  parsing.ts  embeddings.ts
│  │  │  │  ├─ questions.ts  answer.ts  transcription.ts
│  │  │  │  ├─ coding.ts  codingPrompt.ts  vision.ts
│  │  │  │  ├─ interviewer.ts   # mock-interview question/feedback gen
│  │  │  │  ├─ tts.ts           # text-to-speech (mock voice)
│  │  │  │  └─ realtime.ts  realtimeEvents.ts   # Realtime STT
│  │  │  ├─ rag/
│  │  │  │  ├─ vectorStore.ts   # interface + SQLite blob store
│  │  │  │  ├─ vectorMath.ts    # cosine / decode helpers
│  │  │  │  ├─ chunker.ts       # text -> chunks
│  │  │  │  ├─ indexProfile.ts  # reindexProfile() + indexJob()
│  │  │  │  └─ retriever.ts     # embed query -> top-k
│  │  │  ├─ documents/
│  │  │  │  ├─ extract.ts       # pdf/docx/txt/md -> text
│  │  │  │  ├─ fetchUrl.ts      # download a posting URL -> readable text
│  │  │  │  └─ companyResearch.ts # scrape company site (home + about/careers…) -> text
│  │  │  ├─ capture/
│  │  │  │  ├─ screenshot.ts    # desktopCapturer + region crop
│  │  │  │  └─ codingMode.ts    # coding-question solve flow
│  │  │  ├─ mock/
│  │  │  │  └─ mockManager.ts   # mock-interview session orchestration
│  │  │  ├─ session/
│  │  │  │  ├─ sessionManager.ts# live session orchestration
│  │  │  │  ├─ report.ts        # post-session report generation
│  │  │  │  └─ privacy.ts       # screen-capture privacy affinity
│  │  │  └─ security/
│  │  │     ├─ apiKey.ts        # safeStorage-backed ApiKeyStore
│  │  │     └─ logger.ts        # redacting logger
│  │  │
│  ├─ preload/
│  │  ├─ index.ts               # contextBridge -> window.api (typed facade)
│  │  └─ index.d.ts             # ambient types for window.api
│  │
│  └─ renderer/                 # RENDERER (React)
│     ├─ main.tsx               # entry: mounts dashboard / overlay / selection
│     ├─ index.css              # tailwind entry
│     ├─ components/            # Markdown.tsx  Waveform.tsx  ui.tsx (shared kit)
│     ├─ lib/
│     │  ├─ api.ts              # thin wrapper over window.api
│     │  ├─ useMicCapture.ts  useAnswerRecorder.ts  pcm.ts
│     │  └─ usePagedSearch.ts
│     ├─ store/                 # zustand: useProfileStore.ts  useSettingsStore.ts  useTourStore.ts
│     ├─ dashboard/
│     │  ├─ App.tsx             # router + shell (hosts the guided tour)
│     │  ├─ Tour.tsx            # first-run guided tour (spotlight + steps)
│     │  └─ pages/  (Profiles, ProfileEditor, Session, Mock, Reports, Settings)
│     ├─ overlay/               # always-on-top Cue Card (contribution feed)
│     │  ├─ Overlay.tsx          # shell: window state, IPC subscriptions, composition
│     │  ├─ store/useOverlayStore.ts   # zustand card feed (reducers in cards/model.ts)
│     │  ├─ cards/               # ContributionCard frame + registry.ts + per-kind views + UnknownCardView
│     │  ├─ controls/            # HeaderBar  SessionBar  AnswerControls  AskBar  Btn  EqualizerBars
│     │  ├─ panels/              # ClientNotes  Captures  ErrorBanner  AudioMeter  Transcript  DataSent  SettingsModal
│     │  └─ lib/                 # streamBuffer.ts (rAF token coalescer)  style.ts
│     └─ selection/RegionSelector.tsx  # region-capture window
│
└─ (userData at runtime: app.db, documents/, vectors/ — see 04-DATABASE.md)
```

## Module boundaries
- `src/shared` must contain **types and constants only** (no Node, no DOM) so it
  is safe to import from both sides.
- `src/main` may use Node + Electron main APIs. Never imported by renderer.
- `src/renderer` may use DOM/React. Reaches main only via `window.api`.
- `src/preload` is the only place using `contextBridge`/`ipcRenderer`.

Path aliases (configured in `electron.vite.config.ts` + tsconfigs): `@shared`,
`@main`, `@renderer`.
