# Roadmap — BrainCue v2 and beyond

> Supersedes [09-MVP-PLAN.md](./09-MVP-PLAN.md) (kept as the record of the
> shipped v1 build). Vision: [00-VISION.md](./00-VISION.md) · Spec:
> [01-PRD.md](./01-PRD.md). Phases ship as release trains (v2.0, v2.1, …);
> milestones within a phase are independently landable PRs.

## How we build (the development way)

Carried from v1: docs drive development; one session-log file per day; branch →
PR, never commit to master; no version bump or changelog entry except when
cutting a release; typecheck + build before committing.

New rules for the v2 era:

1. **Engine-first.** A mode may only *configure* the conversation engine. If a
   mode needs something the engine can't express, extend the engine — never
   special-case inside a mode. Reviews enforce this.
2. **Parity gate.** At every phase boundary (and any PR touching the pipeline):
   full unit suite green, `npm run build` clean, and the privacy hard test
   (`scripts/privacy-affinity/hardtest.js`) passing. Interview mode is the
   shipped product; it never regresses in the name of generality.
3. **Master stays shippable.** Unfinished modes hide behind a Labs flag in
   Settings until their acceptance criteria pass.
4. **Migrations are one-way and lossless.** Every schema change lands with a
   Drizzle migration (`npm run db:generate`) tested against a copy of a real
   v1.5.x database.

## Phase 1 — v2.0 "One engine" (foundation + rebrand)

The unglamorous phase: after it, the app looks almost identical — and every
later phase becomes configuration instead of surgery.

- **1.1 Vocabulary & schema generalization.** `jobs` → context packs
  (`kind: job|subject|project|custom`; existing rows become `kind='job'`);
  `sessions.mode` (live→`interview`, mock/sparring→`practice`); `InterviewType`
  demoted to interview/practice scenario config in `@shared/types`. Rename map
  documented in [04-DATABASE.md](./04-DATABASE.md) when it lands.
- **1.2 Engine extraction.** Pull the pipeline out of
  `sessionManager.ts` into `services/engine/` with a `ModeDefinition`
  interface: `{ sources, triggerPolicy, persona, groundingScope, surfaces }`.
  The interview mode becomes the first `ModeDefinition`; the question
  classifier becomes the `reactive` trigger policy implementation.
  Mock/sparring stay on their current path (they migrate in 3.2).
  **Includes the provider seam** (PRD §6.7): the engine calls `Provider`
  capability interfaces (`chat`/`embeddings`/`stt`/`speech`/`vision`), with
  today's OpenAI services refactored into the reference implementation — no
  second provider yet, just the cut.
- **1.3 Renderer generalization — the mode-first layout.** Implement the
  navigation redesign in [11-UX-NAVIGATION.md](./11-UX-NAVIGATION.md): sidebar
  collapses to Home / Library / Reports / Settings, modes become launcher cards
  on Home, Profiles+Jobs merge into Library, old routes redirect, tour updated.
  `useLiveSession` and the overlay stay as-is for interview parity; card
  components take a card *type* so Phase 2 can add new ones without churn.
- **1.4 Rebrand pass.** In-app copy, onboarding tour script, Settings
  descriptor: "interview copilot" → "ambient AI companion". No appId/installer
  identity change (README repositioned 2026-07-21). Update
  [02-ARCHITECTURE.md](./02-ARCHITECTURE.md), [05-IPC-MAP.md](./05-IPC-MAP.md)
  as they drift.

**Acceptance:** parity gate passes; a v1.5.x database migrates losslessly and
every v1 flow works unchanged; a fresh install onboards through the retitled
tour.

## Phase 2 — v2.1 "Copilots" (nearest adjacencies, both sides of the table)

- **2.1 Meeting Copilot.** First `proactive` trigger policy: salience
  classification of finalized turns (unanswered question, action item, claim
  the corpus can inform). New card types: context, open-question, action-item.
  Sensitivity dial (summoned-only ↔ eager) + cooldowns. End-of-session meeting
  summary report. *Acceptance: PRD §9-P2 — a real meeting yields ≥1 useful
  contribution and zero annoying ones at defaults.*
- **2.2 Interviewer Assist.** Inputs: own JD pack + candidate resume doc.
  Reuses `interviewer.ts` (suggested/follow-up questions) and `feedback.ts`
  (evaluation draft); adds the coverage tracker. Same overlay, opposite chair.
  *Acceptance: a full interview run yields a usable evaluation draft.*
- **2.3 Multi-provider v1.** A second provider (Anthropic or Google) lands on
  the Phase-1 seam for `chat` + `vision`, with per-capability provider/model
  selection in Settings → Providers and per-provider keys. Realtime STT and
  speech stay OpenAI-only until a peer capability exists (PRD §6.7 degradation
  rules apply). Embedding-provider switching ships only with the re-index flow.
  *Acceptance: a full interview + meeting session runs end-to-end with chat on
  the second provider; capability gaps surface clearly instead of erroring.*

Phase 2 also completes the identity shift in public: README, screenshots, and
store copy present the mode catalog, not an interview tool.

## Phase 3 — v2.2 "Voice" (dialogue becomes natural)

- **3.1 Realtime speech-to-speech.** Upgrade voice output from turn-based MP3
  TTS to the Realtime GA speech path: streaming audio out, barge-in (user
  speech interrupts playback), output-device picker. Main-process socket, same
  key-isolation rules as `realtime.ts`.
- **3.2 Tutor mode.** Context packs of `kind='subject'`; teach/quiz/drill loop
  generalized from `sparringManager.ts` onto the engine's `dialogue` policy —
  mock/sparring migrate onto the same loop here, retiring their bespoke paths.
  Progress lands in Reports.
- **3.3 Summon anywhere.** Global push-to-talk: hold a hotkey, speak to
  BrainCue from any mode (or no session), grounded answer via overlay or voice.

**Acceptance:** PRD §9-P3 — tutoring feels conversational (no dead air > 2s);
sparring/mock users see no feature loss after migrating onto the engine loop.

## Phase 4 — v3.0 "Memory & presence" (the companion)

Deliberately last: it depends on voice (P3), memory, and interjection tuning.

- **4.1 Memory subsystem.** Post-session extraction of durable facts into a
  local memory store; a review UI (view / edit / delete — PRD principle:
  memory belongs to the user); memory chunks join retrieval.
- **4.2 Interjection policy engine.** The presence dial (silent observer ↔
  chatty), cooldowns, and do-not-disturb heuristics. The hardest product
  problem in the plan; ship behind Labs until §9-P4 holds.
- **4.3 Companion + game buddy.** Ambient session type; game buddy = companion
  + the existing region-capture Vision path pointed at the game.
- **4.4 Cost governance v2.** Session budgets with warnings; evaluate local
  STT (whisper.cpp) for the always-on case — a spike with a go/no-go, not a
  commitment.

**Acceptance:** PRD §9-P4 — unprompted correct recall across sessions; "knows
when to shut up" in real use.

## Parallel track — brand & docs

Runs alongside every phase: tagline decision (open, see
[00-VISION.md](./00-VISION.md) §6), README/media refresh at each phase
boundary, docs/*.md kept current with the code (per the existing convention),
changelog entry per release train.

## Deferred / later (unscheduled, carried or new)

- Rebindable hotkeys; multi-display region capture (carried from v1 plan)
- Vector store swap to LanceDB / sqlite-vec (carried)
- Realtime STT / speech from non-OpenAI providers, and local model support
  (Ollama-style) for chat — once the provider layer is proven on cloud peers
- Speaker diarization for multi-participant meetings
- A mode/plugin SDK (third-party modes) — only after the engine API stabilizes
- Linux polish; mobile companion app — no current plans

## Definition of done per milestone

- Typecheck + build pass; unit tests green; parity gate at phase boundaries.
- The milestone's primary flow works end-to-end in the running app.
- No API key in renderer, logs, or repo; privacy invariants intact.
- Docs updated: session log entry + affected `docs/*.md`.
