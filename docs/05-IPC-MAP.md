# IPC Event Map

Two directions:
- **invoke/handle** — renderer → main request/response (`ipcRenderer.invoke` ↔
  `ipcMain.handle`). Used for all CRUD and commands. Returns a `Result<T>`.
- **send/on** — main → renderer push events (`webContents.send` ↔
  `ipcRenderer.on`). Used for streaming deltas and state changes.

All channels are defined as constants in `src/shared/ipc.ts` (`IPC` for
request/response, `EVENTS` for push). The renderer only ever touches the typed
preload facade in `src/preload/index.ts` (exposed as `window.api`). Every handler
validates input with zod via the `handle()` helper. Errors are returned as
`{ ok:false, error }`, never thrown across the boundary.

## Channel naming
`<domain>:<action>` — domains: `app`, `dialog`, `settings`, `profiles`,
`documents`, `jobs`, `notes`, `rag`, `session`, `mock`, `capture`, `overlay`,
`privacy`, `data`, `window`.

## invoke / handle (request → response)

### app / dialog
| Channel | Request | Response |
|---|---|---|
| `app:get-info` | — | `{ version, platform }` |
| `dialog:open-file` | — | `{ filePath: string \| null }` (native open dialog) |

### settings
| Channel | Request | Response |
|---|---|---|
| `settings:get` | — | `AppSettings` (no raw key — only `apiKeyPresent`; incl. `tourDone`) |
| `settings:set` | `Partial<AppSettings>` (`models`, `overlay`, `dataConsentAck`, `tourDone`) | `AppSettings` |
| `settings:set-api-key` | `{ key }` | `{ apiKeyPresent: true }` |
| `settings:clear-api-key` | — | `{ apiKeyPresent: false }` |
| `settings:test-api-key` | — | `{ ok, model?, error? }` |
| `settings:list-models` | — | `string[]` |
| `settings:set-shortcuts` | `{ shortcuts }` | `{ shortcuts }` (persist + live re-register global shortcuts) |
| `settings:reset-shortcuts` | — | `{ shortcuts }` (back to defaults) |
| `settings:suspend-shortcuts` / `settings:resume-shortcuts` | — | `{ suspended }` / `{ resumed }` (while recording a binding in the UI) |
| `settings:reset-app` | — | `{ reset, settings }` (factory-reset all settings; native confirm; keeps API key + data) |

### data / window
| Channel | Request | Response |
|---|---|---|
| `data:stats` | — | `{ profiles, interviews, sessions, liveSessions }` (sidebar status panel; `interviews` = total jobs) |
| `data:wipe-all` | — | `{ wiped }` (native confirm; clears API key + all profiles + all sessions) |
| `data:load-samples` | — | `{ profileId, jobs }` (seed a sample résumé profile + Google/Amazon/Stripe interviews; parses + indexes when a key exists) |
| `window:minimize` | — | `{ ok: true }` (custom titlebar control) |
| `window:maximize-toggle` | — | `{ maximized }` |
| `window:close` | — | `{ ok: true }` (hides dashboard to tray) |
| `window:is-maximized` | — | `{ maximized }` |
| `update:get-status` | — | `UpdateStatus` (auto-update state + current version) |
| `update:check` | — | `{ ok: true }` (trigger a check; packaged builds only) |
| `update:install` | — | `{ ok: true }` (quit + install a downloaded update) |

### profiles
| Channel | Request | Response |
|---|---|---|
| `profiles:list` | — | `Profile[]` |
| `profiles:get` | `{ id }` | `Profile` |
| `profiles:create` | `ProfileInput` | `Profile` |
| `profiles:update` | `{ id, patch }` | `Profile` |
| `profiles:delete` | `{ id }` | `{ deleted: true }` |
| `profiles:duplicate` | `{ id }` | `Profile` |

### documents
| Channel | Request | Response |
|---|---|---|
| `documents:extract-file` | `{ filePath }` | `{ text, mime, filename }` (extract only; not persisted) |
| `documents:fetch-url` | `{ url }` | `{ text, title }` (best-effort download + HTML→text of a posting URL; not persisted) |
| `documents:save-resume` | `{ profileId, resumeText }` | `{ keyMissing, parsed, embedded }` (saves resume, parses + reindexes profile base when a key exists) |
| `documents:reindex-profile` | `{ profileId }` | `{ chunks, embedded }` |

### jobs
A profile can target multiple jobs; each holds its own JD and is parsed/indexed
independently.
| Channel | Request | Response |
|---|---|---|
| `jobs:list` | `{ profileId }` | `Job[]` |
| `jobs:page` | `{ profileId, query?, limit=5, offset=0 }` | `{ items: Job[], total }` (server-side pagination + search — `LIKE` on title/company, sorted by `updatedAt` desc. Backs the searchable jobs table) |
| `jobs:get` | `{ id }` | `Job` |
| `jobs:save` | `{ id?, profileId, title, company, jdUrl, jdText, companyUrl, notes }` | `{ job, keyMissing, embedded, companyResearched, companyError }` (create or update; parses JD + indexes when a key exists. `jdUrl` is reference-only. If `companyUrl` is set, best-effort scrapes + parses the company site into `parsed_company` and indexes it as `company` chunks; failures surface in `companyError`, not as an error) |
| `jobs:set-notes` | `{ id, notes }` | `{ job }` (updates the free-form client notes) |
| `jobs:delete` | `{ id }` | `{ deleted: true }` |

### notes
| Channel | Request | Response |
|---|---|---|
| `notes:list` | `{ profileId }` | `Note[]` |
| `notes:create` | `{ profileId, content }` | `Note` |
| `notes:delete` | `{ id }` | `{ deleted: true }` |

### rag (mostly internal; exposed for debugging)
| Channel | Request | Response |
|---|---|---|
| `rag:search` | `{ profileId, query, k }` | `RetrievedChunk[]` |

### session
| Channel | Request | Response |
|---|---|---|
| `session:start` | `{ profileId, interviewType, answerStyle, jobId, answerLength }` | `Session` (`answerStyle` = format/tone; `answerLength` = key_points\|detailed) |
| `session:resume` | `{ sessionId, answerStyle?, answerLength? }` | `Session` (re-activate an existing session row and continue it; interview type is restored from the row — one session per interview, type is dynamic) |
| `session:stop` | `{ sessionId }` | `Session` |
| `session:toggle-pause` | `{ sessionId }` | `{ paused }` |
| `session:toggle-pause-active` | — | `{ paused, active }` (global shortcut target — toggles the live session) |
| `session:stop-active` | — | `{ stopped }` (Cue Card target — stops the live session without a sessionId; the `stopped` sessionState broadcast tears down the dashboard store + mic too) |
| `session:audio-chunk` | `{ sessionId, audio:ArrayBuffer, mime }` | `{ accepted }` |
| `session:realtime-audio` | `{ sessionId, pcm:ArrayBuffer }` | *(one-way `send`, no response — low-latency Realtime STT)* |
| `session:list` | — | `SessionListItem[]` |
| `session:get` | `{ id }` | `SessionDetail` (transcript + questions + answers + report) |
| `session:delete` | `{ id }` | `{ deleted: true }` |
| `session:generate-report` | `{ sessionId }` | `SessionReport` |
| `session:get-report` | `{ sessionId }` | `SessionReport` |
| `session:ask` | `{ sessionId, questionText }` | `{ questionId }` (manual ask; answer streams) |
| `session:ask-active` | `{ questionText }` | `{ ok }` (Cue Card "Ask" box — manual ask for the active session, no id) |
| `session:set-interview-type` | `{ sessionId, interviewType }` | `{ ok }` (set the session-level type — chosen by the user in the save prompt at stop) |
| `session:set-answer-prefs` | `{ interviewType?, style?, length?, pronunciation? }` | `{ interviewType, style, length, pronunciation }` (live Cue Card controls; acts on the active session. Switching `interviewType` is dynamic — it persists onto the session row + reframes later answers) |
| `session:regenerate` | — | `{ regenerated }` (re-answer the last question for the active session) |
| `session:clear-answer` | — | `{ cleared }` (abort the in-flight answer for the active session) |

### mock (AI-driven mock interviewer)
| Channel | Request | Response |
|---|---|---|
Mock = a **Cue Card copilot rehearsal**: the AI interviewer asks questions aloud and each
question flows through the live answer pipeline, streaming a grounded answer into the Cue Card.
Runs as a non-persisted live session (`isMock`) that's deleted on end — never saved to Reports.
| Channel | Request | Response |
|---|---|---|
| `mock:start` | `{ profileId, voice, jobId, interviewType }` | `{ session, question, audioBase64, index, total }` (opens the Cue Card; Q1 spoken + answered) |
| `mock:next` | `{ sessionId }` | `{ done, question?, audioBase64?, index, total }` (next question — spoken + answered in the Cue Card) |
| `mock:end` | `{ sessionId }` | `{ ended }` (stops + deletes the mock session) |

### capture / coding
| Channel | Request | Response |
|---|---|---|
| `capture:region` | — | `{ image: dataURL }` (ad-hoc full-screen grab) |
| `capture:open-selector` | — | `{ opened: true }` (freezes screen, opens region selector window) |
| `capture:get-frame` | — | `{ image: string \| null }` (selector fetches the frozen frame to crop) |
| `capture:close-selector` | — | `{ closed: true }` |
| `capture:solve` | `{ text }` | `{ started: true }` (announces a `coding` question; solution streams to overlay) |
| `capture:solve-image` | `{ image }` | `{ started: true }` (vision-based solve from an image) |
| `capture:quick-solve` | — | `{ started: true }` (solve from clipboard text) |

### overlay / privacy
| Channel | Request | Response |
|---|---|---|
| `overlay:show` / `overlay:hide` / `overlay:toggle` | — | `{ visible }` |
| `overlay:set-mode` | `{ mode:'compact'\|'expanded' }` | `{ mode }` |
| `overlay:set-opacity` | `{ opacity }` | `{ opacity }` |
| `overlay:set-clickthrough` | `{ enabled }` | `{ enabled }` |
| `privacy:get` | — | `{ enabled }` |
| `privacy:toggle` | — | `{ enabled }` |
| `privacy:set` | `{ enabled }` | `{ enabled }` |

### dev (DEV-ONLY — registered only when `!app.isPackaged`)
Read-only local DB explorer; the renderer route/nav is also gated on `import.meta.env.DEV`.
| Channel | Request | Response |
|---|---|---|
| `dev:tables` | — | `{ name, rows }[]` (user tables + row counts) |
| `dev:rows` | `{ table, limit=50, offset=0 }` | `{ columns, rows, total }` (table name validated against `sqlite_master`) |

## send / on (main → renderer events)

Channel constants live in `EVENTS` (`src/shared/ipc.ts`); payload types are in
`src/shared/types.ts`.

| Channel | Payload | Target |
|---|---|---|
| `session:state` | `{ status, paused }` | dashboard + overlay |
| `session:transcript-delta` | `{ text, isFinal, speaker }` | dashboard + overlay |
| `session:question-detected` | `DetectedQuestion` | dashboard + overlay |
| `session:answer-delta` | `{ questionId, token }` | overlay (+ dashboard) |
| `session:answer-meta` | `{ questionId, talkingPoints, resumeMatch, star, clarifyingQuestion, riskWarning, followupQuestion }` | overlay |
| `session:answer-done` | `{ questionId }` | overlay |
| `session:answer-reset` | `{ questionId }` | overlay (regenerate: clear the Cue Card answer but keep the transcript — no new question row/line) |
| `session:client-info` | `ClientInfo \| null` | overlay (active interview: company/title/notes + profileName + grounding flags hasResume/hasJd/hasCompany, for the Cue Card header + session bar + ⓘ panel; `null` clears on stop) |
| `session:answer-prefs` | `AnswerPrefs` (`{ interviewType, style, length, pronunciation }`) | overlay (seeds the Cue Card answer-control toggles) |
| `session:audio-level` | `{ level }` (0-1 RMS, ~12/sec) | overlay (drives the Cue Card mic meter; computed in `feedRealtimeAudio` since the stream lives in the dashboard renderer) |
| `session:save-prompt` | `SavePrompt` (`{ sessionId, interviewType, jobTitle, questionCount }`) | dashboard (a session just stopped → prompt save-or-discard + pick the type) |
| `session:context` | `{ questionId, question, chunks }` | dashboard (debug: retrieved chunks) |
| `session:error` | `{ message }` | dashboard + overlay |
| `overlay:apply-settings` | `{ opacity, fontSize, mode }` | overlay |
| `shortcut:fired` | `{ action }` | dashboard |
| `privacy:changed` | `{ enabled }` | dashboard + overlay (keeps every privacy indicator in sync) |
| `overlay:visibility` | `{ visible }` | dashboard (reflects overlay show/hide) |
| `app:navigate` | `{ path }` | dashboard (tray "Settings" routes here) |
| `window:maximized` | `{ maximized }` | dashboard (titlebar maximize/restore icon) |
| `data:changed` | `{ reason }` | dashboard (refresh status panel after a data wipe) |
| `selection:reset` | `{ image }` | region selector (push a fresh frame + reset state) |
| `update:status` | `UpdateStatus` | dashboard (auto-update banner + Settings) |

## Result envelope
```ts
type Result<T> = { ok: true; data: T } | { ok: false; error: string };
```
The preload wrapper unwraps `Result` and throws on `ok:false` so renderer code
can use normal try/catch / async-await.
