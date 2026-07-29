# The current train

The live board for the release currently being built. The
[Roadmap](10-ROADMAP.md) says what the train contains and why; the
[changelog](../changelog/) says what shipped after the fact; **this file says
where the train is right now** — deliberately unnumbered, because unlike the
numbered design docs it changes with every PR and resets every release.

**Rules of the board:**

- A PR that starts, finishes, or drops a milestone updates that row **in the
  same PR** — the board must never describe a state the tree has left.
- Only decisions that changed the plan go in the decision log, with a date and
  a one-line reason. Design rationale lives in the design docs.
- When the train ships: statuses collapse into `changelog/<version>.md` and
  the roadmap's status table, the decision log's survivors move into the docs
  they affected, and this file resets for the next train.

Statuses: ⬜ not started · 🔨 in progress · 🔍 in review · ✅ merged ·
🚫 dropped (reason in Notes).

---

## v2.2.0 "Trust" — from v2.1.0, started 2026-07-29

Scope of record: [Roadmap · Phase 5](10-ROADMAP.md#phase-5--v22-trust-the-local-first-promise-made-good).
Theme in one line: harden the four promises the product now rests on —
provider choice, memory you can seed, data you can take with you, and modes
that either earn their way out of Labs or say why not.

**Now in flight:** nothing — next up is 5.1 (multi-provider).

| # | Milestone | Status | Branch / PR | Notes |
| --- | --- | --- | --- | --- |
| 5.1 | Multi-provider v1 — Anthropic on the chat + vision seam | ⬜ | — | First: biggest, and nothing else depends on it |
| 5.2 | Memory learns from documents (`sourceKind: 'imported'`) | ⬜ | — | Same review queue; sensitive filter before persistence |
| 5.3 | Export & backup — one portable file, round-trips | ⬜ | — | Before 5.4, so encryption has an explicit-plaintext path to point at |
| 5.4 | Encryption at rest — safeStorage-wrapped AES-GCM, dual-read | ⬜ | — | Design: [07-API-KEY-SECURITY](07-API-KEY-SECURITY.md) |
| 5.5 | Labs graduation — written criteria, then a verdict per mode | ⬜ | — | Last: wants real-world hours accumulated during the train |
| 5.6a | Spike: entities design (doc + schema sketch, no code) | ⬜ | — | Go/no-go only |
| 5.6b | Spike: local STT (whisper.cpp) for always-on | ⬜ | — | Go/no-go only |
| 5.6c | Spike: lexical index caching | ⬜ | — | Default is **no** per the recall benchmark; only if profiling disagrees |

## Decision log

| Date | Decision |
| --- | --- |
| 2026-07-29 | Train themed "Trust" (hardening over breadth); Anthropic chosen as the first second-provider — the seam is vendor-neutral, Google can follow the same path. |
| 2026-07-29 | PR order set: 5.1 → 5.2 → 5.3 → 5.4 → 5.5, spikes interleave; 5.3 lands before 5.4 so the export path exists before encryption claims "plaintext only by explicit action". |
