# 20 · What is switched off, and what it would take to switch back

`src/shared/flags.ts` gates surfaces that are designed, built, or shipped but
not currently offered. This records the two that hide *working* code, because a
flag with no written reason becomes a mystery within a release — and because an
audit of `jobSearch` found that "quarantined" had come to mean *invisible*
rather than *inert*.

## 1. The rule a flag must obey

**A flag that hides a surface must also stop the behaviour behind it.** If it
does not, the app keeps acting on data the user can no longer see, edit, or
delete — and no bug report will ever describe it accurately, because from the
outside nothing looks wrong.

`FLAGS` is read only in the renderer and in `voiceService`. **Nothing in
`src/main` reads `FLAGS.jobSearch`**, so it can never gate retrieval. Anything
that must actually stop has to be gated on its own terms, in main. That is why
the two rules below are expressed as retrieval conditions rather than as flag
checks.

## 2. `jobSearch` — the Tailor Resume *page* + the applications table

Off. The standalone page and the applications table belong to the
interview-copilot product; leading with them misrepresents what BrainCue now
is. Tables, IPC, repositories, and pages are intact and users' rows are
untouched.

**Tailoring itself came back, in the right place.** An interview Space now
carries its own `tailored_resume` (migration 0016), produced from that Space's
JD via `jobs:tailor-resume` and offered in the Space editor under the JD it
tailors against. That is the shape the old design could not express: an
application owned a *hidden* pack, so a tailored résumé could never attach to a
Space the user actually had, and the only entry point navigated to `/tailor`
carrying no Space at all. What stays off is the page, the applications table,
and the separate résumé×JD workflow around them.

**Known problems if it is flipped back**, all found by audit rather than by
use, because nothing renders these surfaces and no test covers the flag:

| Problem | Where |
| --- | --- |
| The only entry point passes no Space. `navigate('/tailor')` carries no id, so the page opens empty | `SpacesTab.tsx` |
| Tailoring *for* an existing Space is not implemented at any layer — `applications.tailor` takes no `packId` and always mints a new hidden pack | `applications.ipc.ts` |
| The page carries its own profile `<Select>`, which the one-profile-at-a-time rule forbids | `TailorPage.tsx` |
| `applicationsRepo.page()` returns applications across **all** profiles | `applications.repo.ts` |
| The save prompt cannot see an application-owned Space (`notApplicationOwned`), so a session started from Tailor lands on a blank Space picker and can silently keep nothing | `SavePromptModal.tsx` |
| The start call passes no `activity`, so the row gets `activity=null` and falls back to `interview` | `TailorPage.tsx` |
| No test asserts either the off-state or the restored surface | — |

## 3. `storyBank` — the STAR story bank as a managed surface

Off, and deliberately not simply re-enabled.

Bundled with `jobSearch`, it produced the one state that cannot be defended:
retrieval force-included a strongly matching story in **every** interview, while
the surface to see, edit, or delete those stories was hidden. Users were
grounded on material they had no way to reach.

**What replaced it:** STAR survives as an **answer format**
(`AnswerFormat = 'star'`), selectable live in the Cue Card. That is the part
that was actually valuable in a behavioural interview — the scaffold the panel
is scoring against, *Situation · Task · Action · Result* — without a bank of
pre-generated stories to curate. It is distinct from `story_teller`, which
optimises for how a story lands rather than for what an interviewer marks.

## 4. The two retrieval rules that make the above true

Both are enforced in main, on the mode, and both are **fail-closed** — a caller
that says nothing gets the restrictive behaviour.

**A STAR story chunk is force-included only for interview-family modes.**
`ground()` derives this from the session's mode (`STORY_CUE_MODES`).

**A tailored résumé substitutes for the base résumé only for interview-family
modes.** It previously ran in *every* mode with no gate, so one leftover
application silently suppressed the user's real résumé in unrelated meetings —
the model was told their experience was the version rewritten for a job they
applied to once. Proven live during the audit, then pinned by tests in
`sessionArchive.test.ts`.

`ground()` takes **no default mode**. It used to default to `'interview'` — the
one value that turns both of the above ON — so a caller who forgot the argument
opted silently *into* interview-only retrieval. `voiceService` did exactly that,
and every voice quick ask force-injected a résumé anecdote into a generic
answer. A missing argument must never be the permissive case.

## 5. What users were told

Nothing, at the time. The in-app **What's New** view renders every
`changelog/*.md`, so releases 1.1.0, 1.3.0, and 1.4.0 still described Tailor
Resume, the applications table, and the story bank in the present tense — one of
them naming the exact page to go to — long after all three were unreachable.
The retraction is in `changelog/2.1.0.md`. **A feature withdrawn without a
changelog entry reads as a bug to the person who used it.**
