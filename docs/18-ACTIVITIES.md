# 18 · Activities — one question, not two

> Status: design of record, 2026-07-28. Vision: [00-VISION.md](./00-VISION.md) ·
> Spaces & profile: [17-SPACES-AND-PROFILE.md](./17-SPACES-AND-PROFILE.md) ·
> Engine: [12-ENGINE-PLAN.md](./12-ENGINE-PLAN.md).

## 1. The conflict

Starting a session asked the user two questions that were the same question.

**Mode** — *Interview Copilot / Practice / Interviewer Assist / Meeting Copilot
/ Tutor / Companion*. This list is a catalog of product features, written when
the app **was** Interview Copilot and everything else was roadmap. It shows:
one entry that never started a session (*Practice* navigated away to a drill
page) and two that did not exist (*Tutor*, *Interviewer Assist*, rendered
disabled with "Coming soon").

**Space kind** — *job / meeting / project / subject / personal / game / custom*.
Added in [17](./17-SPACES-AND-PROFILE.md) to answer what a conversation is about.

They collided item for item — `meeting` was in **both**, `job`↔`interview`,
`subject`↔`tutor` — and their defaults contradicted each other: the start modal
opened on **Interview** while a new Space defaulted to **Meeting**. Nothing
reconciled them, so a Meeting Space could be started in Interview mode and be
told, by the answer prompt, that the user was a candidate being assessed.

## 2. Why "mode" was never a real choice

A `ModeDefinition` is configuration over one engine, and reading all three shows
what it actually configures:

| Mode | Listens to | Speaks when | Frames the user as |
| --- | --- | --- | --- |
| interview | them (system audio) | a question is detected | a candidate being assessed |
| meeting | them (system audio) | the ambient policy fires | themselves, in a conversation |
| companion | **you** (microphone) | the interjection policy fires | themselves, with a persona |

Every column is a dial the start flow **already showed separately** — *Listen
to*, *Presence*, and the answer framing from
[16 §9](./16-CONTINUITY.md). So the mode picker asked the user to choose a
bundle they could also see unbundled. That is precisely why it read as a
conflict.

## 3. The resolution

**One list, and it is the activity list.** The user answers *"What's this
call?"* — and nothing else about what BrainCue will be. The engine mode is
derived (`shared/activities.ts`), so what was shown and what runs cannot drift.

| Activity | Runs | Listens to | Needs a résumé |
| --- | --- | --- | --- |
| Meeting or call | meeting | system | no |
| Project discussion | meeting | system | no |
| Interview | **interview** | system | **yes** |
| Study or tutoring | meeting | system | no |
| Personal | meeting | system | no |
| Game | companion | **mic** | no |
| Just me | companion | **mic** | no |
| Something else | meeting | system | no |

`ModeDefinition` stays exactly as it was — it is the right internal
architecture. It simply stops being a question.

Four consequences worth naming:

- **A Space IS a saved activity.** Picking one answers the question for you.
  Not a lock, and deliberately so: a Space set up for a job is the right
  grounding for the recruiter *call* about that job, and that call is a
  meeting, not an interview.
- **Starting with no Space is first-class.** Most calls happen once. Requiring
  a Space first was the friction that made this feel like a job tool.
- **Unbuilt modes are not listed as activities.** In the one list you must
  answer to start, a "Coming soon" tile is an obstacle, not honesty — and a
  gated activity is *dropped*, never downgraded into a different mode, because
  starting a standup as an interview is worse than not starting it. The roadmap
  lives on Home, where reading it costs nothing.
- **Practice moved to where it belongs.** It never started a session; it
  navigated to a drill page. It is now a link under the Interview activity —
  preparation *for* an interview, not a kind of call.

### What the user still chooses

**Presence** (and, for companion activities, posture + budget). That genuinely
varies *within* an activity — the same standup can want silence one week and
help the next — so it stays a question. Everything else the mode used to bundle
is now printed on the choice (`ActivityConfig.does`) as a consequence rather
than asked as a second one.

## 4. The résumé gate

`startBlocker` refused to start **anything** without a parsed résumé. You could
not sit in on your own standup without first uploading a CV — the loudest
remaining way the app insisted it was an interview tool.

The gate is now per-activity, and exactly one activity sets it: Interview
answers *as the candidate*, from their history, so it genuinely cannot work
without one. A meeting needs nothing but a profile to attach to.

## 5. `sessions.activity`

Migration 0014, additive, nullable.

The mode alone cannot stand in for it. Several activities share one mode — a
project call and a standup both run `meeting` — so storing only the derived mode
erases what the user actually said. And a session started **without a Space**
has no kind recorded anywhere else at all.

Null means "we don't know": v1 rows, and rehearsals, which have no activity.
Surfaces fall back to the mode-shaped label rather than guessing.

`fkRebuild.ts`'s `SESSIONS_DDL` had to learn the column too — the rot guard in
`fkRebuild.test.ts` caught the omission on the first run, which is what it was
written for after `sessions.mode` was silently dropped by the same mechanism.

## 6. What this does NOT change

- **The engine.** One pipeline, modes as configuration; `predictFollowup`, the
  meeting report strategy, and companion's cost meter are untouched.
- **Interview mode.** Still fully shipped, still the only assessed framing,
  still the only path with story cues and follow-up prediction.
- **Storage for Spaces.** Same table, same columns, same retrieval path
  ([17 §1](./17-SPACES-AND-PROFILE.md)).

## 7. Not in this milestone

- **Per-activity retrieval weighting.** Every activity indexes into the same
  chunk types, so a meeting agenda and a job description still rank alike.
- **Tutor.** `subject` runs `meeting` today. When tutor ships, one line in
  `ACTIVITIES` moves it over and the flag gate lets it appear.
- **The job-applicant profile columns.** Still on `profiles`, still deferred for
  the reasons in [17 §3](./17-SPACES-AND-PROFILE.md).
