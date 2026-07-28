# 17 · Spaces and the person

> Status: design of record, 2026-07-28. Vision: [00-VISION.md](./00-VISION.md) ·
> Continuity: [16-CONTINUITY.md](./16-CONTINUITY.md).

Two intake surfaces still assumed the user was a job applicant. Fixing the
answer prompt and the retrieval path ([16 §9](./16-CONTINUITY.md)) stopped
BrainCue *behaving* like an interview copilot; this stops it *asking* like one.

## 1. A Space is not a job

`ContextPackKind` (`job | subject | project | meeting | personal | game |
custom`) existed in the types from the v2 schema work and meant nothing in the
product: `jobs:save` never accepted it, every row was created as `'job'`, and
the form asked for an *Interview name*, a *Client / company*, and a *Job
description*. Setting up a Space for a Tuesday standup meant filling in a job
description.

**The fix is a relabel, not new columns.** The underlying shape — a name, a
counterparty, one defining document, a link worth reading, free notes — was
always general; only the words were job-specific:

| Column (physical name is v1 legacy) | What it really is |
| --- | --- |
| `title` | what this Space is called |
| `company` | who it involves |
| `jd_text` | the document that defines it |
| `company_url` | a page worth reading for background |
| `notes` | anything else, shown in the Cue Card during the session |

So each kind supplies its own vocabulary (`shared/spaceKinds.ts`) over the same
storage. Every Space stays in one table, one retrieval path, and no migration.
A kind whose config is missing falls back to `custom` rather than throwing, so
v1 rows and hand-edited databases keep working.

### What stays interview-only

Two pieces of machinery are **gated**, not generalized, because they only mean
something for a job:

- **Structured JD parsing** extracts requirements, responsibilities, and
  seniority. Run over a standup agenda it invents all three. Non-job Spaces
  index their document as plain text instead — still grounded, still cited, just
  not pretending to have found a job spec.
- **The prep brief** predicts interview questions and coverage gaps against a
  JD. It is hidden for other kinds, and the handler refuses.

New Spaces default to `meeting` — the daily case. **The kind is fixed after
creation**: the Space's documents are already indexed under it, and quietly
re-interpreting an indexed corpus is worse than asking the user to make a new
Space.

## 2. A profile is not a résumé

Onboarding asked for a target role, a target company, an interview type, and a
résumé — everything a job applicant needs and almost nothing a companion in
someone's daily calls does. A résumé is a record of what someone did *for
employers*. Standing in for a person requires what they are doing *now*.

`profiles.about` (migration 0013, additive JSON) holds what actually changes how
well BrainCue can help:

| Section | Why it earns its place |
| --- | --- |
| What you do / where | the baseline every answer is framed against |
| Where you are based | so "tomorrow morning" and "end of day" mean something |
| What you are working on | the single biggest predictor of what a call is about |
| Who you work with | names that [entity recall](./14-MEMORY.md) can attach to |
| How you work | *"never commit to dates in a call"* changes what it says, not just how |
| Anything else | the things a stand-in would need and would not guess |

**Every section is optional.** A half-filled profile grounds far better than a
blank one, so the UI asks rather than demands and shows how much is answered.

Each answered section is indexed as its own `profile` chunk, led by the person's
name and a phrase naming the section, so a retrieved fragment reads as a
statement about them rather than an orphaned sentence. Clearing a section
removes it from the index on the next save — this is the user's description of
themselves, and it must be as easy to retract as to give.

### The data-loss bug this uncovered

`reindexProfile` clears every unscoped chunk before writing fresh ones. That set
had already grown once (STAR stories are managed separately), and conversation
archives are unscoped whenever the session had no Space — so **editing your name
would have silently erased every archive of every call you had ever had.** No
error, no symptom, until answers quietly stopped citing last week. Archives are
now excluded explicitly, and the exclusion has a test that fails when it is
removed.

## 3. Not in this milestone

- **The job-applicant columns themselves.** `targetRole`, `targetCompany`,
  `interviewType`, `jdText`, and `parsedJd` still sit on `profiles`. They are
  live for interview mode and dropping them needs a migration against real
  databases plus a decision about what replaces `targetRole` in the answer
  prompt. `about` is additive precisely so this could ship without that.
- **Seeding entities from "who you work with".** The names are indexed as text
  today; linking them to [14 §3.2](./14-MEMORY.md) entities at save time is the
  obvious next step once that work merges.
- **Per-kind retrieval weighting.** Every kind indexes into the same chunk
  types, so a meeting agenda and a job description currently rank alike.
