# Roadmap — BrainCue v2 and beyond

> Supersedes [09-MVP-PLAN.md](./09-MVP-PLAN.md) (kept as the record of the
> shipped v1 build). Vision: [00-VISION.md](./00-VISION.md) · Spec:
> [01-PRD.md](./01-PRD.md). Phases ship as release trains (v2.0, v2.1, …);
> milestones within a phase are independently landable PRs. The changelog is
> the authoritative record of what shipped when; this document is the
> plan-shaped view of the same history, plus what comes next. The live
> position of the current train is [BOARD.md](BOARD.md).

## Where we are (2026-07-29 — v2.1.0 shipped)

A **phase** is a planned train of milestones, numbered continuously since the
v2 program began: Phase 1 shipped as v2.0, Phases 2–4 were planned as v2.1
through v3.0, and a milestone number like `2.3` means *phase 2, milestone 3*.
Delivery ran ahead of that ordering — voice, memory, and the companion landed
before Interviewer Assist, Tutor, and the second provider — so Phases 1–4 no
longer have sections of their own: their milestones live in the table below
with their fate, and the changelog holds the shipped record. The first phase
that is still a *plan* is [Phase 5](#phase-5--v22-trust-the-local-first-promise-made-good),
the v2.2 train. v2.1 also added a layer the original plan never named:
**activities** (the user says what a call is, the engine derives the mode —
one list, not two) and **continuity** (a Space is where a conversation is
kept; kept conversations ground the next one) — those rows carry a dash
instead of a milestone number.
✅ shipped · 🧪 shipped behind a Labs badge · ⬜ open.

| Milestone | Status |
| --- | --- |
| 1.1–1.4 One engine (schema, engine extraction, provider seam, rebrand) | ✅ v2.0 |
| 2.1 Meeting Copilot | 🧪 Labs (`meeting.acceptance.test.ts` gate) — graduation criteria scheduled: 5.5 |
| 2.2 Interviewer Assist | ⬜ later train |
| 2.3 Multi-provider v1 | ⬜ **scheduled v2.2 (5.1)** — seam ✅ since v2.0; Settings → Providers still says "Coming soon" |
| 3.1 Voice output | ✅ sentence-streamed TTS + barge-in; Realtime speech-to-speech ⬜ later train |
| 3.2 Tutor | ⬜ later train — `subject` ships meanwhile as a quiet ambient activity (meeting mode over your material) |
| 3.3 Summon anywhere | ✅ push-to-talk (Ctrl+Shift+T) + no-session quick ask |
| 4.1 Memory subsystem | ✅ review-first; v2.1 added lexical recall, fact supersession (Replace), and authoring |
| 4.2 Interjection policy engine | ✅ (`companion.eval.test.ts` gate) |
| 4.3 Companion | 🧪 Labs — game-buddy vision integration still ⬜ |
| 4.4 Cost governance v2 | ✅ session budgets + live meter; local-STT spike ⬜ (scheduled as a 5.x spike) |
| — Activities: one list, engine derives the mode (v2.1) | ✅ [18-ACTIVITIES.md](./18-ACTIVITIES.md) |
| — Continuity: archives, save prompt, per-activity formats (v2.1) | ✅ [16-CONTINUITY.md](./16-CONTINUITY.md) |
| — One active profile, resolved in main (v2.1) | ✅ [19-ACTIVE-PROFILE.md](./19-ACTIVE-PROFILE.md) |
| — Job-search quarantine made *inert*, tailoring re-homed to the Space (v2.1) | ✅ [20-QUARANTINE.md](./20-QUARANTINE.md) |

Phases 1–2 as originally drawn are complete in substance: the engine is one,
the identity shift is public (README, media, and sample data lead with
meetings, not interviews), and the copilots exist — with the single exception
of the second provider, which is the oldest open promise in this document and
therefore goes first in the next train.

## How we build (the development way)

Carried from v1: docs drive development; one session-log file per day; branch →
PR, never commit to master; no version bump or changelog entry except when
cutting a release; typecheck + build before committing.

Rules of the v2 era, all still in force:

1. **Engine-first.** A mode may only *configure* the conversation engine. If a
   mode needs something the engine can't express, extend the engine — never
   special-case inside a mode. Reviews enforce this.
2. **Parity gate.** At every phase boundary (and any PR touching the pipeline):
   full unit suite green, `npm run build` clean, and the privacy hard test
   (`scripts/privacy-affinity/hardtest.js`) passing. Interview mode is shipped
   product; it never regresses in the name of generality.
3. **Master stays shippable.** Unfinished modes hide behind a Labs flag until
   their acceptance criteria pass — and a flag that hides a surface must also
   stop the behaviour behind it ([20-QUARANTINE.md](./20-QUARANTINE.md) §1,
   learned the hard way).
4. **Migrations are one-way and lossless.** Every schema change lands with a
   Drizzle migration (`npm run db:generate`) tested against a copy of a real
   earlier database.
5. **Mutation-check the tests that guard invariants.** A test that cannot fail
   is worse than no test; several v2.1 commits record tests that passed for
   the wrong reason until a mutant exposed them. New invariant tests state
   which mutant kills them.

## Phase 5 — v2.2 "Trust" (the local-first promise, made good)

The fifth phase of the v2 program, shipping as release **v2.2.0** — the first
phase that is entirely ahead of us (Phases 1–4 are accounted for in the
status table above). Its live position is tracked on [the board](BOARD.md).

v2.1 made continuity and memory the core of the product. The next release
hardens the promises that core rests on. The pitch is *local-first, your data,
grounded answers* — and today that pitch has four soft spots: everything
depends on one cloud vendor; memory can only be seeded one fact at a time; a
local-first store has no backup or portability story; and the two flagship
modes still wear Labs badges with no written way to take them off. Each
milestone below closes one of those gaps. Breadth (new modes, new surfaces)
deliberately waits — see *Later trains*.

- **5.1 Multi-provider v1** *(carried from 2.3 — the seam's payoff).* A second
  provider — **Anthropic first** (strong chat + vision peers; the seam itself
  is vendor-neutral, so Google can follow the same path) — lands on the
  Phase-1 capability interfaces for `chat` and `vision`. Per-capability
  provider/model selection in Settings → Providers; per-provider keys under
  the same isolation rules as the OpenAI key (main-process only, encrypted at
  rest, never sent to the renderer). Realtime STT and speech stay OpenAI-only
  until a peer capability exists; PRD §6.7 degradation rules apply. Embedding-
  provider switching ships **only** with the re-index flow — the
  `embeddingIdentity` guard already refuses mixed vector spaces, so the flow
  is a UX task, not a safety one.
  *Acceptance: a full meeting + interview session runs end-to-end with chat on
  the second provider; capability gaps surface as clear UI states, never bare
  errors; no key ever reaches the renderer.*
- **5.2 Memory learns from documents.** "Learn this" on a document: extraction
  proposes candidates through the **same review queue** as conversation
  extraction — `sourceKind: 'imported'` is already reserved for exactly this
  ([14-MEMORY.md](./14-MEMORY.md) §6). The sensitive filter applies before
  persistence, scope is chosen at import (Space or everywhere), and nothing
  is recalled un-reviewed. Closes the "day one it knows nothing" gap from the
  document side, as authoring closed it from the typing side.
  *Acceptance: pointing at a CV or a brief yields reviewable candidates;
  rejecting the batch stores nothing; approving follows the existing
  supersession rules (an imported fact can Replace a stale one).*
- **5.3 Export & backup.** Memories (with history), conversation archives, and
  the profile export to one portable, documented file; import restores it.
  What is *not* included (transcript audio, API keys) is stated in the export
  itself. A local-first product without a backup story loses the user's data
  more reliably than a cloud product does — this is the price of the
  architecture we chose, so we pay it.
  *Acceptance: export → wipe → import round-trips on a real database;
  recall and grounding behave identically after restore.*
- **5.4 Encryption at rest.** The design deferred since v2.0
  ([07-API-KEY-SECURITY.md](./07-API-KEY-SECURITY.md)): a safeStorage-wrapped
  AES-GCM key encrypting memory and transcript content, with dual-read
  migration so existing rows stay readable and encrypt on next write.
  *Acceptance: a fresh row is unreadable in a raw DB browse; a pre-v2.2
  database opens and migrates losslessly; export (5.3) produces plaintext by
  explicit user action only.*
- **5.5 Labs graduation.** Meeting and Companion have shipped behind
  deterministic gates but there is no written bar for removing the badge.
  Define it (real-world hours logged, the PRD §9-P2/P4 bars re-checked against
  actual sessions, zero known trust-breaking defects) and then either
  graduate each mode or record in this document why not. A Labs badge with no
  exit criteria is not caution, it is a fossil.
- **5.6 Spikes** *(go/no-go decisions, not commitments):*
  - **Entities.** The structural fix for fact-key drift — a *Sarah* to hang
    facts on, so "what do we know about Acme?" stops being a similarity
    search ([14-MEMORY.md](./14-MEMORY.md) §6). Output: a design doc and a
    schema sketch, not code.
  - **Local STT** (whisper.cpp) for the always-on case *(carried from 4.4)*.
  - **Lexical index caching** — only if the spike's profiling says a real
    store gets near the measured 10k-row/141 ms line; the benchmark says this
    is years away for a typical user, so the default is no.

**Train acceptance:** parity gate passes; chat runs on the second provider end
to end; a memory can arrive from a document, be exported, and be restored; the
store is encrypted at rest; Meeting and Companion each have a written verdict.

## Later trains (v2.3+) — sequenced, not yet scheduled

In rough order of expected value to the daily cases (meetings, solo), which is
the ordering rule [00-VISION.md](./00-VISION.md) sets:

- **Speaker diarization** *(promoted from Deferred).* Meetings are the daily
  case and every continuity feature sharpens with speaker identity: archives
  already attribute verbatim quotes from transcript rows and deliberately pass
  unrecognized speaker labels through unflattened, so diarization lands
  without a format change. Gate on a capability spike (quality of local vs
  cloud diarization) before committing.
- **Tutor** *(carried 3.2).* `kind='subject'` Spaces exist and run today as a
  quiet ambient activity; the upgrade is a real teach/quiz/drill dialogue loop
  on the engine's `dialogue` policy, migrating mock/sparring onto the same
  loop and retiring their bespoke paths. Progress lands in Insights.
- **Realtime speech-to-speech** *(carried 3.1).* Upgrade voice from
  sentence-streamed TTS to the Realtime GA speech path: streaming audio out,
  tighter barge-in. Main-process socket, same key-isolation rules as
  `realtime.ts`.
- **Interviewer Assist** *(carried 2.2).* Own-JD pack + candidate résumé;
  reuses `interviewer.ts` and `feedback.ts`, adds the coverage tracker. Same
  overlay, opposite chair. Worth revisiting the priority honestly: interviews
  are one activity now, and this serves the least-daily one.
- **Game buddy vision** *(carried 4.3 remainder).* Companion + the existing
  region-capture Vision path pointed at the game.

## Parallel track — brand & docs

Runs alongside every phase: tagline decision (still open, see
[00-VISION.md](./00-VISION.md) §6), README/media refresh at each release
boundary (`npm run media` now rebuilds the whole set from the real app —
[21-MEDIA.md](./21-MEDIA.md)), docs/*.md kept current with the code,
changelog entry per release train.

## Deferred / later (unscheduled, carried or new)

- Rebindable hotkeys; multi-display region capture (carried from v1 plan)
- Vector store swap to LanceDB / sqlite-vec (carried; the recall benchmark
  says lexical index caching comes first, and neither is near)
- Realtime STT / speech from non-OpenAI providers, and local model support
  (Ollama-style) for chat — once the provider layer is proven on a cloud peer
- A mode/plugin SDK (third-party modes) — only after the engine API stabilizes
- Linux polish; mobile companion app — no current plans

## Definition of done per milestone

- Typecheck + build pass; unit tests green; parity gate at phase boundaries.
- The milestone's primary flow works end-to-end in the running app.
- No API key in renderer, logs, or repo; privacy invariants intact.
- Invariant tests are mutation-checked.
- Docs updated: session log entry + affected `docs/*.md`.
