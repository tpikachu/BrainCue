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

## v2.2.2 — polish from real calls, started 2026-10-07

Scope of record: none in the Roadmap — this is a patch train. v2.2.0 and
v2.2.1 shipped on 2026-09-07 and 2026-10-06 (PRs #72, #73; see the
[changelog](../changelog/)); their rows left this board per the release
ritual, and the Roadmap status table now carries 5.1 and 5.7–5.10 as ✅.
Theme in one line: what got in the way during a week of real interviews and
meetings on 2.2 — nothing new to learn, everything already there made to work.

**Now in flight:** 5.11–5.13, all on `feature/v2.2.2-cue-card-and-transcript`,
one PR. 5.14 is a candidate, not yet pulled.

| # | Milestone | Status | Branch / PR | Notes |
| --- | --- | --- | --- | --- |
| 5.11 | Own speech shows as it is spoken — interim text from both streams, one in-flight line per speaker | 🔨 | `feature/v2.2.2-cue-card-and-transcript` | Added 2026-10-07 (user: "live transcription is not working at all"). Root cause was the mic stream publishing no interim, then the echo guard's 1.5 s hold ([22](22-LOCAL-STT.md), [06](06-OPENAI-SERVICE.md)) |
| 5.12 | One answer style — **General \| Technical** chip replaces five formats and the interview-type dropdown | 🔨 | `feature/v2.2.2-cue-card-and-transcript` | Added 2026-10-07 (user: "too complex… the key point is performance"). Behavioral shape is applied from the classifier, not a control; legacy values map on read ([06](06-OPENAI-SERVICE.md), [11](11-UX-NAVIGATION.md)) |
| 5.13 | Follow-ups stay on the last answer's subject; save dialog drops "What kind of interview was this?" | 🔨 | `feature/v2.2.2-cue-card-and-transcript` | Added 2026-10-07 (user: "what was your role there?" got an unrelated answer). History header rewritten + the previous answer's lead joins a short follow-up's retrieval query. **Verified live 2026-10-07** against a two-project resume: no drift across two follow-ups |
| 5.14 | Start without an OpenAI key when another chat provider is configured | ⬜ | — | Candidate. Only embeddings and resume parsing are OpenAI-only; the start gate is stricter than that. Needs a graceful no-embedder retrieval path |
| 5.2–5.5 | Documents → memory · Export & backup · Encryption at rest · Labs graduation | ⬜ | — | Carried from the v2.2.0 scope, unscheduled; see the Roadmap |

## Decision log

| Date | Decision |
| --- | --- |
| 2026-10-07 | v2.2.2 is a patch train cut from user reports, not from the Roadmap; 5.2–5.5 stay unscheduled until the app has had real-world hours on 2.2. |
| 2026-10-07 | Answer styles collapse to **General \| Technical**: the question type is something the classifier knows, not something a user should set mid-interview. Performance and a clean Cue Card over configurability. |
| 2026-10-07 | Post-release work never continues on a merged release branch; every train starts its own branch from master. |
