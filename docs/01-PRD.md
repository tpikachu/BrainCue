# Product Requirements Document — BrainCue v2

> Status: v2 scope. Supersedes the v1 interview-copilot PRD (2026-06-22; see git
> history and [09-MVP-PLAN.md](./09-MVP-PLAN.md) for what v1 shipped). Last
> updated 2026-07-21. Vision: [00-VISION.md](./00-VISION.md) · Delivery:
> [10-ROADMAP.md](./10-ROADMAP.md).

## 1. Summary

A cross-platform **desktop ambient AI companion** (Electron + React +
TypeScript). It captures live audio (microphone / system loopback), transcribes
in real time, decides **when to contribute** via a per-mode trigger policy,
grounds each contribution in the user's local documents (and, later, memory),
and delivers it through an unobtrusive, capture-invisible overlay or its own
voice. Interviews (either side), meetings, tutoring, and ambient companionship
are **modes** of one engine.

**This is not an offline app.** User data is stored **locally**, but AI features
call an **AI provider's API** using a key the user provides in Settings — OpenAI
today, with a provider abstraction and multi-provider support planned (§6.7).

## 2. Goals

- One conversation engine, many modes — a mode is configuration, never a fork.
- Preserve the v1 interview experience exactly (it is the revenue-path parity
  gate for every refactor).
- Graduate output surfaces: silent overlay cues → full spoken dialogue.
- Keep the v1 guarantees: local-first data, BYO key, capture-invisible overlay,
  grounded answers, transparency about what leaves the machine.

## 3. Non-goals (explicitly out of scope)

- ❌ Authentication, accounts, subscriptions, billing, cloud backend/sync
- ❌ Process hiding, task-manager spoofing, anti-proctoring / evasion
- ❌ Competing with ChatGPT/Gemini on **generic** voice chat (no corpus, no
  presence) — we only do voice grounded in the user's context and activities
- ❌ Cloud memory — memory (Phase 4) is local, visible, editable, deletable
- ❌ Always-on listening without an explicit session start (Companion mode still
  begins with a user action)

## 4. Target users, by mode

| Mode | Target user |
| --- | --- |
| Interview Copilot | candidate in a context where AI assistance is permitted (practice, allowed take-homes, coaching, accessibility) |
| Interviewer Assist | hiring manager / engineer running interviews, wanting better coverage and fairer evaluations |
| Meeting Copilot | anyone in back-to-back calls who wants context, open threads, and action items caught live |
| Tutor | self-learner with material to master (course, codebase, language, cert) |
| Companion | someone who wants an ambient presence with memory while working or gaming |

## 5. Domain model (v2 vocabulary)

| Concept | Was (v1) | v2 meaning |
| --- | --- | --- |
| **Profile** | the candidate | **who you are** — background documents (resume et al.), notes, style, language; reused everywhere |
| **Context Pack** | Job | **what this is about** — a bundle of documents parsed/embedded as a unit; `kind: job \| subject \| project \| custom`. A job application, a course, a game, a meeting series |
| **Session** | live interview / mock / sparring | one run of a **mode**: `mode` + profile + optional context pack + per-mode settings; transcript, contributions, and report persist to it |
| **Mode** | implicit (interview only) | a code-defined preset over the engine: sources + trigger policy + persona + grounding scope + surfaces + overlay layout |
| **Memory** | — | (Phase 4) durable facts BrainCue has learned, stored locally, injected into grounding, fully user-editable |

**Migration requirements (lossless, automatic):** `jobs` generalizes to context
packs of `kind='job'`; sessions gain a `mode` column (existing rows map from
`kind`: live→interview, mock/sparring→practice); `InterviewType` becomes
interview/practice-mode scenario config rather than a session-level universal.
No user-visible data loss; v1.5.x databases must open clean.

## 6. The conversation engine (functional requirements)

### 6.1 Sources
Microphone, system loopback (unchanged from v1), screen region + clipboard
capture (unchanged), and a **summon** input: global push-to-talk / typed ask
addressed directly to BrainCue from any mode.

### 6.2 Transcription
OpenAI **Realtime GA** streaming STT with server VAD (unchanged); chunked STT
fallback. Speaker attribution stays best-effort (`interviewer`/`user` labels
generalize to `them`/`you`).

### 6.3 Trigger policy — *the* key generalization
A mode declares when the agent contributes:

| Policy | Fires when | Used by |
| --- | --- | --- |
| **reactive** | a question/request directed at the user is detected (v1's classifier) | Interview Copilot |
| **proactive** | salience detected: unanswered question, action item, claim needing context, coverage gap | Meeting Copilot, Interviewer Assist |
| **dialogue** | it is the agent's turn in a two-way conversation | Practice, Tutor, Companion |
| **summoned** | the user explicitly asks (hotkey / push-to-talk / Ask box) | every mode |

Requirements: per-mode **sensitivity** control, interjection cooldowns, and a
hard mute (pause AI) that always wins. Quiet is the default posture.

### 6.4 Grounding
Retrieval over profile + the session's context pack (+ memory in Phase 4),
exactly as v1's RAG path. The "data sent to OpenAI" transparency panel remains a
hard requirement in every mode.

### 6.5 Generation
Per-mode persona prompt; streaming; the never-invent rule and risk warnings
carry over from v1 §7.3 unchanged.

### 6.6 Surfaces
- **Cue Card overlay** — always-on-top, capture-excluded, movable, compact /
  expanded; card *types* vary per mode (answer cue, suggested question,
  context card, action item, tutor prompt).
- **Voice** — turn-based TTS today (Practice); Phase 3 upgrades to Realtime
  speech-to-speech with barge-in and output-device selection.
- **Reports** — per-session artifacts (coaching report, meeting summary,
  interview evaluation, study progress) in the existing Reports page.

### 6.7 Provider layer (multi-AI)
The engine talks to capabilities, not to OpenAI: a `Provider` interface exposes
`chat` (streaming), `embeddings`, `stt` (realtime + chunked), `tts`/`speech`,
and `vision`, and each concrete provider declares which it implements.

- **BYO key per provider**, all stored with the same safeStorage rules; the
  renderer still only ever learns booleans.
- **Mix-and-match by capability** — e.g. a cheaper provider for meeting
  salience classification, a stronger one for answer generation; per-capability
  provider/model selection lives in Settings.
- **Graceful degradation** — a mode that needs a capability the selected
  provider lacks (e.g. realtime STT is OpenAI-only at first) says so and falls
  back or disables, never silently breaks.
- **Embeddings caveat** — switching the embedding provider invalidates the
  local vector store; the app must offer (and cost-estimate) a re-index rather
  than mixing incompatible vectors.

OpenAI remains the reference implementation and default; the seam is cut during
the Phase 1 engine extraction, and a second provider ships per the roadmap.

## 7. Mode requirements

### 7.1 Interview Copilot — parity
Everything in the v1 PRD §7 (profiles, jobs→context packs, documents, RAG, live
session, overlay, coding/screenshot mode, privacy, tour) remains in force
verbatim. This mode is the regression gate: no v2 refactor may degrade it.

### 7.2 Interviewer Assist (new, Phase 2)
Inputs: your role's JD (context pack) + the candidate's resume (document).
Live: suggested opening questions, follow-up suggestions generated from the
candidate's last answer (reuses `interviewer.ts`), and a coverage tracker
(which competency areas have/haven't been probed). Post-session: a structured
evaluation draft (reuses `feedback.ts`). Same overlay, opposite chair.

### 7.3 Meeting Copilot (new, Phase 2)
Quiet by default. Proactive contribution cards: relevant context from the
pack ("this was decided in the attached doc"), open-question tracker ("Sarah's
question about billing never got answered"), and action items as they're
spoken. End of session: meeting summary report (decisions, actions, open
threads). Sensitivity dial from "only when summoned" to "eager".

### 7.4 Tutor (Phase 3)
Any context pack of kind `subject` (textbook chapter, codebase docs, language
notes). Teach / quiz / drill loop — a generalization of v1 sparring: agent
speaks (voice), user answers by voice, per-answer coaching persists to Reports.
Phase 3's Realtime speech-to-speech makes it a natural conversation rather than
turn-based MP3 exchanges.

### 7.5 Companion (Phase 4)
Explicitly started, memory-backed ambient presence. A **presence dial**
(silent observer ↔ chatty) controls the interjection policy. Game-buddy is
Companion + the existing screen-region Vision path pointed at the game. Depends
on: memory subsystem, interjection policy engine, Realtime voice, and cost
governance — hence last.

### 7.6 Practice
v1's mock + sparring continue unchanged, re-labelled as the Practice mode
family; they migrate onto the engine's `dialogue` policy when Tutor is built
(shared loop), not before.

## 8. Non-functional requirements

- **Latency**: first contribution token < 2.5s after trigger (unchanged);
  voice round-trip target < 1.5s once on Realtime speech (Phase 3).
- **Privacy invariants (unchanged, non-negotiable)**: key never crosses IPC,
  never logged, never committed; all persistence in the userData dir; overlay +
  dialogs capture-excluded; full local deletion of any entity.
- **Cost governance**: per-session cost estimate visible; VAD gating so silence
  costs nothing; (Phase 4) session budget warnings; evaluate local STT
  (whisper.cpp) as a cost/offline option — evaluation, not commitment.
- **Migration**: v1.5.x → v2.0 automatic and lossless (§5).
- **Performance**: an idle listening session (no speech) must not exceed a few
  percent CPU; one active session at a time (v1 constraint kept).

## 9. Success metrics (qualitative, per phase)

- **P1**: zero interview-mode regressions (unit tests + privacy hard test);
  clean migration of a real v1 database.
- **P2**: in a real meeting, ≥1 genuinely useful contribution with zero
  annoying interjections at default sensitivity; interviewer-assist produces a
  usable evaluation draft.
- **P3**: a tutor session feels like conversation (no dead air > 2s); a user
  can drill arbitrary material end-to-end.
- **P4**: companion recalls a fact from a prior session unprompted and
  correctly; user reports it "knows when to shut up".

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Interjection annoyance kills trust in ambient modes | silence-first defaults, sensitivity dial, cooldowns, hard mute |
| Always-on API cost surprises | VAD gating, visible cost estimates, budgets; local STT evaluation |
| Mode sprawl forks the codebase | engine-first rule enforced in review; modes are config |
| Refactor breaks the shipped interview product | parity gate: full test suite + privacy hard test at every phase boundary |
| Rebrand confuses existing users | flows unchanged; tour + changelog explain the widening, not a pivot away |
| Provider lock-in / API drift (Realtime GA is OpenAI-shaped) | provider layer (§6.7): capability interfaces, per-capability fallbacks, OpenAI as reference impl |
