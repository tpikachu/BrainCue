# IPC Event Map

> **v2 (migration 0008):** every `Session` returned over IPC now carries an
> additive `mode` field (`interview|practice|…` — SessionMode); the `jobId`
> field name is kept for compatibility and refers to a context-pack id. The
> interviewType/answerFormat/voice zod enums are single-sourced in
> `src/main/ipc/schemas.ts` (they were previously duplicated inline in four
> `.ipc.ts` files — note `answerFormat` includes `story_teller`, which an older
> revision of this doc omitted). Channel names are unchanged.

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
`documents`, `jobs`, `notes`, `session`, `mock`, `capture`, `overlay`,
`privacy`, `ui`, `data`, `window`.

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
| `settings:reset-app` | — | `{ reset, settings }` (factory-reset all settings; in-window confirm; keeps API key + data) |

### data / window
| Channel | Request | Response |
|---|---|---|
| `data:stats` | — | `{ profiles, interviews, sessions, liveSessions }` (sidebar status panel; `interviews` = total jobs) |
| `data:wipe-all` | — | `{ wiped }` (in-window confirm; clears API key + all profiles + all sessions) |
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
| `jobs:brief` | `{ id }` | `InterviewBrief` (grounded pre-interview prep brief from the profile's parsed résumé × the job's parsed JD × parsed company research — likely questions, coverage gaps, strengths, company angles. Not persisted; regenerated on demand. Throws a guidance error if the key, parsed résumé, or parsed JD is missing) |
| `jobs:delete` | `{ id }` | `{ deleted: true }` |

### notes
| Channel | Request | Response |
|---|---|---|
| `notes:list` | `{ profileId }` | `Note[]` |
| `notes:create` | `{ profileId, content }` | `Note` |
| `notes:delete` | `{ id }` | `{ deleted: true }` |

### applications (Tailor Resume)
A job application produced by the Tailor Resume flow: an ATS-friendly resume tailored
from a base resume × JD (grounded — never invented), plus answers to the application
questions. Each application owns a dedicated (hidden) job row; its tailored resume is
indexed as that job's `tailored` chunks, so "Start interview" (session.start with the
app's profile+job) grounds the live session in the TAILORED resume + JD.
| Channel | Request | Response |
|---|---|---|
| `applications:page` | `{ query?, limit=8, offset=0 }` | `{ items: ApplicationListItem[], total }` (global, newest first; `LIKE` over name/title/company) |
| `applications:get` | `{ id }` | `Application` |
| `applications:tailor` | `{ profileId\|null, baseResumeText\|null, jdText, questions[] }` | `{ application, embedded, indexError }` (ALL model calls run before any write — an LLM failure persists nothing. An uploaded base resume materializes a real profile. Indexing is best-effort AFTER the rows exist: on failure the app is still saved and `indexError` is set — recover via `applications:reindex`) |
| `applications:reindex` | `{ id }` | `{ embedded }` (re-embed the owning profile's base chunks AND the job's jd/tailored chunks — full recovery/refresh) |
| `applications:export-pdf` | `{ id }` | `{ saved, filePath? }` (tailored resume → ATS-friendly PDF via a hidden window + printToPDF; native save dialog; `saved:false` on cancel) |
| `applications:delete` | `{ id }` | `{ deleted: true }` (also removes the dedicated job + its chunks; sessions keep history with jobId nulled) |

### stories
The per-profile STAR story bank (`Story[]`). Stories are extracted from the parsed
résumé, persisted, and indexed as `story` chunks so they ground live answers.
| Channel | Request | Response |
|---|---|---|
| `stories:list` | `{ profileId }` | `Story[]` |
| `stories:generate` | `{ profileId }` | `Story[]` (extract grounded STAR stories from the résumé; **embeds first, then atomically replaces** rows + chunks + embeddings — a failed embedding or empty extraction leaves the prior bank intact. Throws without a key / parsed résumé) |
| `stories:update` | `{ id, patch: { title?, situation?, task?, action?, result? } }` | `Story` (edit one story's text; re-indexes) |
| `stories:delete` | `{ id }` | `{ deleted: true }` (re-indexes) |

### session
| Channel | Request | Response |
|---|---|---|
| `session:start` | `{ profileId, interviewType, jobId, answerFormat }` | `Session` (`answerFormat` = key_points\|explanation\|detailed — the single answer control) |
| `session:resume` | `{ sessionId, answerFormat? }` | `Session` (re-activate an existing session row and continue it; interview type is restored from the row — one session per interview, type is dynamic) |
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
| `session:set-answer-prefs` | `{ interviewType?, format?, pronunciation? }` | `{ interviewType, format, pronunciation }` (live Cue Card controls; acts on the active session. Switching `interviewType` is dynamic — it persists onto the session row + reframes later answers) |
| `session:set-answering` | `{ enabled }` | `{ enabled, answered }` (coding "listen-only" toggle: when disabled, the interviewer is still transcribed but not auto-answered; enabling it also answers the question they just asked) |
| `session:regenerate` | `{ questionId? }` | `{ regenerated }` (re-answer a SPECIFIC question by id — the Cue Card's per-card ↻ — or, with no id, the last question after a format/pronunciation toggle) |
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

### sparring (two-way voice mock)
A back-and-forth voice drill: the AI asks aloud, the candidate answers by speaking
(push-to-talk), and each answer is coached. State is in-memory only (ephemeral — nothing
persisted; no DB session, no Cue Card).
| Channel | Request | Response |
|---|---|---|
| `sparring:start` | `{ profileId, voice, jobId, interviewType }` | `{ sessionId, question, audioBase64, index, total }` (asks Q1 aloud) |
| `sparring:answer` | `{ sessionId, audioBase64, mime }` | `{ transcript, feedback }` (transcribes the recorded clip + returns `SparringFeedback`) |
| `sparring:next` | `{ sessionId }` | `{ done, question?, audioBase64?, index, total }` (history-aware follow-up, spoken) |
| `sparring:end` | `{ sessionId }` | `{ ended }` (clears the in-memory session) |

### capture / coding
| Channel | Request | Response |
|---|---|---|
| `capture:region` | — | `{ image: dataURL }` (ad-hoc full-screen grab) |
| `capture:open-selector` | — | `{ opened: true }` (freezes screen, opens region selector window) |
| `capture:get-frame` | — | `{ image: string \| null }` (selector fetches the frozen frame to crop) |
| `capture:close-selector` | — | `{ closed: true }` |
| `capture:solve` | `{ text }` | `{ started: true }` (announces a `coding` question; solution streams to overlay) |
| `capture:solve-image` | `{ image }` | `{ started: true }` (vision-based solve from a single image) |
| `capture:quick-solve` | — | `{ started: true }` (solve from clipboard text) |
| `capture:add-region` | `{ image }` | `{ added: true }` (add a captured region to the multi-image buffer; broadcasts `capture:buffer`) |
| `capture:solve-buffer` | — | `{ started: true }` (solve ALL buffered screenshots in one vision call, then clear) |
| `capture:clear-buffer` | — | `{ cleared: true }` |
| `capture:resolve-last` | — | `{ started: true }` (re-solve the most recent coding problem — the per-card ↻ on a coding-solve card; picks up the current language) |

### overlay / privacy
| Channel | Request | Response |
|---|---|---|
| `overlay:show` / `overlay:hide` / `overlay:toggle` | — | `{ visible }` |
| `overlay:set-mode` | `{ mode:'compact'\|'expanded' }` | `{ mode }` |
| `overlay:set-opacity` | `{ opacity }` | `{ opacity }` |
| `overlay:set-clickthrough` | `{ enabled }` | `{ enabled }` |
| `overlay:copy-text` | `{ text }` | `{ copied: true }` (write text to the OS clipboard for the per-card "Copy" — routed through main because the renderer's clipboard-write permission is denied) |
| `privacy:get` | — | `{ enabled }` |
| `privacy:toggle` | — | `{ enabled }` |
| `privacy:set` | `{ enabled }` | `{ enabled }` |

### ui
| Channel | Request | Response |
|---|---|---|
| `ui:confirm-response` | `{ id, ok }` | `{ ok: true }` (renderer's reply to a main-initiated in-window confirm — see the `ui:confirm-request` event. Replaces native `dialog.showMessageBox`, which is a separate OS window visible in a screen share; `confirmInWindow` in `services/ui/confirm.ts` shows the modal inside a protected window and awaits this reply) |

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
| `contribution:open` | `ContributionOpenEvent` (`{ contributionId, kind, title }`) | overlay — the v2 generic card feed. Every engine/solver output dual-emits a generic contribution event AND its legacy `session:answer-*`/`question-detected` twin with the exact v1 payload (compat adapter for one release; see `src/main/ipc/contributionBridge.ts`). The overlay consumes ONLY these; the dashboard still uses the legacy events |
| `contribution:delta` | `{ contributionId, token }` | overlay (streamed body token, routed by contribution id) |
| `contribution:patch` | `{ contributionId, meta?, context?, followup? }` | overlay (named annotations — the same payloads the legacy answer-meta / context / answer-followup events carry) |
| `contribution:done` | `{ contributionId }` | overlay (stream finished — completed or aborted) |
| `contribution:reset` | `{ contributionId }` | overlay (regenerate: clear that card's body, keep the card) |

Memory additions (Prompt 8): `memory:list` / `memory:review` (approve with
optional edits, or reject) / `memory:update` / `memory:archive` /
`memory:delete` (removes the row AND its embedding) /
`memory:set-pack-enabled` (per-Space opt-out); `settings:set` accepts
`memoryEnabled` (the global consent switch, default off). Recalled memories
ride the `session:context` / `contribution:patch` payloads as a separate
`memories` array so "data sent" always shows every memory used.

Meeting Copilot additions (Prompt 7): `session:start` now accepts `mode`
(SessionMode, default `interview`) and `presence`
(summoned|quiet|balanced|active) for ambient modes; `session:meeting-report`
returns `{ contributionId, report: MeetingReport }` (get-or-generate);
`contributions:update` edits a persisted contribution's
title/body/meta/status (the meeting report's action items / open questions
stay editable). Ambient meeting cards broadcast ONLY the generic
`contribution:*` events — no legacy `answer-*` twins.

Voice/summon additions (Prompt 9): request channels `voice:summon` (the
push-to-talk press — state-dependent: idle→listen, listening→send,
speaking→interrupt), `voice:commit`, `voice:cancel`, `voice:interrupt`,
`voice:playback-done` (`{ generation }`), `voice:get-prefs` /
`voice:set-prefs` (`VoicePrefs`: TTS voice, hard mute, output device,
saveQuickAsks, quickAskPackId); plus one-way `voice:audio` (PCM16 frames while
listening, `ipcRenderer.send` like `session:realtime-audio`). Events:
`voice:state` (`VoiceStateEvent` — every dialogue-controller transition, with
the turn `generation` that stale audio is dropped against) and
`voice:audio-segment` (`VoiceAudioEvent` — one synthesized sentence per
segment, in `seq` order; an empty `last:true` marker ends the reply). An
in-session summon is a normal engine direct ask (dual-emitted events, v1
persistence); a no-session quick ask streams GENERIC-only `contribution:*`
events like ambient cards.
| `session:client-info` | `ClientInfo \| null` | overlay (active interview: company/title/notes + profileName + grounding flags hasResume/hasJd/hasCompany, for the Cue Card header + session bar + ⓘ panel; `null` clears on stop) |
| `session:answer-prefs` | `AnswerPrefs` (`{ interviewType, format, pronunciation }`) | overlay (seeds the Cue Card answer-control toggles) |
| `session:audio-level` | `{ level }` (0-1 RMS, ~12/sec) | overlay (drives the Cue Card mic meter; computed in `feedRealtimeAudio` since the stream lives in the dashboard renderer) |
| `session:save-prompt` | `SavePrompt` (`{ sessionId, interviewType, jobTitle, questionCount }`) | dashboard (a session just stopped → prompt save-or-discard + pick the type) |
| `session:context` | `{ questionId, question, chunks }` | dashboard (debug: retrieved chunks) |
| `session:error` | `{ message }` | dashboard + overlay |
| `capture:buffer` | `{ images: string[] }` | overlay (current multi-image problem captures, for the Cue Card thumbnail strip) |
| `overlay:apply-settings` | `{ opacity, fontSize, mode }` | overlay |
| `shortcut:fired` | `{ action }` | dashboard |
| `privacy:changed` | `{ enabled }` | dashboard + overlay (keeps every privacy indicator in sync) |
| `ui:confirm-request` | `ConfirmRequest` (`{ id, title, detail, confirmLabel, cancelLabel, tone }`) | ONE protected window (focused app window → visible dashboard → visible overlay) — a main-initiated confirm rendered in-window by `ConfirmHost`; the user's choice returns via the `ui:confirm-response` handler. Replaces native `dialog.showMessageBox` so confirms don't leak into a screen share |
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
