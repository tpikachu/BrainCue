# The board

The shared board for the release currently being built. The
[Roadmap](10-ROADMAP.md) says what the train contains and why; the
[changelog](../changelog/) says what shipped after the fact; **this file says
where the train is right now** — which milestones are in flight, which PR
carries each one, and what was decided along the way. Deliberately unnumbered,
because unlike the numbered design docs it changes with every PR and resets
every release.

**Rules of the board:**

- A PR that starts, finishes, or drops a milestone updates that row **in the
  same PR** — the board must never describe a state the tree has left.
- Only decisions that changed the plan go in the decision log, with a date and
  a one-line reason. Design rationale lives in the design docs.
- Work arrives here through the flow in
  [CONTRIBUTING.md](../CONTRIBUTING.md): issue → triage → accepted →
  milestone + a row below.

Statuses: ⬜ not started · 🔨 in progress · 🔍 in review · ✅ merged ·
🚫 dropped (reason in Notes).

## The release ritual

When a train ships, in this order — each step feeds the next:

1. **Record it.** Write `changelog/<version>.md` and bump `package.json` — the
   one PR allowed to do either.
2. **Enhance the Roadmap.** Update its status table, re-triage *Later trains*
   and *Deferred* — this is the moment the big picture gets its periodic
   revision, with the just-shipped train as evidence.
3. **Reset this board.** New train header and milestones drawn from the
   Roadmap; surviving decision-log entries move into the design docs they
   affected; the old table is deleted (the changelog now holds that record).
4. **Roll the GitHub milestone.** Close the shipped version's milestone,
   create the next one, re-target any issues that carried over.

---

## v2.2.0 "Trust" — from v2.1.0, started 2026-07-29

Scope of record: [Roadmap · Phase 5](10-ROADMAP.md#phase-5--v22-trust-the-local-first-promise-made-good).
Theme in one line: harden the four promises the product now rests on —
provider choice, memory you can seed, data you can take with you, and modes
that either earn their way out of Labs or say why not.

**Now in flight:** 5.1 (multi-provider), 5.7 (local STT), 5.8 (Settings + onboarding), 5.9 (meetings answer questions) and 5.10 (hear both sides) — all on `feature/v2.2-trust-local-stt-onboarding`, one PR.

| # | Milestone | Status | Branch / PR | Notes |
| --- | --- | --- | --- | --- |
| 5.1 | Multi-provider v1 — Anthropic on the chat + vision seam | 🔨 | `feature/v2.2-trust-local-stt-onboarding` | Anthropic native + Google/Groq/OpenRouter via OpenAI-compatible; per-task routing + per-provider keys in main (see [06](06-OPENAI-SERVICE.md)); Settings UI + Cue Card picker land with the renderer work |
| 5.2 | Memory learns from documents (`sourceKind: 'imported'`) | ⬜ | — | Same review queue; sensitive filter before persistence |
| 5.3 | Export & backup — one portable file, round-trips | ⬜ | — | Before 5.4, so encryption has an explicit-plaintext path to point at |
| 5.4 | Encryption at rest — safeStorage-wrapped AES-GCM, dual-read | ⬜ | — | Design: [07-API-KEY-SECURITY](07-API-KEY-SECURITY.md) |
| 5.5 | Labs graduation — written criteria, then a verdict per mode | ⬜ | — | Last: wants real-world hours accumulated during the train |
| 5.6a | Spike: entities design (doc + schema sketch, no code) | ⬜ | — | Go/no-go only |
| 5.6b | Spike: local STT (whisper.cpp) for always-on | ✅ | — | Verdict: **go**, but not whisper.cpp — cache-aware streaming (Nemotron on sherpa-onnx) is the right architecture for live cues. Became 5.7. |
| 5.6c | Spike: lexical index caching | ⬜ | — | Default is **no** per the recall benchmark; only if profiling disagrees |
| 5.7 | Local STT engine — Nemotron on sherpa-onnx, model download + Speech-to-Text settings | 🔨 | `feature/v2.2-trust-local-stt-onboarding` | Added 2026-09-06 (user report: transcription slow, wants on-device). Engine + downloader + utility-process worker shipped ([22](22-LOCAL-STT.md)); not yet exercised against a downloaded model on a real call |
| 5.8 | Settings sections + first-run onboarding (name → transcription → AI) + download strip | 🔨 | `feature/v2.2-trust-local-stt-onboarding` | Added 2026-09-06 (user report: tour launched under the name dialog). Settings IA in [11](11-UX-NAVIGATION.md) |
| 5.9 | Meetings answer questions asked in the room (Balanced default) | 🔨 | `feature/v2.2-trust-local-stt-onboarding` | Added 2026-09-06 (user report: "question detection not working"). The held-question tracker is gone; quiet = card, balanced/active = grounded answer ([01-PRD §7.3](01-PRD.md)). Verified live 2026-09-07 on both STT engines (real key, TTS audio): question → answer with no classifier delay |
| 5.10 | Hear both sides: system audio + microphone, questions only from the call; "Listen to" choice removed | 🔨 | `feature/v2.2-trust-local-stt-onboarding` | Added 2026-09-07 (user: "asking the user to pick a source doesn't make sense"). One transcriber per stream, own turns tagged `you`/`candidate` and kept in history but never trigger; echo guard drops the mic's copy of the call on laptop speakers (verified live 2026-09-07) ([06](06-OPENAI-SERVICE.md), [22](22-LOCAL-STT.md)) |

## Decision log

| Date | Decision |
| --- | --- |
| 2026-07-29 | Train themed "Trust" (hardening over breadth); Anthropic chosen as the first second-provider — the seam is vendor-neutral, Google can follow the same path. |
| 2026-07-29 | PR order set: 5.1 → 5.2 → 5.3 → 5.4 → 5.5, spikes interleave; 5.3 lands before 5.4 so the export path exists before encryption claims "plaintext only by explicit action". |
| 2026-09-06 | OpenAI-compatible transport used for Google/Groq/OpenRouter so one adapter covers three vendors; Anthropic gets a native adapter (Messages API differs). |
| 2026-09-06 | Three user reports pulled into the train as 5.7–5.9 (local STT, Settings + onboarding, meeting questions) ahead of 5.2–5.5; they share one branch because the Settings IA, the STT engine and the provider keys all land on the same screens. |
| 2026-09-07 | Meetings default to **Balanced** presence and answer spoken questions; the two-turn "hold" was removed because in real meetings almost any next turn shared a word with the question and nothing ever surfaced. |
| 2026-09-07 | Local STT models are the sherpa-onnx INT8 exports fetched per file from Hugging Face (resumable, size-verified), not the GitHub `.tar.bz2` bundles — no archive extraction in the app. |
