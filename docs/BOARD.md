# The board

**Stable 2.3.0 follow-up (2026-11-19):** the user requested two changes before
promoting 2.3.0 to latest: per-role résumé selection and fast normal interview
responses, with a separate allowance for coding. This supersedes the preview
scope freeze for these requirements. The existing preview stays published.

| Checkpoint | Required behavior | State |
| --- | --- | --- |
| S1 — Role résumé | Create/edit offers Default résumé or upload/paste a different résumé. Only this role uses it; saving/replacing/removing it updates grounding, including cached lookups. Setup, prep and Resume use the selected role's context. Existing roles inherit their current behavior. | Implemented and verified offline: nullable Space field/migration, isolated indexing/cache validation, actual save/brief/tailor handlers including failures, real-engine prompt/Resume test, and four renderer cases. |
| S2 — Interview speed | Normal General/short Technical cues use low-latency defaults and a short bounded context wait; coding keeps deeper models and a longer allowance. Preserve résumé/JD/session grounding, candidate speech, ordering, consent, explicit overrides and same-provider retry. | Implemented and verified offline: 350 ms context wait with local ranking fallback; 2.5 s coding allowance. Fast policy defaults, explicit overrides and same-provider retries tested. Live provider/paint latency remains unmeasured. |
| S3 — Stable release | Independently review S1/S2, run full offline checks and measured live General/Technical acceptance. Publish 2.3.0 as latest only after the two changes are validated. | Pending. The user authorized this conditional stable release; no version/tag/latest change yet. Paid live benchmark and user audio are not started implicitly. |

Current owner: Codex is implementing and verifying these changes locally.
No other engineer checkpoint is assumed running from passive handoff files.
Formal PERF-01/M7 acceptance and existing open issues remain recorded below;
simulated timing is not live performance evidence.

Candidate checks: **1,387 unit passes / 3 skips**, **115 offline E2E passes /
13 intentional no-key registration skips**, production build/typecheck pass,
`git diff --check` clean. A baseline checkout at `a058aec` with only the new
regression tests gives **12 failures and 2 passing controls**; the same
selection gives **14 passes** on the candidate. The isolated checkout was
removed; logs remain gitignored under `bench-results/stable23-*`.

The next required step is the explicit opt-in measured run in
`docs/benchmarks/PERF01-LIVE-PLAN.md`: synthetic data, pinned OpenAI route,
72 questions, at most 673,000 reserved tokens / 678 requests / 900 seconds
synthetic STT. This has not been run or authorized; no user microphone or
capture is implied by the stable-release request. Stable promotion remains
conditional on measured results, not these offline timings.

**Current preview status (2026-11-19):**
[2.3.0-preview.1](https://github.com/tpikachu/BrainCue/releases/tag/v2.3.0-preview.1)
is published as a **Windows prerelease**, authorized by the user. The tag
points to `78f7530` (release documentation/workflow only beyond `1c75cd1`);
the installer remains the reviewed `1c75cd1` build. Four assets are uploaded,
with server-side SHA-256 digests matching the local files. v2.2.2 remains
stable; no `latest.yml` or macOS/Linux preview asset was published. The short
user-run interview is still pending, not a claimed pass. Scope is frozen.
Formal PERF-01 and the broader
M7.2c/M7.3 evidence remain open; the preview does not claim those gates met.

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

**Now in flight:** the interview-first cycle (6.1–6.4) and 5.14, all on
`feature/interview-copilot-first`, one PR. 5.11–5.13 merged in #74.

| # | Milestone | Status | Branch / PR | Notes |
| --- | --- | --- | --- | --- |
| 5.11 | Own speech shows as it is spoken — interim text from both streams, one in-flight line per speaker | ✅ | #74 | Added 2026-10-07 (user: "live transcription is not working at all"). Root cause was the mic stream publishing no interim, then the echo guard's 1.5 s hold ([22](22-LOCAL-STT.md), [06](06-OPENAI-SERVICE.md)) |
| 5.12 | One answer style — **General \| Technical** chip replaces five formats and the interview-type dropdown | ✅ | #74 | Added 2026-10-07 (user: "too complex… the key point is performance"). Behavioral shape is applied from the classifier, not a control; legacy values map on read ([06](06-OPENAI-SERVICE.md), [11](11-UX-NAVIGATION.md)) |
| 5.13 | Follow-ups stay on the last answer's subject; save dialog drops "What kind of interview was this?" | ✅ | #74 | Added 2026-10-07 (user: "what was your role there?" got an unrelated answer). History header rewritten + the previous answer's lead joins a short follow-up's retrieval query. **Verified live 2026-10-07** against a two-project resume: no drift across two follow-ups |
| 5.14 | Start without an OpenAI key when another chat provider is configured | 🔍 | `feature/interview-copilot-first` | Candidate. Only embeddings and resume parsing are OpenAI-only; the start gate is stricter than that. Needs a graceful no-embedder retrieval path |
| 5.2–5.5 | Documents → memory · Export & backup · Encryption at rest · Labs graduation | ⬜ | — | Carried from the v2.2.0 scope, unscheduled; see the Roadmap |
| 6.1 | Question detection + scheduling — rules where reliable, classifier with context/validation/timeout/late verdicts; detect while streaming, queue, coalesce, supersede, missed cards, "Answer that"; latency instrumentation to first visible | 🔍 | `feature/interview-copilot-first` | Root cause of missed questions: the classify default gpt-4.1-nano was retired 2026-10-23 ([23](23-INTERVIEW-COPILOT.md) §1–2, §8) |
| 6.2 | Session continuity + grounding — bounded context (said vs suggested), follow-ups on what the candidate said, resume restore, source-ranked prompt, résumé/JD balance | 🔍 | `feature/interview-copilot-first` | Replaces the 10-item history buffer ([23](23-INTERVIEW-COPILOT.md) §3–4) |
| 6.3 | Provider-aware Fast/Balanced/Quality selection, discovery, capability metadata, bounded same-provider failover, per-capability readiness, lexical retrieval fallback | 🔍 | `feature/interview-copilot-first` | Delivers 5.14. Cross-provider failover deliberately not built ([23](23-INTERVIEW-COPILOT.md) §5–6) |
| 6.4 | Interview-first UI — Interview default + first on Home, start-modal readiness checklist, trimmed Cue Card, capture-status notice | 🔍 | `feature/interview-copilot-first` | [23](23-INTERVIEW-COPILOT.md) §7, [18](18-ACTIVITIES.md) §10 |

## Acceptance sequence — one milestone at a time

The four implementation commits through `d50b809` are the baseline, not an
accepted release. The earlier usability recommendations and the subsequent
code-review findings remain one backlog. Work already implemented (interview
defaults, compact transcript, advanced model controls, duplicate-control
removal) is retained and checked; outstanding work is not replaced by the
latest review.

The engineer implements **one milestone per handoff**, with a focused commit
and evidence. Codex acts as project manager and independent reviewer. A
milestone advances only after the reviewer records **accepted**; otherwise it
returns to the engineer with specific corrections.

**Standing user authorization (2026-11-18):** Codex may send feedback and
assign work directly to the existing Claude session **“Braincue fullstack
engineer”**, without asking the user to relay or approve each routine
handoff. On a changes-required review, the engineer should immediately work
the listed corrections; on acceptance, Codex should open the next planned
checkpoint and send its concrete scope. Keep one checkpoint at a time and
return implementation/test evidence for independent review before advancing.
This does not change the existing live-capture, push, version or release
constraints. Current assignment: **collect the user's interview feedback
for the published Windows preview**, with scope frozen. The last runner-registration
finding is resolved and accepted at `e721dc2`; the three previous findings
remain resolved at `e7a268b`. No further benchmark redesign is assigned.
The prior three code findings stay resolved at `286920f`; the additional
prefetch fix `c9d225b` is accepted. Live latency evidence remains open. UI-04
is now committed and accepted at `43b0d46`. A concise current instruction for the
engineer is in [ENGINEER-HANDOFF.md](ENGINEER-HANDOFF.md); the engineer should
write the next result to `docs/ENGINEER-RESULT.md` for Codex to read.

**Delivery status:** the direct handoff has not been sent. Both available
computer-control entry points failed to connect to the native pipe, and no
Claude CLI is available on PATH. The shared board contains the assignment,
but editing it does not wake the engineer. Do not describe the engineer as
started or notified without observing delivery through a working channel.

The later pasted `8d0c24d` handoff has been received. It is the same already
accepted commit, with no intervening source change; acceptance stands and
the completed suites are not repeated just for receipt of that report. The
user's standing authorization already covers the requested agent review
workflow; no repeat permission request or CLI installation is needed to
start M7.2b's independent work. File exchange remains passive until a session
is active and reads it.

M1 is accepted at `fc7571c`,
M2 at `cb02b22`, M3 at `e08b684`, M4 at `de24232`, M5 at `c7564ec`, and
M6 at `8f86057`. M7.1 is accepted at `178026d` (on `e20680a`).
**M7.2a is accepted at `8d0c24d`** (on `084cd07`): the remaining AI-02
dashboard draft issue is resolved. **M7.2b correction `286920f` is accepted
for the three code findings**. The offline fixture benchmark in `74f12cd`
passes and the prefetch fix `c9d225b` is accepted. The evidence tooling's
corrections are accepted through `e721dc2`. M7.2b itself
remains open for trustworthy live performance evidence. Codex also
implemented and verified the user's UI-04 toolbar request, now committed
at `43b0d46`. The limited Windows preview `v2.3.0-preview.1` is published;
the user-run interview check is pending. Formal integrated evidence (M7.2c) and stable
release review (M7.3) remain open. This
sequence supersedes treating
6.1–6.4 as one final acceptance batch; their rows above describe implementation
areas, not review approval. No version bump, release, or unrelated expansion
belongs to this sequence.

| Gate | Outcome and scope | Acceptance evidence | State |
| --- | --- | --- | --- |
| M1 | **Reliable interview startup.** Fix silent capture failures, false live state, premature capture-ready reports, and stream cleanup on failed start/resume. | Permission denied/cancelled, unavailable device, failed session IPC, failed audio attachment, and track ending each produce truthful status and recovery. No failed start navigates as if successful; acquired tracks and any created session are cleaned up. A usable partial-capture session explicitly names the missing stream. Normal start/resume still works. | Accepted — `fc7571c` |
| M2 | **Provider selection that stays consistent.** Pin retries to the request's original provider; reconcile reports, briefs, and practice with provider-aware model selection. | A failed cross-provider per-task override never sends data to another provider without explicit authorization. Each exposed feature uses its supported provider/model or shows a clear readiness gate. Cover non-OpenAI-only and multiple-key configurations, unavailable models, and partial streams. | Accepted — `cb02b22` |
| M3 | **Questions answered in the right order.** Fix classification-completion races, duplicate rechecks, and stale/corrected-question handling without stopping detection during streaming. | Controlled delayed-classifier scenarios preserve the stated arrival-order/supersession policy, produce no duplicate cards, and lose no distinct question silently. Verify split questions, interruptions, candidate speech, manual Ask, pause, and stop. | Accepted — `e08b684` |
| M4 | **Conversation context and trustworthy answers.** Preserve searchable full spoken turns; bound prompt output rather than irreversibly clipping the only retrieval source. Keep resume, JD, actual speech, and suggestions distinct, including in coaching. | Recall a fact beyond character 600 of an answer and after 30+ exchanges; restore it on resume. Follow-ups stay on the correct subject, topic switches work, and profile/Space/session isolation holds. Coaching assesses captured candidate speech and labels generated suggestions separately. | Accepted — `de24232` |
| M5 | **A simple path into an interview.** Consolidate Home/navigation, interview creation, resume/JD entry, onboarding, and normal AI setup. | Home has one dominant Start interview action; other activities/tools are secondary. A returning configured user starts within two actions. New interviews use the correct kind and interview lists exclude other kinds. Setup shows resume, role/company, JD, audio, and AI readiness; optional research, tailoring, companion settings, and per-task models stay outside the default path. Replace jargon and repeated explanatory paragraphs with brief labels and actionable states; keep necessary consent/processing information accessible. | Accepted — `c7564ec` |
| M6 | **A usable live view and dependable history.** Finish Cue Card simplification, transcript/session detail, save results, and shared keyboard/draft behavior. | Question and answer dominate the live view; transcript, sources, and extra controls expand on demand. History opens the saved transcript/questions without requiring report generation. Save distinguishes transcript retention, summary success, disabled processing, and failure; local-storage/cloud-processing copy is accurate. Modal focus stays contained, dropdowns support keyboard navigation, and accidental dismissal does not lose edited drafts. | Accepted — `8f86057` |
| M7 | **Live acceptance and release readiness.** Validate the integrated journey after M1–M6 pass. | Typecheck/build and full unit suite pass; complete appropriate UI and privacy regression checks plus a real-audio interview covering start, questions, follow-ups, interruption, recovery, end, history, and resume. Report independent held-out detection precision >=95% and on-time recall >=90%; final-to-decision p95 <=1.5 s and final-to-first-visible p95 <=3 s on a named reference configuration. Include sample counts, cold/warm results, STT/provider/model, and full retrieval. Close AI-01 and PERF-01 below with actual-route evidence and separate general/simple-technical/coding measurements. Unmet or unmeasured targets remain open, with no completion claim. | M7.1/M7.2a accepted; M7.2b implementation and tooling corrections accepted through `e721dc2`. Windows `v2.3.0-preview.1` prerelease published at the user's request; installer built at `1c75cd1`, tag `78f7530`. Live targets and formal M7.2c/M7.3 remain open; v2.2.2 stays stable. |

Every handoff contains the concrete behavior change, files/commit, relevant
regression tests, manual verification where appropriate, and remaining
limitations. Tests should reproduce the reported failure; passing tests that
only mirror implementation are not acceptance evidence. The reviewer records
the result and any follow-up in this section before opening the next gate.

**Overall cycle review result:** M1–M6, M7.1 and M7.2a are accepted.
**M7.2b implementation and evidence-tooling corrections are accepted through
`e721dc2`.** The last registration issue is resolved: independently, its real
registration regression passes 15 tests with 13 no-key tests skipped before
fixture launch. UI-04 is committed/accepted at `43b0d46`. Preview version and
What's New changes at `4823c52` pass three focused unit tests independently.
The previous independent benchmark run passed 89 tests / one opt-in skip.
The engineer reports clean types, 1,369 unit passes, 111 offline E2E passes
and two dry-run passes at the preview; full suites/install checks were not
repeated by Codex. Installation, migration/upgrade, uninstall-retaining-data
and fresh-start checks are accepted as submitted Windows preview evidence.
The installer exists and is unsigned; its SHA-256 is recorded in the review.
**The user-authorized Windows prerelease is published; stable
acceptance remains open.**
The release-note wording corrections/rebuild are accepted at `1c75cd1`;
the short user-run interview remains pending after publication.
Formal PERF-01 remains unmeasured, and
M7.2c/M7.3 stay open. AI-01/AI-02 and UI-01–UI-04 are resolved. This limited
preview path does not waive or mark the formal milestones complete.

### M1 review — `f0ae681`: changes required

The explicit start result, modal failure handling, stream release, and
report-after-attachment improve the original failure paths. Typecheck and
production build pass; the startup, capture-resolution, and start-flow suites
pass (37 tests, including the 9 new startup tests). Two additional in-memory
reproductions against the actual store found blockers:

1. **Failed resume suppresses later legitimate save prompts.** An attachment
   failure adds the existing session id to the process-lifetime `abandoned`
   set. A successful retry never removes it, so stopping that successfully
   resumed session still suppresses its save prompt. Scope suppression to the
   failed attempt/rollback, and verify fail resume → successful resume → normal
   stop → save prompt appears. The failed attempt must still show no prompt.
2. **Rollback failure is reported as confirmed success.** The stop/delete IPC
   errors are swallowed, local session state is cleared, and the message says
   the session was stopped. With a rejecting stop call, the reproduction leaves
   the backend live and the renderer with no session. Keep cleanup failure
   visible and recoverable; do not claim a confirmed stop or delete a session
   while backend teardown is unconfirmed. Test failed cleanup for both new and
   resumed sessions, including successful recovery and preservation of earlier
   resumed content.

The engineer should correct these two paths within M1 and hand it back for
review. M2 remains queued. Live device testing and the integrated checks remain
part of M7; this review used code inspection, build/typecheck, focused unit
tests, and controlled failure reproductions.

### M1 resubmission review — `fc7571c`: accepted

Both blockers from the `f0ae681` review are resolved. Independently reran the
startup (15), capture-resolution (8), and start-flow (20) tests: all 43 pass.
Typecheck and production build pass. Repeated the original failure
reproductions against the actual store with stop-state/save-prompt callbacks:
failed resume → successful retry → normal stop now shows the save prompt;
rejected cleanup keeps the session visible without claiming it stopped;
successful Stop retry stops it, suppresses only the rollback prompt, and does
not delete the earlier resumed session. No application source was changed by
the reviewer. The engineer reports 966 tests passing and two live evaluations
skipped; this resubmission review independently ran the focused suites above,
not the full suite again.

**Non-blocking follow-up for M6:** after rollback fails, Stop in the Cue Card
still goes directly to main, so it stops the session and shows the normal
Keep/Discard dialog rather than the dashboard's rollback behavior. The record
remains available for explicit discard. Unify Stop recovery across windows in
M6 and cover that path; do not silently delete an earlier resumed session.
Real-device/integrated acceptance remains in M7.

**Next authorized milestone after M1 acceptance:** M2 only. Relevant changes parked on
`park/m2-providers` may be used as a starting point, preserving accepted M1
behavior and excluding unrelated milestone work. Hand M2 back for independent
review before beginning M3.

### M2 review — `a8dbe99`: changes required

Static override fallback now stays on its provider, the latency-tolerant
features use routed chat calls, and tailoring is explicitly OpenAI-only.
Independently ran 97 focused tests (routing, policy, live failover, parsing,
briefs, stories, feedback, tailoring, and accepted M1 startup): all pass.
Typecheck and production build pass. Three additional controlled regressions,
using the real policy/resolution/registry/readiness with fake vendor adapters,
failed. No vendor request was made; the temporary review test was removed.

1. **[P1] Failure handling does not retain the actual request route.**
   `reportUnavailable(task)` resolves the task again when an error arrives,
   rather than marking the provider/model that made that attempt. Reproduced
   with both keys present and Anthropic selected: remove the Anthropic key
   while its request is pending, then let that request fail with a model error.
   The report retry reaches OpenAI. Also reproduced with two concurrent OpenAI
   requests to the same initial model: the first fails and successfully retries
   on the fallback; the second old failure marks that healthy fallback
   unavailable and retries the already-rejected initial model. Capture the
   actual provider/model per attempt and use that captured route for failure
   attribution. Keep every retry, including the live path's network retries,
   pinned to the original request provider; settings/discovery/availability
   changes must not reattribute an in-flight request. Add regressions for both
   interleavings and ensure partial streams still cannot replay.
2. **[P2] Mock readiness omits the answer task it actually invokes.** With an
   OpenAI key and a keyless Anthropic `answer` override, `features.practice`
   reports ready, and `mockManager.start` checks only the `mock` task. Its
   `ask()` also invokes `sessionManager.answerQuestion`, whose provider lacks
   a key, so the advertised copilot rehearsal starts with broken answer cues.
   Gate Mock on its actual dependencies and name the missing answer-provider
   key/override fix before creating a session. Keep Sparring's readiness tied
   to its own dependencies rather than unnecessarily requiring the answer task.

M1 remains accepted. Correct these issues within M2 and resubmit; M3 stays
queued. The brief modal's backend-only readiness error and clearer presentation
of practice's chat/voice providers can be addressed in M5/M6; they are not
additional M2 blockers. Live vendor compatibility remains part of M7.

### M2 resubmission review — `cb02b22`: accepted

Both blockers from the `a8dbe99` review are resolved. Verified route propagation
from the live modes, classifier, and routed one-shot calls through the routed
provider and OpenAI/Anthropic/OpenAI-compatible adapters. Failure attribution
uses the captured attempt, and model/network retries on the live path retain
the original provider. Mock checks both question and answer tasks before
creating a row; Sparring retains its separate dependency gate. No production
references to `reportUnavailable` or `features.practice` remain.

Independently ran 102 focused tests across routed features, live failover,
Mock startup, model policy, provider routing/adapters, classification, and M1
startup: all pass. Typecheck and production build pass. Replayed the previous
three review failures using the actual resolution/registry/readiness and fake
vendor adapters: removing a key mid-request sends no retry to another provider;
an older concurrent failure arriving after the first successful retry leaves
the fallback usable; a keyless answer override blocks Mock but not Sparring.
All three pass. The temporary test was removed, and no external AI call was
made. This review did not repeat the full suite or live vendor checks.

The documented no-route dispatch fallback for legacy callers without retries
is not an additional M2 blocker. Any future retry path must carry a captured
route rather than relying on that fallback. Existing presentation follow-ups
remain in M5/M6, and live compatibility remains in M7.

**Next authorized milestone after M2 acceptance:** M3 only. Preserve accepted M1/M2 behavior and
use only relevant parked M3 changes. Cover a slow earlier classification
finishing after a later fast one, duplicate finals concurrently in flight,
corrections/split questions, late verdicts after candidate speech, manual Ask
holding the answer slot, queue overflow, pause, stop, and stale results. State
the arrival-order/supersession policy and verify it with controlled timing;
distinct questions must not disappear silently. Hand M3 back for review before
starting M4.

### M3 review — `6d87b68`: changes required

Arrival-order commits fix the original slow/fast classification and concurrent
duplicate failures on the normal path. Independently ran 122 focused tests
(scheduler, rules, engine scheduling, session parity, live provider failover,
and M1 startup): all pass. Typecheck and production build pass. Four additional
controlled checks using the scheduler's existing harness failed. The temporary
test was removed; no application source was changed and no external AI call
was made.

1. **[P1] Paused classification outcomes bypass late handling and deduplication.**
   Pause before a pending classification returns a timeout/fallback `no` with
   a late-verdict promise; resolve that promise to `yes` afterwards. No answer
   or missed card appears, because the epoch-changed branches inspect only
   `d.act` and discard `d.late`. A separate check sends two identical finals
   while both are classifying, pauses, and resolves both to `yes`: two missed
   cards appear. Handle on-time and late paused outcomes through a shared,
   deduplicated disposition path; preserve distinct questions, suppress only
   duplicates, and still drop results after Stop. Add regressions for both
   interleavings (including pause/resume).
2. **[P1] Supersession bypasses a manual Ask's answer slot.** Finish an automatic
   answer, let manual Ask hold `slotBusy`, then send a correction to the earlier
   question within the continuation window. `supersede()` starts a re-answer
   immediately because it checks only scheduler-owned `active`, not the manual
   slot. In the engine the re-answer aborts the unrelated manual stream. Queue
   that revision until the slot frees, preserving its question/card identity;
   add scheduler and engine-level coverage that the manual answer is not
   cancelled by the automatic correction.
3. **[P2] Lowercase complete questions bypass the new-question guard.** After
   "Walk me through the ledger migration.", send "and why are you interested
   in this role at Google?". The lower-case-start branch in `isContinuation`
   returns before the complete-interrogative check, so the two distinct
   questions merge into one card. Apply the complete-question guard regardless
   of capitalization; test lower-case and mixed-case transcription while
   retaining genuine continuation behavior.

M1 and M2 remain accepted. Correct these three paths within M3 and resubmit;
M4 remains queued. The late-card visual presentation and real-audio timing
checks remain in M7, but the deterministic policy failures above block M3.

### M3 round-2 review — `be6b8f4`: changes required

The first review's four failing checks are addressed: paused detections retain
late verdicts and suppress duplicate cards; ordinary manual Ask holds its slot;
lower-case complete interrogatives remain distinct questions. Independently
ran 145 focused tests (scheduler, rules, detector, engine scheduling, session
parity, live provider failover, and M1 startup) and the three rules-only
detection-evaluation tests: all pass. Typecheck and production build pass.
The held-out rules-only evaluation remains precision 1.000 / recall 0.850.
The full suite and live vendor/audio checks were not repeated in this review.

Four additional controlled checks using the existing harnesses produced one
pass and three failures (two defects). The disclosed manual-Ask takeover race
passes: a manual stream replacing an automatic answer is not aborted when a
correction arrives before the old answer settles; afterwards the revision
re-answers the original card. Temporary tests were removed; no application
source was changed and no external AI call was made.

1. **[P1] A longer repeated final waiting to commit across Pause is still
   silently lost.** Start "Tell me about the payments migration.", let an
   earlier unrelated classification hold the commit chain, then receive
   "Tell me about the payments migration and the rollback plan." and Pause.
   `settlePausedRevision()` treats any `findSame()` result as a disposable
   duplicate, even when the new final adds words. No missed card preserves
   the rollback-plan request. Suppress only copies that add nothing; preserve
   longer revisions through the paused disposition path. Cover both Pause
   and pause/resume with the earlier decision still outstanding.
2. **[P1] A revision can start a new answer after Pause while cancellation
   settles.** Start an automatic answer, send "Sorry, I meant the second
   project.", and Pause before the aborted original stream resolves.
   `supersede()` has marked its job queued but has not inserted it in the
   queue, so `pause()` misses it. After `await this.activeRun`, supersession
   checks Stop but not the changed pause epoch and starts generation while
   paused. Reproduced at scheduler and real EngineSession levels. Keep the
   pending revision visible to lifecycle handling, or capture/recheck its
   epoch after the await; turn it into a paused missed result on its own card
   and never start it automatically after pause/resume. Cover Pause,
   pause/resume, Stop, and slot/waiter cleanup while abort is settling.

**Next authorized work:** correct these two M3 paths and resubmit. M1 and M2
remain accepted; M4 stays queued. The documented extra missed-card case is
still a known limitation; the failing cases above are blocking lifecycle/data
preservation defects, not the visual checks deferred to M7.

### M3 round-3 review — `176e461`: changes required

Both round-2 blockers are fixed. Independently replayed the longer repeat
waiting to commit across Pause and the revision whose aborted stream settles
after Pause: both now pass. The engineer's added pause/resume and Stop checks
also pass. Independently ran 156 focused tests (scheduler, rules, detector,
rules-only detection evaluation, engine scheduling, session parity, live
provider failover, and M1 startup): all pass. Typecheck and production build
pass. This review did not repeat the full suite or real-audio/vendor checks.

Five additional checks using the existing harnesses yielded the two regression
passes above and three EngineSession failures covering two remaining defects:

1. **[P1] A paused correction updates the card but leaves the scheduler's
   current wording stale.** Answer "Tell me about the first project.", start
   an unrelated classification taking 600 ms, then send "Sorry, I meant the
   second project." while its commit waits. Pause and let the classification
   settle: the existing card correctly becomes the joined corrected question.
   Resume within the continuation window, without candidate speech, and send
   "And how you tested it.". The engine updates that SAME question row to
   "Tell me about the first project. And how you tested it." and answers it:
   the correction to the second project is erased from the card and saved
   question. `missRevision()` creates a revised clone but leaves `last`
   pointing at the original answered job. Preserve one current revision and
   its correct missed state for later routing. The following turn must either
   continue the corrected wording, if policy permits, or get its own card;
   it must never overwrite the corrected card using the original wording.
   This is M3 revision-state loss, not the M4 conversation-context work.
2. **[P2] Two classifications across Pause still split a longer revision into
   two cards.** Submit "The thing with the queues last year." and, 50 ms
   later, "The thing with the queues last year and how you handled the
   rollback.". Script both classifications to return yes after 500 ms and
   Pause at 100 ms, before either commits. Two distinct question rows/cards
   open. Reproduced both with Pause alone and with immediate Resume.
   `settlePaused()` still calls `missNew()`, whose recent-missed check only
   drops covered copies; a longer copy gets a fresh job instead of revising
   the existing missed one. Reuse/update its card, or its deferred job when
   not yet shown. This contradicts the round-3 claim that the remaining extra
   card case is restricted to late verdicts outside Pause.

**Next authorized work:** correct these two M3 cases and resubmit. Keep current
wording, lifecycle state, and card identity consistent across rule-routed and
classified paused outcomes; retain an immutable input for any old stream that
is still finishing. Cover the resumed follow-up and both concurrent-classifier
interleavings above, while retaining the earlier lifecycle regressions. M1/M2
remain accepted and M4 stays queued. Temporary review tests were removed;
only this board was edited, and no external AI call was made.

### M3 round-4 review — `b572424`: changes required

The round-3 reproductions now pass. Revised jobs stay current, and concurrent
classifications for the shorter/longer wording across Pause reuse one card.
Independently ran 166 focused tests (scheduler, rules, detector, rules-only
detection evaluation, engine scheduling, session parity, live provider
failover, and M1 startup): all pass. Typecheck and production build pass.
The full suite and real-audio/vendor checks were not repeated in this review.

Five additional EngineSession checks produced two passes and three failures
covering two remaining defects. Stop correctly drops a revision waiting in
`missAfterRun`; a resumed continuation arriving before the original stream
ends correctly preserves its corrected wording and reuses the card.

1. **[P1] A newly classified missed question does not become the continuation
   target, so a resumed follow-up revises the wrong question.** Answer A,
   "Walk me through the payments migration.". Submit B, "The thing with the
   queues last year.", with a scripted yes after 500 ms. Pause at 100 ms,
   let B become visible as missed, then Resume within the continuation window
   without candidate speech and send "And how you tested it.". The engine
   updates A's card to A + follow-up and answers that, while B's card remains
   unchanged. `missNew()` records the missed job but leaves `last` pointing
   to A; `continuable()` still uses that reference. Keep the newest question's
   identity available for routing, including a newly classified missed card,
   with the existing candidate-speech/window rules. An older late result must
   not steal the continuation target from a newer question. Cover the exact
   two-card case, the first-question-missed case, and an older late result.
2. **[P1] A late yes for a longer copy silently loses its additional words.**
   At t=0 submit "The thing with the queues last year and how you handled
   the rollback." with a classifier yes at 2000 ms; at t=50 submit its shorter
   copy, "The thing with the queues last year.", with a yes 500 ms later.
   At t=1200 the longer turn times out to no and the shorter one starts
   streaming. When the longer turn's late yes lands, `lateVerdict()` drops it
   on any `findSame()` match without checking whether the matched question
   covers its words. Reproduced while running and with Pause at t=1300: after
   the stream ends, no card or revised question preserves the rollback part.
   Suppress only covered copies; route added words through the appropriate
   paused/late revision disposition. The documented extra-card limitation
   would retain the request; this actual behavior silently drops it. Add
   both running/paused regressions and retain equal/shorter late deduplication.

**Next authorized work:** correct these two M3 cases and resubmit. The missed
question registry and the current continuation reference must agree about
which question is newest; duplicate handling must distinguish covered copies
from revisions in the late path too. Retain the earlier pause/resume, Stop,
manual Ask, and same-card regressions. M1/M2 remain accepted; M4 stays queued.
Temporary review tests were removed; only this board was edited, and no
external AI call was made.

### M3 round-5 review — `8f5b7a9`: changes required

Both round-4 blockers are fixed. The newly classified missed question becomes
the continuation target, and the late longer copy preserves its added words
under running and paused conditions. Independently ran 173 focused tests
(scheduler, rules, detector, rules-only detection evaluation, engine scheduling,
session parity, live provider failover, and M1 startup): all pass. Typecheck
and production build pass. The full suite and real-audio/vendor checks were
not repeated in this review.

Six additional checks using the existing harnesses yielded two passes and
four failures covering two ordering defects. A missed card deferred behind
an active stream correctly takes a continuation before it appears; an older
late longer copy preserves its words on a missed card without taking the
continuation target from the newer distinct question.

1. **[P1] Coalescing a queued revision leaves its current-question and timing
   metadata stale.** Hold A streaming, then queue B ("Why did you leave
   Acme?") and C ("What is your notice period?"). Receive B2 ("Why did you
   leave Acme and what did you do next?") and then "And how you tested it."
   with 10 ms between turns and no candidate speech. The queued-repeat branch
   of `routeKnown()` changes B's wording but does not update `finalAt`,
   `decidedAt`, or the continuation target. The follow-up is attached to C,
   and EngineSession generates B2 followed by C + follow-up, instead of
   B2 + follow-up followed by C. Reproduced at both scheduler and engine
   levels. A second scheduler check holds a single question behind manual
   Ask, receives its longer copy 10 s later (within the duplicate window),
   then a continuation 10 ms after that: the stale `finalAt` causes a second
   card/job instead of joining the continuation. Refresh revision metadata
   consistently across queued, streaming, answered, and missed states while
   keeping the existing card identity and FIFO position.
2. **[P2] Equal final timestamps let an older queued question replace the
   newer continuation target.** Send A, B, and C in arrival order with the
   same millisecond `finalAt`; A streams and B/C wait. Finish A, so B starts,
   then send a continuation of C. `setLast()` permits B to replace C because
   their timestamps are equal (`>=`); the continuation re-answers B while C
   stays unchanged. Arrival order remains meaningful when wall-clock times
   tie. Use a stable utterance-arrival order to distinguish newer questions,
   preserve that order through classification/late results, and never let
   starting an older queued job make it current. Cover equal timestamps for
   queued starts and an older late result; retain existing different-time
   guards and candidate-speech checks.

**Next authorized work:** correct these two remaining M3 ordering cases and
resubmit. Apply consistent revision metadata and stable arrival ordering
through the existing routing paths; retain the full lifecycle regression
set. M1/M2 remain accepted and M4 stays queued. Temporary review tests were
removed; only this board was edited, and no external AI call was made.

### M3 round-6 review — `5864046`: changes required

The round-5 queued-revision and equal-timestamp interviewer-order failures are
fixed. `Turn` and `revise()` consolidate the previously separate paths, and
the stable arrival comparison retains the newer interviewer question when
an older queued job starts or an older verdict arrives. Independently ran
179 focused tests (scheduler, rules, detector, rules-only detection evaluation,
engine scheduling, session parity, live provider failover, and M1 startup):
all pass. Typecheck and production build pass. The full suite and real-audio/
vendor checks were not repeated in this review.

Seven additional controlled checks produced four passes and three failures
covering two remaining edge cases. Independent replays confirm the queued
B/C/B2/follow-up case, the delayed queued revision's window, the equal-time
queued start, and continuation of a deferred missed card all work.

1. **[P2] Candidate speech is still ordered only by timestamp.** At the same
   millisecond, answer "Tell me about the first project.", then receive a
   genuine candidate turn ("I built the payment service and deployed it.").
   Let the microphone turn pass the echo hold (1600 ms), then receive "And
   how you tested it." within the continuation window. The engine revises
   the original card to the joined question despite the confirmed candidate
   speech in between. Reproduced at both scheduler and EngineSession levels.
   `continuable()` compares `lastCandidateAt > p.finalAt`, so an equal-time
   candidate never creates a barrier. Arrival ordering must also preserve
   confirmed candidate speech relative to interviewer turns; retain the
   existing rule that a dropped microphone echo creates no such barrier.
   Cover the continuation, repeat and late-result candidate guards under
   tied timestamps, including the echo-hold path.
2. **[P2] An older late revision moves the continuation clock backward.**
   At t=0 submit "The thing with the queues last year and how you handled
   the rollback." with a classifier yes at 4900 ms (within the late window).
   At t=4000 submit its shorter copy, "The thing with the queues last year.",
   with a yes 100 ms later. The shorter question is answered, then the older
   late longer verdict correctly re-answers its card. At t=8500, send "And
   how you tested it.": this is only 4500 ms after the newer contributing
   final, but becomes a separate question/card. `revise()` preserves the
   maximum arrival but unconditionally sets `finalAt` back to t=0, expiring
   the window early. Reproduced in EngineSession. Preserve the time anchor
   of the latest contributing turn when enriching a job with an older late
   turn; refresh it normally for a genuinely newer revision. Add this
   regression and retain the existing delayed newer-revision/window checks.

**Next authorized work:** correct these two M3 edge cases and resubmit. Keep
the stable interviewer arrival ordering and shared revision path; extend the
speech barrier consistently and prevent older verdicts from rewinding the
current question's timing. M1/M2 remain accepted; M4 stays queued. Temporary
review tests were removed; only this board was edited, and no external AI
call was made.

### M3 round-7 review — `e08b684`: accepted

Both round-6 blockers are fixed. Confirmed candidate speech now shares the
interviewer arrival sequence while retaining its capture order through the
echo hold. A dropped microphone echo creates no barrier. Older late copies
enrich the question without rewinding its newer continuation time anchor.
The fragment hold retains the first turn's order until a later part joins it,
at which point the joined question takes the latest contributing arrival.

Independent validation:

- All 186 focused tests pass (scheduler, rules, detector, rules-only detection
  evaluation, engine scheduling, session parity, live provider failover, and
  M1 startup). Typecheck and production build pass.
- Seven additional checks using the existing scheduler/EngineSession harnesses
  pass: both previous failures; candidate capture before a newer question but
  confirmation afterwards; microphone echo arriving before the system copy;
  confirmations received in reverse capture order; a held fragment's late
  result after candidate speech; and a joined fragment taking its last part's
  arrival. The scratch tests were removed.
- Full-suite coverage verified: 1,069 unique tests pass and 2 live evaluations
  remain skipped. The sandboxed run had 1,061 passing and 8 downloader failures;
  the local HTTP fixture received no requests. Re-running that nine-test file
  with localhost access outside the network sandbox passed all nine. This was
  an environment restriction, not an application change; no external AI call
  was made.

The declared late-longer-copy behavior is accepted: when a different question
is now current or the candidate has replied, the added words remain visible
on a separate missed card. This preserves the earlier answer and the new
request rather than silently losing either. It does not permit equal/shorter
duplicate cards. Real-audio interleavings, final Cue Card presentation, and the
performance/detection targets remain M7 acceptance work. Rules-only held-out
recall is still 0.850; M3 acceptance is scheduling acceptance, not release or
live performance sign-off. No version bump or release is authorized.

**Next authorized milestone: M4 only — conversation context and trustworthy
answers.** Preserve accepted M1–M3 behavior. Review the existing context,
prompt, resume hydration, retrieval and coaching paths, and use only relevant
parked M4 work. The concrete acceptance checks are:

1. Preserve the full spoken turn as searchable source data. In
   `conversationContext.ts`, `addTurn()` currently clips the stored turn to
   `LIMITS.turnChars` (600) before older-turn retrieval can search it. Bound
   the rendered prompt and retrieval excerpts while retaining access to the
   complete transcript. Any in-memory retention limit must still allow
   retrieval from this session's persisted source.
2. Recall a distinctive fact beyond character 600 after 30+ exchanges, then
   stop/resume and recall it again. Verify the retrieved answer input at the
   engine/prompt boundary, not only a helper's stored length. Cover coherent
   speaker/turn ordering, referential follow-ups, topic switches, and isolation
   between sessions, profiles and Spaces; keep retrieval and prompt sizes
   explicitly bounded.
3. Keep resume evidence, employer JD requirements, actual conversation, and
   BrainCue suggestions distinct throughout generation and reports. A generated
   suggestion is never evidence that the candidate said it, and a JD
   requirement is never evidence of the candidate's experience.
4. Fix interview coaching in `session/report.ts`: its current Q/A block labels
   `q.answer.directAnswer` (the AI suggestion) as `A`. Assess captured candidate
   speech and associate it with the appropriate question; label suggestions
   separately. If speech is absent, report that no answer was captured rather
   than assessing the suggestion as the user's performance. Retain Sparring's
   existing spoken-answer feedback behavior.

Hand back one focused M4 commit, regression evidence (including which original
bugs the checks catch), typecheck/build results, and limitations before starting
M5. UI simplification stays in M5/M6; live audio and release metrics stay in M7.
Only this board was changed during the review; its accumulated review edits
remain uncommitted for the engineer to preserve.

### M4 review — `f48500c`: changes required

Whole-turn storage, query-aware excerpts, scoped persisted-transcript recall,
spoken-time writes, source labels, and separating candidate speech from AI
suggestions address the original M4 failures on the submitted fixtures.
Independently ran 261 focused tests across context acceptance/unit coverage,
coaching, prompts, provider routing, engine scheduling/parity, archives,
meeting reports, and memory persistence: all pass. Typecheck and production
build pass. The full suite and live audio/model calls were not repeated.

Seven additional checks using the existing real-engine/sql.js and report
harnesses fail, covering four issues:

1. **[P1] Punctuation-free speech is searched whole but its recalled fact
   never reaches the answer prompt.** Remove the sentence punctuation from
   the submitted LONG answer, keeping the Atlas/40-minute fact beyond
   character 600. Ask 31 intervening questions, then ask the Atlas downtime
   question. BM25 selects the right full turn, but `excerpt()`'s
   `parts.length < 2` branch returns its first 500 characters, which omit both
   Atlas and the downtime. Reproduced at the real prompt boundary live and
   after Stop/Resume. This fails the central recall requirement; it cannot
   be accepted simply as an excerpt-format limitation. Select bounded text
   around matching words even without sentence punctuation (including a
   matching sentence longer than the excerpt budget). Retain the full source
   and prompt ceiling; test both punctuated and unpunctuated recall.
2. **[P1] Coaching assigns another question's reply to an unanswered one
   when the intervening question has no detected-question row.** The real
   engine records A, "What is your notice period?", then B, "Say more about
   the ranking change."; the scripted classifier misses B, so only A has a
   card. The candidate says "I changed the ranking feature weights after an
   offline relevance evaluation.". `coachingExchanges()` uses only the next
   detected-question anchor as a boundary and discards intervening interviewer
   turns, so it labels that speech as A's answer. A separate report check
   confirms an empty A can receive a positive assessment based on B's reply.
   Retain interviewer evidence/boundaries when associating speech; do not
   assume every candidate turn until the next card answers the current card.
   Where association is uncertain, report it rather than crediting the wrong
   answer. Fix report attribution within M4; this does not require making
   question detection infallible or reopening M3.
3. **[P2] New equal-time turns still lose capture order through the echo
   hold.** Capture question A, candidate reply C, and question B in that
   order in one millisecond. C is held, so persistence writes A/B/C. The new
   `transcriptOrder()` breaks the equal spoken timestamps by rowid (insertion
   order), restoring A/B/C rather than A/C/B. Reproduced after real engine
   Stop/Resume and in coaching: C is attached to B, and A is marked silent.
   This affects NEW M4 rows, beyond the documented legacy insert-time
   limitation. Carry stable capture order through context and persistence,
   including tied timestamps and delayed echo confirmation; use it for
   resume/report/history ordering and keep an explicit legacy fallback.
4. **[P2] Report input is not globally bounded.** With 120 spoken exchanges,
   the 300-character minimum overrides `totalSaidChars / count`, emitting
   36,000 spoken characters despite the declared 24,000 total. Question,
   suggestion, and silent-question sections also grow with no aggregate
   request cap. Fix the per-request budget while preserving coverage of all
   questions, for example by bounded batches with stable assessment numbers
   and aggregation. Do not restore the old blind tail cut. Add large-session
   coverage that checks each provider request's complete size and confirms
   later questions still receive their assessments.

**Next authorized work:** correct these four M4 cases and resubmit one focused
commit. Keep the passing source-isolation, full-storage, resume, source-label,
missing-speech, and Sparring checks. Preserve accepted M1–M3 behavior; M5 stays
queued. Legacy-timestamp limitations remain documented. Measure persisted
recall cost and retained heap (including the archive cache) during M7 rather
than inferring total memory use from the bounded active-turn buffer alone.
All temporary review tests were removed; no application source was changed
and no external AI call was made. Only this board was edited.

### M4 round-2 review — `9dc94cb`: changes required

The four original findings are fixed on the reproduction paths. Word windows
preserve unpunctuated matching passages; coaching respects intervening
interviewer turns and labels undetected requests; `capture_seq` retains
equal-time order through echo confirmation and resume; report batches retain
all assessments within their user-input cap. Typed Asks are explicitly unlinked
instead of guessing an association from their coarse creation timestamp.
Migration 0017, its snapshot and journal entry are present. Independently ran
285 focused tests, including migration/reconciliation, context, coaching,
prompts, routing, engine scheduling/parity, archives and memory: all pass.
Typecheck and production build pass. The full suite and real audio/model calls
were not repeated in this review.

Four additional checks produced two passes and two failures. The restored
capture counter correctly continues after persisted sequence numbers, and a
120-question report mixing spoken/silent answers keeps assessment numbering
and bounds every batch plus synthesis. The two failures (context unit and
real engine/persistence) reproduce one remaining issue:

1. **[P2] Equal-time older turns fall out of all prompt blocks when the recent
   window advances.** Record an Atlas question/reply containing "40 minutes
   of downtime", then 15 other exchanges, with stable capture order but tied
   spoken timestamps. Once the fact leaves the 12-turn recent window, asking
   the Atlas downtime question supplies no such fact to the real answer
   prompt, both live and after Stop/Resume. `snapshot()` takes only
   `oldestRecentAt` as its boundary, then filters older recalled turns, earlier
   exchanges and open questions with strict `at < oldestRecentAt`. The older
   turns tie that time, so they are neither recent nor eligible for retrieval;
   they remain in memory, so the eviction archive does not rescue them.
   Capture-order persistence fixes sorting but does not fix window membership.

   Split recent and older data by their position/stable order in the ordered
   transcript, including ties, and apply the same boundary to recalled turns,
   earlier exchanges and open questions. Every source turn outside the recent
   window must remain eligible for retrieval. Add unit and real-engine
   regressions covering live and resumed tied timestamps, legacy fallback
   order, and the unchanged prompt ceiling. Keep the existing distinct-time,
   eviction-recall, isolation and source-labelling checks.

**Next authorized work:** correct this M4 window-boundary case and resubmit.
The original four corrections need no rework except to retain their regression
coverage. M1–M3 remain accepted; M5 stays queued. The declared conservative
interviewer-statement segmentation and extra synthesis call remain documented;
archive latency/retained-memory measurement and live audio remain M7 work.
Temporary review tests were removed; only this board was edited and no
external AI call was made.

### M4 round-3 review — `de24232`: accepted

The remaining boundary failure is fixed. Recent and older data now divide at
a position in the ordered transcript. Recalled turns, earlier exchanges, and
open questions use that same boundary; retrieval results retain transcript
order when timestamps tie. Prompt budgets remain unchanged.

Independent validation:

- All 288 focused tests pass, including migrations/reconciliation, context
  acceptance and unit tests, reports, prompt/source labels, provider routing,
  engine scheduling/parity, archives, meeting reports, and memory persistence.
- Four additional checks pass: the previous tied-timestamp recall with
  capture-order metadata; the same case with legacy insertion order; a
  character-budget boundary before the 12-turn limit; and the real engine's
  tied-time recall live and after Stop/Resume. These also check the open
  question, recall ordering, and unchanged rendered prompt ceiling. Scratch
  tests were removed.
- Typecheck and production build pass. Independently ran the complete suite
  with localhost access for its local downloader fixture: **1,104 pass and
  2 live evaluations remain skipped**. No external AI call was made.

M4 is accepted at `de24232`. Known limitations remain explicit: legacy rows
cannot reconstruct missing capture order; report segmentation can conservatively
split an answer at an interviewer statement; large reports use additional
bounded calls. Real audio/model validation, persisted-recall latency, retained
heap including the archive cache, and release performance/detection targets
remain M7 work. This is not release sign-off.

**Next authorized milestone: M5 only — a simple path into an interview.**
Preserve accepted M1–M4 behavior and use only relevant parked M5 work. The
user's original concern is excessive choices and explanatory text: reduce the
decisions needed to start, with clear status and one useful next action.

1. **Home and navigation:** one visually dominant "Start interview" action.
   Practice, tailoring, other activities, and extra tools remain reachable
   as secondary actions rather than equal competing launch cards. Keep
   existing supported routes and the single active-profile switcher; do not
   introduce another profile/mode selection step into interview setup.
2. **One interview setup path:** consolidate the existing Home/start modal
   and Interview page creation/start surfaces. Show resume, role/company, JD,
   audio and AI readiness together with brief labels and actionable states.
   Make resume/JD entry easy to reach from there. Keep optional research,
   tailoring, companion posture/budget and per-task model overrides outside
   the default interview path; retain necessary consent and processing details
   in accessible disclosure. Avoid repeated paragraphs and implementation
   terminology in normal product copy.
3. **Returning-user start:** a configured returning user can start in at most
   two app actions (for example Home "Start interview", then explicit Start
   with valid saved setup). Preserve the user's actual profile/activity/Space
   choices and invalidate stale defaults after a profile switch or deletion.
   Report required OS capture-picker actions separately. Capture still begins
   only on explicit Start, and M1's failure/partial-capture recovery stays
   truthful.
4. **Correct interview data:** create interview Spaces with the interview/job
   kind, and filter interview lists and Start/Resume choices to the appropriate
   activity/session kind. Meetings, companion sessions and practice drills
   must not appear as resumable interviews. Preserve per-profile scoping and
   server-side pagination.
5. **Simple, provider-aware setup:** use main's capability readiness for the
   onboarding flow, Home setup state and start gate. A configured non-OpenAI
   chat provider plus local transcription must not be shown as incomplete
   merely because an OpenAI key is absent. Cloud transcription may still need
   it and must say so. Keep model overrides advanced and show each missing
   required item's concrete fix. Refresh readiness after configuration changes.

Relevant current surfaces include `HomePage.tsx`, `App.tsx`,
`StartSessionModal.tsx`, `InterviewPage.tsx`, `JobFormModal.tsx`,
`SetupChecklist`/`setupChecklistState.ts`, and onboarding/provider settings.
The existing onboarding/checklist still rely on the OpenAI-only key flag in
places; replace those assumptions using the accepted provider/readiness policy.

Hand back one focused M5 commit with before/after screenshots of the default
Home/start/onboarding views, a counted returning-user walkthrough, and evidence
for empty setup, missing readiness, non-OpenAI/local-STT readiness, profile
switching and interview-only lists. Use behavior tests for routing/defaults/
gates and visual/manual verification for copy/layout; include typecheck/build
results and limitations. Return for review before starting M6. Cue Card,
save/history and shared modal/draft improvements remain M6; live acceptance
and release metrics remain M7. No push, version bump, or release was performed
by this review. Only this board was edited and remains uncommitted.

### M5 review — `38f16a8`: changes required

The default Home/start/onboarding screenshots show the intended simplification:
one dominant Start interview action, secondary tools, compact setup rows and
optional detail behind disclosure. New interview creation uses the same start
modal, interview lists are filtered in the repository before pagination, and
onboarding/Home/start use main's provider-aware capability readiness. These
changes should be retained.

Independent validation: **116 focused tests pass**, covering start/defaults,
checklist/onboarding, profile scoping, repository activity filtering, sample
parsing, M1 startup recovery and M2 routing/readiness. Typecheck and production
build pass. Reviewed before/after screenshots. An isolated renderer harness ran
the actual StartSessionModal with fake API data and a stubbed start operation:
an explicit role within the first page and the normal returning-user default
both reached Start with the expected job ID. It opened no audio and made no
external requests. The full suite and real audio/model calls were not repeated.

Three corrections remain:

1. **[P2] An explicit valid role outside the first 100 is replaced by another
   role before Start.** `StartSessionModal` successfully gets the supplied
   `initialSpaceId`, but uses that row only to learn the activity. Its picker
   loads the first 100 rows, and `nextSpaceChoice()` treats a selected ID absent
   from that partial page as deleted. Reproduced in the actual renderer with
   101 valid interview roles: opening for `role-101` showed `role-1`, and
   pressing Start submitted `jobId: 'role-1'`. This can ground the interview in
   a different JD. The acknowledged picker limit does not justify silently
   replacing an explicit selection. Retain/resolve the selected role separately
   from the paginated options, validating its profile and activity; resolve a
   returning user's last role even when outside that page. Preserve server-side
   pagination, and provide a way to select older roles. Add component-level
   coverage of explicit and last-used older roles, plus profile-switch/deletion
   invalidation. Do not fetch an unbounded list to work around the issue.
2. **[P2] The compact AI error names the wrong provider for a blocked classifier
   override.** With a valid OpenAI answer key and a keyless Anthropic classify
   override, real main readiness correctly says the classify override uses
   Anthropic. `checklistRows()` instead constructs "OpenAI has no API key"
   from the answer provider. Both a real-policy regression probe and the actual
   renderer reproduce it. The useful cause/fix is relegated to a hover title.
   Use the actual failed capability/provider in the short state, and make the
   concrete fix available without requiring hover. Keep the healthy OpenAI
   answer route and accepted M2 provider policy unchanged. Cover missing
   classifier and missing answer keys separately, using main readiness.
3. **[P2] The start disclosure understates both the text sent and its recipients.**
   Interview `captureSummary()` lists only the detected question and five
   document chunks, naming the answer provider. The actual pipeline also sends
   bounded recent/earlier/recalled spoken context (including candidate speech),
   earlier suggestions and matching approved memories to the answer model;
   ambiguous turns and recent conversation go to the classifier. Its override
   may select a different provider. A real-routing probe with local STT,
   Anthropic answers and OpenAI classification reaches both fake adapters,
   while the disclosure names only Anthropic. The submitted disclosure
   screenshot has the same omissions. Describe these categories concisely in
   the accessible disclosure and obtain both task recipients from authoritative
   route/readiness metadata. Keep the default form short; this is an accuracy
   correction inside the existing disclosure, not a request for more launch
   controls or another confirmation. Test split-provider routing and spoken
   context/approved-memory disclosure alongside local/cloud transcription.

Two additional real-policy/unit regression probes fail on findings 2 and 3;
the isolated renderer reproduces findings 1 and 2. All scratch tests and the
isolated renderer harness were removed. No application source was changed;
only this board was edited and remains uncommitted.

**Next authorized work: correct these three M5 cases and resubmit one focused
commit.** Preserve the simpler layout, passing tests and accepted M1–M4 behavior.
M5 is not accepted; M6 and M7 stay queued. The stated direct-Resume path and
shared modal keyboard/draft behavior remain explicit M6 follow-ups; real
capture/audio, model calls and release/performance evidence remain M7. No push,
version bump or release is authorized by this review.

### M5 round-2 review — `937c72f`: changes required

The three original reproduction paths are corrected. Explicit and last-used
older roles are resolved separately from the picker page, older roles are
searchable, main identifies the blocked task/provider, the fix appears on the
form, and the expanded disclosure names task recipients and conversation/
memory processing. Reviewed the three new screenshots; the default form stays
compact. Keep these corrections.

Independent validation:

- **116 focused tests pass**, covering start/defaults/disclosure, checklist,
  setup/onboarding, profile scoping, repository activity filtering, samples,
  M1 startup recovery and real-policy M2 routing/readiness.
- Typecheck and production build pass.
- **The submitted real-app Electron start-flow test passes**, including its
  explicit older role, search, last-used role, deletion and profile-switch
  steps. It uses an isolated database and never starts capture.
- Two additional controlled renderer cases use the actual StartSessionModal,
  fake API replies and a stubbed Start, with no audio or external traffic.
  Both reproduce the regression below on `937c72f`; both preserve B and submit
  B on `38f16a8`, loaded read-only from Git. Application source was never
  swapped in the working tree. The full unit suite was not repeated.

One correction remains:

1. **[P2] A delayed initial-role lookup overwrites a newer explicit choice.**
   The open/reset effect's `api.jobs.get(initialSpaceId)` has no cancellation
   or current-choice guard. Its `.then()` now writes `selected` and `chosen`
   unconditionally for the profile captured when it began; it also writes the
   activity, and `.finally()` can clear another lookup's resolving state.

   Reproduced with two valid interview roles A and B in the same profile:

   - Hold A's lookup, close its modal, open the modal for B, and confirm B is
     displayed. Release A's old lookup: the card/picker change to A, and
     explicit Start submits `jobId: 'A'`.
   - Hold A's lookup, choose B from the loaded picker without closing the
     modal, then release A. The same overwrite and wrong Start argument occur.

   Re-reading before Start cannot catch this: A still exists and fits the same
   profile/activity. Tie lookup completion to the current opening/scope and
   choice generation. Closing/reopening, changing profile/activity, or making
   a newer manual choice must invalidate the earlier lookup; ignore its stale
   success, failure and finalization callbacks. Preserve the page-independent
   selection and bounded default lookup. Add controlled component regressions
   for both sequences above and for a profile switch while the lookup is
   pending; assert the actual submitted job ID with capture stubbed. The
   current real-app test waits for each lookup before proceeding, so it does
   not exercise these interleavings.

**Existing E2E limitations remain open.** The engineer reports 6/7 smoke tests
failing on both this submission and pre-M5 `de24232`. Independently confirmed
that `e2e/smoke.spec.ts` and its fixture are unchanged since `de24232`, and the
spec still expects old Home/settings copy and sidebar navigation during fresh
onboarding. The six failures were not rerun in this review. Repair and run
that suite before M7 release acceptance; a passing new start-flow spec or unit
suite is not evidence that all E2E checks pass. The reported data-integrity
parse failure under blocked network, live audio/model checks and macOS remain
unverified; do not infer a product regression or a pass from those limitations.

**Next authorized work: fix this M5 lookup race and resubmit one focused
commit.** No rework of the other three corrected paths is requested beyond
retaining coverage. M1–M4 remain accepted; M6 and M7 stay queued. All temporary
review harness files were removed; only this board was edited and remains
uncommitted. No push, version bump or release was performed.

### M5 round-3 review — `c7564ec`: accepted

The remaining lookup race is corrected. Initial-role and default-role lookups
retain their choice generation; replies cannot change the role or clear the
current loading state after a newer opening, profile/activity change or user
choice. Saving/deleting a role and failed pre-Start validation invalidate older
lookups too. Page-independent selections, bounded defaults, search and server
pagination remain intact. No further blocking M5 finding was identified.

Independent validation:

- **Full unit suite: 1,140 pass, 2 live evaluations skipped**, across 105 passing
  files and one skipped file. This includes accepted M1–M4 regression coverage,
  routing/readiness and the M5 start/disclosure/onboarding tests.
- Typecheck and production build pass.
- **All six selected Electron checks pass:** the real-app start-flow test
  (explicit older role, search, last-used role, deletion and profile switch),
  plus five hidden-renderer cases: baseline Start, close/reopen with a late
  reply, manual choice with a late reply, profile switch with a late reply,
  and stale rejection/finalization while a newer lookup remains pending.
  Each renderer case checks the submitted job ID with Start stubbed.

The renderer cases bundle the actual modal/stores and control fake bridge
timing; their dispatched dropdown option clicks do not establish pointer or
full keyboard accessibility. The real-app spec exercises pointer selection
against an isolated database. Neither check establishes real audio/capture,
vendor calls or macOS behavior. The pre-existing smoke failures and the
data-integrity spec's reported parse failure under blocked network remain
documented in the round-2 review; the complete E2E suite is not claimed to pass.
M7 must repair and run the smoke suite and obtain the remaining live evidence.

M5 is accepted at `c7564ec`. Only this board was edited by the reviewer and
remains uncommitted. No push, version bump or release was performed.

### M6 handoff — a usable live view and dependable history

**Next authorized milestone: M6 only.** Preserve accepted M1–M5 behavior and
use relevant parked work only. The aim is a call that is easy to follow and a
saved conversation that is easy to read. Work through these items in order,
then return one focused M6 commit for independent review before starting M7:

1. **Live Cue Card.** Make the current question and answer the dominant content.
   Keep a concise latest-transcript/capture state and useful Ask, Pause/Resume,
   Stop and retry actions; expand full transcript, sources/data sent, previous
   cards, models and extra settings on demand. Keep missed questions and their
   retry visible, including `late` and `paused` reasons. Preserve manual-Ask
   ownership, same-card revisions, arrival order, actual capture warnings and
   the supported meeting/companion/practice behavior. Trim repeated prose and
   competing controls; do not redesign the accepted scheduler or grounding.
2. **Readable session history.** Opening a saved session first shows its
   persisted transcript, questions and generated answers/cards without needing
   an API key, a generated report or a network request. Preserve M4 capture
   order and distinguish what the person said from generated suggestions.
   Coaching/report generation is a separate explicit action; its absence or
   failure must leave the transcript readable. Keep profile/Space/activity
   scoping and bounded server pagination for growing history lists.
3. **Truthful Keep/Discard results.** Distinguish local transcript retention
   from archive-summary and memory-suggestion processing. Report success,
   disabled/opted-out processing, no Space, insufficient content and processing
   failure accurately; zero output counts alone cannot identify the reason.
   Carry sufficient typed outcomes through main/preload for that distinction.
   A processing failure retains the transcript and offers an appropriate
   recovery. Keep/Discard/Decide later must be clear about what remains and
   what is deleted; copy must name remote processing instead of promising
   everything stays on the machine. Retain consent and approval gates. Validate
   the chosen destination independently of its picker page, including older
   Spaces, deletion and profile changes.
4. **Keyboard and drafts.** Contain modal focus, restore it on close and avoid
   stealing focus during updates. Give dropdowns arrow/Home/End selection,
   Enter/Space activation and Escape behavior that closes the inner control
   first, with accessible state. Keep useful explanatory detail reachable by
   keyboard. Accidental Escape/backdrop/close must preserve edited drafts or
   offer an explicit discard decision; busy operations must not silently lose
   their state. Use shared UI behavior consistently across affected forms.
5. **Resume and cross-window Stop.** Bring Resume through the current setup,
   readiness and processing disclosure before capture, reusing the start flow.
   Address M1's carried follow-up: Cue Card Stop after a failed startup rollback
   must follow the same truthful retry/cleanup policy as dashboard Stop. Never
   delete a resumed session's earlier content or suppress a later legitimate
   save prompt. Keep partial-capture recovery and failure messages intact.

Relevant surfaces: `overlay/Overlay.tsx`, its cards/controls/panels and store;
`dashboard/pages/SessionsPage.tsx`, `SavePromptModal.tsx`,
`pages/InterviewPage.tsx`, `StartSessionModal.tsx`, shared `components/ui.tsx`,
`JobFormModal.tsx` and profile forms; main's session IPC, archive and memory
outcomes where required. Prefer existing typed IPC and repositories.

Hand back before/after default Cue Card, session-detail and save-result views;
a counted live → Stop → Keep → history → Resume walkthrough; behavior tests for
offline history, each save outcome, failed-rollback Stop from both windows,
and the affected keyboard/draft interactions. Use controlled failures and fake
providers for regressions, retain the M5 timing/pagination cases, and include
typecheck/build/full-suite results. Declare unverified hardware/platform cases.
M7 retains live audio/model acceptance, detection/latency targets, persisted
recall/retained-heap measurement and release checks. Return for review before
any M7 work; no push, version bump or release is authorized by this handoff.

### M6 review — `25a1dce`: changes required

The default Cue Card is clearer, history opens persisted conversation without
generating a report, Keep has useful typed outcomes, and the shared keyboard
and draft work has meaningful renderer coverage. M1's carried cross-window
rollback case is covered by the real-engine and renderer regressions. Preserve
these changes. Four deterministic gaps still block M6 acceptance:

1. **[P2] A failed initial destination lookup silently files the session out
   of its Space.** In `SavePromptModal.tsx:109`, an exception from `jobs.get`
   is ignored, then resolving ends with `space === null`. Keep submits
   `session.remember(sessionId, null)` (`:162`), which explicitly clears the
   persisted association in `rememberSession`. Reproduction: open a prompt
   whose `packId` is R, fail its initial lookup while R still exists, then
   press Keep. The recorded submission is `[S, null]` without an explicit
   No Space choice or an explanation of the failed lookup. Treat an unknown
   destination separately from a confirmed missing one. Show the failure and
   allow retry or an explicit destination choice; do not silently unfile it.

2. **[P2] Errors during Retry are hidden, including the destination recovery
   controls.** `SavePromptModal.tsx:203` keeps rendering the previous outcome;
   errors are rendered only in the other branch (`:277`). After an initial
   processing failure, an IPC rejection on Retry leaves only the old reason
   visible. If the destination has been deleted, Retry clears `space` and sets
   an error but exposes neither that error nor the picker. A subsequent Retry
   can therefore submit null without the user choosing it. Two independent
   renderer cases reproduce the hidden transport error and the deleted-Space
   error. Show the new failure on the result view and provide an explicit way
   to resolve the destination before retrying; preserve any confirmed outcome.

3. **[P2] Resume skips the final role validation.** The new branch in
   `StartSessionModal.tsx:316` fetches the session and immediately calls
   `resumeExisting`, bypassing the fresh role check below it. If the role is
   deleted after the modal's lookup succeeds, pressing Resume still submits S;
   it does not show the advertised deleted-role blocker. Main's `engine.resume`
   also does not validate the role, so there is no downstream refusal. Validate
   the session's current role/profile/activity before capture, using current
   session data rather than just the list row and opening-time lookup. Keep
   the same-session resume and existing readiness/disclosure behavior.

4. **[P2] Saved voice quick Asks disappear from offline history.** The detail
   query in `sessions.repo.ts:262` excludes every `kind: 'answer'` contribution
   on the assumption that each has a detected question. `voiceService.quickAsk`
   persists opted-in quick Asks as standalone answer contributions with
   `meta.source = 'voice_quick_ask'`, without a detected-question row or a
   transcript. Their session therefore opens with no readable content. An
   isolated real-schema test using that writer's persisted shape returns both
   empty questions and empty cards despite the saved answer. Include answers
   not represented by a detected-question/answer entry, deduplicating only
   actual linked equivalents. Show the saved question/title and answer as
   generated content; keep it available without a report or provider call.

**Independent verification:**

- Full unit suite: **1,177 passed, two skipped**, across 110 passing files and
  one skipped file. Typecheck and production build pass.
- All **35 submitted renderer cases pass**: seven Cue Card, 15 history/save,
  six keyboard/draft and seven start/resume cases. They bundle real components
  in hidden Electron with a recording fake bridge; no capture is started.
- Four additional renderer checks fail on the submitted production source for
  the exact behaviors above: stale Resume role, Retry transport error, deleted
  destination during Retry, and failed initial destination lookup. The fifth
  independent failure is the real-schema quick-Ask history check. Baselines
  and normal successful flows remain covered by the submitted passing cases.
- Inspected the supplied after screenshots for the live card, session detail
  and failed-summary result. This review did not independently repeat the
  engineer's real-app walkthrough or its two reported real-app specs. It used
  no real audio or external model calls. It does not establish M7 live,
  performance, privacy, platform or screen-reader acceptance.

**Correction handoff:** fix these four paths within M6 and add focused
regressions against `25a1dce`. Keep the accepted M1–M5 behavior, the new shared
keyboard coverage, and ordinary cross-window Stop. Return the focused
correction commit, before/after failure evidence and full check results for
review. Do not start M7, push, bump a version or release. Temporary reviewer
tests are removed; only this board remains edited and uncommitted.

### M6 correction review — `f429da1`: changes required

**The original four findings are addressed.** Failed initial Space lookups
stay unknown until a successful retry or an explicit choice; Retry's own
errors and destination recovery are visible; Resume validates current session
and role data in the renderer and main; saved quick Asks are readable offline.
The selective-retry IPC and merge also avoid re-running a confirmed half at
the same destination. Preserve those fixes. Two regressions in the correction
still need to be fixed before M6 is accepted:

1. **[P2] History revives an answer deliberately cleared for a paused
   correction.** `sessionTimeline.ts:78` falls back to a linked contribution
   whenever the current answer text is empty, rather than only when the
   answer record is absent. The repository includes these old contributions
   because its exclusion set (`sessions.repo.ts:275`) also requires nonempty
   current text. M3 intentionally saves an empty answer when a correction
   waits behind manual Ask and Pause is pressed: `EngineSession.surfaceMissed`
   revises the question and replaces its answer with `''` plus the paused
   warning, retaining the old completed generic contribution. History now
   attaches that stale contribution to the revised question.

   **Independent reproduction:** use the real persistence helpers to write
   the completed answer to "Tell me about the first project", then apply the
   same correction/clear writes as `surfaceMissed`: question becomes "...Sorry,
   I meant the second project", answer becomes empty with the paused warning.
   Reading the real repository and timeline returns "The first project
   migrated billing" as the revised question's answer, despite its current
   answer row being empty. The control for a normal linked completed answer
   passes. Distinguish an intentionally cleared current answer from a missing
   answer record; never restore an obsolete answer under corrected wording.
   Retain genuine missing-record recovery, standalone quick Asks and dedupe.

2. **[P2] Choosing a Retry destination relabels a confirmed summary before
   any retry runs.** `SavePromptModal.tsx:275` renders `result` using the mutable
   picker `space` rather than the destination confirmed by that result. After
   a summary succeeds in R and memory processing fails, let Retry discover
   that R was deleted, then pick T. The "What was kept" list immediately says
   **"Summary saved to T"**, while no request has been sent to T. The user can
   press Done with that false success message still visible. `resultPack`
   tracks the confirmed ID for retry routing but does not protect the display
   context. Snapshot the confirmed destination's display data with the result;
   changing a future retry target must not rewrite a past outcome. Only a new
   confirmed result should claim a summary was saved in the new destination.

   **Independent reproduction:** the real save prompt in hidden Electron,
   fake bridge recording every call, summary `done` / memory `failed` at
   "Original role"; the Retry pre-check returns null; select "Replacement
   role" without pressing Retry again. There is still exactly **one**
   `session.remember` call, yet the confirmed-results list says "Summary saved
   to Replacement role". The check fails on this commit at that assertion.

**Independent verification:** full unit suite **1,186 passed, two skipped**;
typecheck and production build pass. All **45 submitted renderer checks pass**
(seven Cue Card, 21 history/save, six keyboard/draft, 11 start/resume), including
the original findings' new regression cases. The added real-persistence
history check and hidden-renderer result-label check fail on the submitted
production source; a linked-answer positive control passes. No real audio or
external provider calls were used. The engineer's reported real-app checks
were not repeated in this review; full smoke/data-integrity repair, live
acceptance, platforms and performance remain M7 work.

**Next authorized work: these two M6 corrections only**, with regressions
against `f429da1`, then resubmit a focused correction commit and full check
results. M1–M5 stay accepted; M7 stays queued. No push, version bump or release.
Temporary reviewer tests were removed; only this board remains edited and
uncommitted.

### M6 correction-2 review — `8f86057`: accepted

Both remaining findings are resolved without widening production scope:

- **Cleared answers stay cleared.** The repository excludes linked answer
  copies whenever a current answer record exists, including an empty record.
  The timeline likewise falls back to an older card only when the answer
  record is absent. The real-persistence regression reproduces M3's paused
  correction writes and verifies the corrected wording has no stale answer;
  the separate timeline check covers the same rule even if the card reaches
  the renderer. Positive controls retain normal deduplication and genuine
  missing-record recovery. Standalone quick-Ask coverage remains passing.
- **Confirmed result labels stay fixed.** `resultSpace` is captured alongside
  the result and its destination ID, and cleared for a new prompt. Picking a
  future Retry target does not change the confirmed summary's location. The
  renderer regression checks the original title with exactly one remember
  call, then verifies that a successful Retry names the new destination.

**Independent verification:** full unit suite **1,189 passed, two skipped**
(110 passing files, one skipped file); typecheck and production build pass.
All **46 submitted renderer checks pass** in one run: seven Cue Card, 22
history/save, six keyboard/draft and 11 start/resume. These include the earlier
M5 race cases, all four original M6 findings and both correction regressions.
No new M6 blocking finding was identified. Only this board was edited by the
reviewer; no production changes, commit, push, version bump or release.

The renderer tests use hidden Electron and a recording fake bridge; the
paused-correction regression uses the real schema and persistence calls, not
live audio. This review did not repeat the engineer's reported real-app
history/start-flow tests. It establishes neither the full E2E suite nor live
audio/model, latency, retained-memory, macOS or screen-reader acceptance.
Those limitations remain in M7; accepting M6 is not release approval.

### M7 handoff — finish one evidence checkpoint at a time

M1–M6 stay accepted. Preserve their behavior and regression coverage. Complete
M7 in the following order, returning each checkpoint for review before moving
on. **M7.1 is now accepted; the next authorized work is M7.2a only.** No broad
UI redesign or scheduler/provider/grounding rewrite is requested. M7.2 is
split into the model-clarity, interview-speed and integrated checkpoints in
the tracked follow-up section below; complete them in order.

1. **M7.1 — a trustworthy offline regression baseline.** Repair the stale
   `e2e/smoke.spec.ts` expectations and onboarding/fixture setup for the current
   Home, Settings, Library and interview flow. Resolve the data-integrity
   spec's dependency on parsing under a blocked network: an offline DB/FK
   check must not depend on a live provider succeeding. Preserve its real
   main-process/SQLite assertions; keep live parsing in an explicitly separate
   live tier rather than deleting assertions, skipping failures, or weakening
   the default tier. Use isolated user data, explicit no-key setup for all
   providers, blocked outbound traffic and capture refusal; verify that the
   offline run opens no real microphone, call-audio or screen stream. Retain
   all 46 renderer cases and the real-app history/start-flow checks. Run the
   complete intended offline E2E tier plus unit/typecheck/build, reporting
   exact pass/fail/skip counts and commands. Update E2E documentation to match
   actual coverage. Return one focused commit with any remaining failures
   explained; this checkpoint has no live audio or paid model run.
2. **M7.2 — integrated interview and measured performance (queued).** Start
   with M7.2a (AI-01), then M7.2b (PERF-01), returning each for review; the
   remaining integrated checks are M7.2c. After
   the baseline passes review, exercise the named reference configuration
   with controlled interview audio and real providers: start, split questions,
   candidate replies, follow-ups, topic changes, manual Ask during automatic
   generation, Pause/Resume, capture failure/recovery, Stop/Keep, history and
   resumed recall. Check answer grounding in the actual resume, JD and spoken
   context, with generated suggestions kept separate. Measure independent
   held-out precision >=95% and on-time recall >=90%; report eventual recall
   separately. Measure final-to-decision p95 <=1.5 s and final-to-first-visible
   p95 <=3 s with full retrieval and actual overlay paint, not token timing as
   a substitute. Include counts, misses, cold/warm results, hardware, STT,
   provider/model and settings. Measure persisted-recall latency, model usage/
   cost and retained heap including the archive cache for long sessions and
   Stop/Resume. The earlier rules-only held-out recall of 0.850 and old
   no-retrieval token timings do not satisfy these gates. Unmet or unmeasured
   targets remain open; do not retune and score on the same holdout.
3. **M7.3 — release-readiness review (queued).** Consolidate the integrated
   evidence, remaining privacy/capture and keyboard/accessibility checks,
   supported-mode regressions, platform coverage and known limitations.
   Declare unavailable hardware/platform checks explicitly. Return the final
   acceptance report for review; do not infer release approval from passing
   unit/renderer checks alone.

Keep test capture and external processing explicit and observable. Use test
fixtures and controlled audio for evidence; never open the machine's live
audio as an accidental screenshot/test side effect. No push, version bump,
packaging release or publication is authorized by this handoff.

### M7.1 review — `e20680a`: changes required

The baseline repairs are sound: first-run versus returning-user setup is
explicit, smoke checks exercise the current flow, database/FK assertions
remain real, model-policy tests no longer pin retired model IDs, and live
provider tests are separated from the default tier. No production code
changed. Preserve this work and all 46 renderer cases. Two isolation gaps
still prevent accepting the guard's offline/capture guarantees:

1. **[P2] The network guard permits unlogged requests outside its own
   allowlist.** In `offline-guard.cjs:37`, splitting a hostname at `:` turns
   IPv6 addresses starting with `::` into an empty string, which is accepted
   as local. This includes IPv4-mapped IPv6 addresses; the same classification
   also accepts mapped non-loopback IPv4 addresses. Independently, the fetch
   wrapper (`:44–56`) checks only the initial URL, then delegates automatic
   redirects to the original fetch, so redirect destinations are never checked.

   **Independent, local-only reproduction:** a target server bound to
   `127.0.0.2` (which this guard rejects directly), and a redirect server bound
   to allowed `127.0.0.1`. With the submitted guard loaded in Node, a direct
   target fetch is refused and logged. Both a fetch to
   `[::ffff:127.0.0.2]` and a fetch to the allowed server that redirects to the
   target succeed: **two target hits**, but only the direct refusal appears
   in the log. All actual traffic stayed on loopback; no public host was
   contacted. The non-loopback consequence follows from the same hostname
   normalization and redirect delegation, not from an external test run.

   Normalize hosts without destroying IPv6 addresses, apply the intended
   loopback policy consistently, and refuse redirects or validate every hop.
   Add safe local/fake-transport regressions for both bypasses and an allowed
   loopback control. The successful bypasses currently leave no grant entry,
   so the fixture's existing log check cannot detect them.

2. **[P2] Native screenshot capture is outside the capture guard.**
   `offline-guard.cjs` replaces media permission/display handlers and page
   media APIs but never intercepts `desktopCapturer.getSources`. The real app's
   `capture.region` IPC calls `captureScreen`, which uses that API with a large
   screen thumbnail (`services/capture/screenshot.ts:30`); the region selector
   uses the same path. No provider key or media permission is needed to reach
   it. A future test or accidental capture action can obtain a real screenshot
   with no guard entry, despite the claimed refusal of screen capture.

   **Independent reproduction without capturing the screen:** evaluated the
   submitted guard against a fake Electron module. Confirmed attachment and
   the positive control (`media` permission refused and logged), then invoked
   `desktopCapturer.getSources` with the production screenshot options. The
   original fake capture transport was called once and returned its source;
   there was no screenshot-refusal entry. No real Electron capture or image
   was obtained in this probe. Intercept this native capture entry point in
   the offline guard, refuse before calling the real API, and record the
   refusal. Add a safe transport-level regression plus coverage of the real
   capture IPC after the refusal is installed.

**Independent checks:**

- `npm run test:e2e`, with `E2E_CAPTURE` unset and a separate CDP port:
  **61 passed, zero failed, zero skipped**. Its typecheck and production build
  pass. All seven smoke, three data-integrity, two guard, the error/history/
  start-flow checks and 46 renderer cases are included.
- Full unit suite: **1,189 passed, two live evaluations skipped**.
- Inspected the run's guard logs: six refused Anthropic fetches and one
  refusal each for page getUserMedia/getDisplayMedia, matching the submission.
  These logs establish the covered denials, not absence of the bypasses above.
- Listed (did not execute) the live config: one test in `live-openai.spec.ts`.
  No paid live run, real audio, native screenshot or opt-in media/audit run
  was performed by the reviewer. The two extra guard probes fail the expected
  isolation assertions; their respective allowed/denied controls work.

**Next authorized work: correct these two guard paths within M7.1**, retaining
the repaired test suite and adding the targeted isolation regressions against
`e20680a`. Return one focused correction commit with full offline/unit/build
results and guard evidence. M1–M6 remain accepted; M7.2/M7.3 stay queued. No
production redesign, live model/audio work, push, version bump or release.
Temporary reviewer probe scripts/log were removed; only this board remains
edited and uncommitted.

### M7.1 correction review — `178026d`: accepted

Both P2 findings against `e20680a` are resolved. No new blocking finding in
this checkpoint. Host normalization preserves IPv6, Node redirect attempts
are checked at the socket, and the native screenshot API is refused before
the real transport runs. The commit changes test infrastructure/docs only;
the separate uncommitted UI patch was preserved throughout the review.

**Independent evidence:**

- `npm run test:e2e`, with capture/live-evaluation overrides unset and separate
  app/harness CDP ports: **72 passed, zero failed, zero skipped**. This is the
  submitted 64-case offline tier plus the eight already-present uncommitted
  popover cases. Both typechecks and the production build pass in that run.
- `npm test -- --reporter=dot --maxWorkers=1 --minWorkers=1`:
  **1,189 passed, two live evaluations skipped** (110 passing files, one
  skipped). The rules-only held-out recall remains 0.850; this is not live
  detection acceptance.
- Re-ran the two safe regression probes with the old guard extracted from
  `e20680a`: **both fail as expected**. Four HTTP requests reach the forbidden
  loopback target (both mapped spellings, redirect and mapped HTTP); the fake
  screenshot transport is called once. The same probes pass with `178026d`.
  The real-app capture IPC was tested only with the corrected guard and
  rejects before a screen image is produced.
- The current full run has **five guard log files, 17 entries, zero grants**:
  six refused provider fetches, six refused network-probe attempts, two page
  media refusals, two native screenshot refusals (fake + real-app IPC), and
  the fake permission refusal. Attempt details match the submitted evidence.
- Independently tested the previously unverified Chromium redirect path in
  a hidden, isolated Electron harness. `electron.net.fetch`,
  `electron.net.request`, and renderer `fetch` each follow an allowed
  `127.0.0.1` redirect toward the forbidden `127.0.0.2` test target: all three
  reject, all three refusals are logged, **zero target hits**. Their three
  allowed-loopback controls each return 200. All actual traffic stayed on
  loopback; the probe loaded no app data or capture APIs. This was a temporary
  reviewer probe, not a new permanent Chromium regression in the commit.

The temporary reviewer scripts were removed. No live provider request, real
audio, desktop image, opt-in capture/audit suite or other platform was
exercised; those remain in the applicable later checkpoints. Only this board
was persistently edited by this review, with existing source/docs edits intact.

**Next authorized work — M7.2a only:** address AI-01 using the task-specific
model-clarity contract below, and integrate the existing UI-01/UI-02 patch
with its eight tests. Use the real routing policy and recorded fake adapters
to reconcile configured, effective, attempted and successful models; use the
real renderer to prove the right task is named and refreshes correctly.
Do not force General answers to use the coding solver just to make two
labels match. Return one focused commit with regression evidence, full
offline/unit/typecheck/build results and limitations. M7.2b performance
optimization/measurement, M7.2c and M7.3 remain queued. No push, version bump
or release is authorized.

### M7.2a review — `3557fa9`: changes required

The task distinction, shared policy/picker, captured coding route, per-answer
provenance and actual-attempt latency metadata address the main routing and
labeling gaps. The prior UI-01/UI-02 patch and its eight regressions are now
committed. Keep those changes. The independent standard checks pass:

- `npm run test:e2e`: **76 passed, zero failed or skipped**, including the
  production build and typechecks, the four new model-label cases and all
  eight popover cases.
- `npm test -- --reporter=dot --maxWorkers=1 --minWorkers=1`:
  **1,197 passed, two live evaluations skipped** (111 passing files, one
  skipped). The five adapter-boundary tests are included.

Additional controlled tests against the real Overlay in the existing hidden
Electron renderer harness found two blockers. Vendor replies/settings are
fake; capture/media remain refused. No real provider, audio, desktop image,
app database or other platform was exercised.

1. **[P1] A delayed settings read can undo a newer model choice, including
   writing it back to persistence.** `Overlay.tsx:103–109` unconditionally
   applies each `settings.get()` reply, while the settings push at lines
   272–274 does not invalidate older reads. The modal has the same race at
   `overlay/panels/SettingsModal.tsx:43–49` and `:91–96`. Reproduction: hold an
   existing read, push a newer snapshot, confirm the new model is displayed,
   then release the older snapshot. The Interview answers chip changes from
   the new Haiku route back to Sonnet; in the modal, the new Anthropic solver
   choice changes back to GPT-6.2 Astra. Both regressions fail on this commit.

   This is more than a stale label. After that modal sequence, change only
   Reasoning effort to High. Even when the fresh read inside `saveCoding()`
   returns the current Anthropic choice, lines 111–124 merge the old local
   `codingModel` into it and submit
   `{ models: { coding: 'gpt-6.2-astra' }, reasoningEfforts: { coding: 'high' } }`.
   The additional write-level assertion fails: an effort-only edit restores
   the previous model/provider without a new model selection.

   **Correction:** make initial/reload replies and save completions respect
   newer settings events and user choices, including modal close/reopen.
   Changing effort must preserve the current model; changing the model must
   preserve the current effort. Update only the field being edited against
   current settings. Cover both delayed-read paths, the effort-only write,
   and out-of-order read/save completion. Check the dashboard's analogous
   settings refresh path while applying the same ordering rule; this review
   directly reproduced the two Cue Card paths, not a dashboard failure.

2. **[P2] Full provider catalogs still clip outside compact windows.** The
   list at `renderer/components/ui.tsx:600–601` combines a maximum width with
   `min-w-max`; the intrinsic minimum wins. The one-time horizontal shift at
   lines 505–514 cannot fit a list wider than the viewport. With both OpenAI
   and Anthropic keys represented, open More → Interview answers model:
   the list measures **495.36 px wide**, at **x = -28 px in a 467 px window**
   and **x = -117 px in a 360 px window**. Both bounds assertions fail. The
   1,100 px positive control passes. The existing compact popover fixture
   lacks configured provider keys, so it does not expose this catalog size.

   **Correction:** constrain the actual list and option content to the
   available width, with readable wrapping/truncation and reachable choices.
   Recompute placement when the open list or viewport changes. Add full-key
   catalog bounds checks at 360 and 467 px, a wide control, and resize while
   open. Retain keyboard selection, outside dismissal, nested Escape,
   click-through and all eight existing popover regressions. This is UI-03;
   it does not invalidate the separately passing UI-01 tooltip fix.

Across the additional final probes, five distinct regression cases fail
(two stale-read displays, one wrong-model write, two compact catalog bounds);
the wide-window control passes. Temporary reviewer source was removed.
Only this board was persistently edited during review. No performance or
live-model conclusion follows from these offline checks.

**Next authorized work:** one focused M7.2a correction commit for these two
findings, with failing-before/passing-after regression evidence and the full
offline/unit/typecheck/build results. Preserve same-provider retries, captured
attempt routes, saved provenance and the integrated UI polish. Return for
review before M7.2b; M7.2c/M7.3, push, version bump and release remain queued.

### M7.2a correction review — `084cd07`: one correction required

**Both findings from `3557fa9` are resolved.** The shared settings feed keeps
older Cue Card/modal replies from replacing newer applied snapshots or edits;
one-field model/effort writes are merged synchronously in main instead of
rewriting a renderer's stale maps. The full catalog now fits the compact
windows, wraps its rows and is repositioned on resize. Keep these fixes and
the existing route/provenance/privacy behavior.

Independent checks on `084cd07`:

- `npm run test:e2e`: **84 passed, zero failed or skipped**, including build
  and both typechecks. All four settings-order and all four catalog-bounds
  regressions pass, alongside the prior model labels and eight popover cases.
- `npm test -- --reporter=dot --maxWorkers=1 --minWorkers=1`:
  **1,207 passed, two live evaluations skipped** (114 passing files, one
  skipped). All ten new feed/merge/dashboard-store tests pass.
- Additional temporary guarded real-app probe: **passes**. Concurrent
  `modelOverrides` and `effortOverrides` reach the actual settings IPC and
  isolated SQLite database; the current answer, coding, embedding and effort
  values survive, and clearing only the answer leaves the other keys intact.
  No configured provider key or external request was needed.

**Remaining [P2] AI-02 — a dashboard settings push discards an unsaved model
choice.** `dashboard/pages/settings/ModelsPanel.tsx:157–160` replaces the whole
local `overrides` draft and clears `dirty` whenever `settings.models` changes
identity. Main supplies a newly read map on every settings push, even when
the saved model values did not change. The corrected dashboard feed/store
orders snapshots but does not preserve this component's edited fields.

The temporary reproduction mounts the real ModelsPanel and real settings
store in the hidden renderer harness, with the same push-to-`receive`
subscription as `dashboard/App.tsx:129`. Only the preload bridge is fake:

1. Open Advanced and choose **Claude Haiku 5.5** for Interview answers,
   without pressing Save. The picker confirms the choice.
2. Push a new settings snapshot with the same stored model overrides and a
   changed classifier route, representing an unrelated discovery/failover
   update. The draft resets to **Default — Claude Sonnet 5.5** and Advanced
   closes. An unrelated settings write from the other window likewise
   produces a new models-map identity through the actual main handler.
3. Reopen Advanced and press Save models. The recorded request is
   **`{ modelOverrides: {} }`**, rather than the chosen Haiku override. The
   assertion fails; the panel can report “Models saved” after losing the
   user's edit.

This remaining dashboard behavior was not exercised by the submitted store
ordering tests, which contain no ModelsPanel draft. It is a gap in the same
settings-synchronization acceptance path, not a regression in the corrected
main merge or a reason to undo the two resolved fixes.

**Next authorized work:** one focused M7.2a correction preserving edited
per-task drafts across incoming settings snapshots while refreshing untouched
tasks. Reconcile/clear edited keys on confirmed Save or explicit Reset, with
newer edits protected from an older save completion. Add renderer regressions
for an unrelated push before Save and for another task changing while the
answer task is edited; assert the actual Save payload and retention of the
other task's new value. Keep the four settings-order, four catalog-bounds,
model-label and eight popover cases. Return failing-before/passing-after
evidence and full offline/unit/typecheck/build results before M7.2b.

The temporary reviewer source was removed; only this board was persistently
edited. The extra dashboard check uses the actual panel/store with a fake
bridge, not the complete app shell. The merge probe uses the real app with
an isolated test database and the offline guard. No live provider, real audio,
desktop image, macOS or screen reader was tested. PERF-01 remains for M7.2b;
M7.2c/M7.3, push, version bump and release remain queued.

### M7.2a correction 2 review — `8d0c24d`: accepted

**AI-02 is resolved; no additional blocking finding in this correction.**
`ModelsPanel` merges incoming values only into untouched tasks and keeps a
sequence for each edited draft. Save writes only edited tasks and clears
only the versions it confirmed; a newer edit survives an older completion.
Advanced no longer closes on an unrelated snapshot. Empty Save writes
nothing, and a rejected Save retains the drafts. This preserves the prior
field-level main merge, settings ordering, route labels and provider limits.

Independent evidence:

- The engineer's four `models-draft.spec.ts` cases pass on the committed
  tree, before toolbar integration. They assert actual Save payloads for
  unrelated pushes, another task's update, a newer edit during Save, and an
  empty Save.
- After integrating only the separately requested UI-04 renderer changes,
  `npm run test:e2e -- --output=test-results/toolbar-integrated` passes:
  **92 passed, zero failed/skipped**, including typechecks and production
  build. This comprises the engineer's 88 cases plus four new layout cases.
  All settings-order, catalog, model-label, popover and guard cases pass.
- `npm test -- --reporter=dot --maxWorkers=1 --minWorkers=1`:
  **1,207 passed, two live evaluations skipped**, across 114 passing files.
- `git diff --check` passes. The correction's production source was not
  changed during review. No real provider, device or desktop capture ran.

**Next authorized work: M7.2b (PERF-01) only**, following the baseline,
instrumentation, optimization and evidence requirements below. M7.2c and
M7.3 remain queued. This acceptance neither measures interview speed nor
authorizes a release, push or version bump.

### UI-04 implementation — Cue Card toolbar/layout (Codex, working tree)

Implemented at the user's explicit request while away, separately from the
engineer's AI-02 commit. This is Codex's own implementation and verification,
not an independent review of another engineer's UI submission. Seven renderer
files, `e2e/cue-toolbar.spec.ts`, and documentation are uncommitted in the main
working tree on `8d0c24d`; do not overwrite or fold them into the accepted
AI-02 commit.

The toolbar has consistent control sizes, grouped Privacy/click-through,
visible Pause/Resume and Stop labels, and status/company on two lines.
More uses a bounded scrollable popover with grouped style/model, tools and
grounding; optional notes start collapsed. Ask is one anchored surface.
The model list stays in the protected window and escapes the panel's scroll
clipping through viewport positioning. Existing task labels, provenance,
actions, outside dismissal, nested Escape and click-through behavior remain
covered by passing regressions.

Four added cases cover 360/467 px widths, the minimum 240 px height, manual
Ask/Pause/style/solve actions, and a keyboard model choice in a short coding
window. All 27 focused checks and the integrated 92-case tier pass. Fixture
previews at 360/467 px were visually inspected; they use fake content only.
The new layout has no real-audio/provider, macOS or screen-reader validation.
PERF-01 and the existing M7.2c/M7.3 evidence are still open.

### M7.2b review — `cee0adc`: changes required

The bounded query embedding, parallel document/memory gathering and richer
terminal records are useful improvements. The before/after simulation is
explicitly offline and does not establish the live targets. The 90-case
commit-only run and 94-case integrated run are consistent with the four
uncommitted toolbar cases. Keep these changes while addressing three issues.

**1. [P1] Prefetched memory bypasses a later opt-out.**
`engineSession.ts:709–712` takes `gathered.memories` and marks them used
without checking the current memory permission. Previously recall happened
after the final and read the current global/Space consent. Now an interim
can finish recalling approved memory, the user can turn memory off, and the
final still sends the cached memory to `mode.generate` and includes it in
the outgoing-context event.

Independent real-engine/retrieval/recall probe, with simulated vendors:

1. Prefetch “How did you scale the payments service at your last company?”
   while memory is enabled; allow its 700 ms embedding to complete.
2. At 1.2 s, disable `memory_enabled`, then submit the same final.
3. Expected: the generator receives no memories and `m1` is not marked used.
   Actual: the generator receives `m1`, including its content.

The same probe passes when only EngineSession is replaced with `8d0c24d`'s
source. The control (disable memory before a non-prefetched final) passes
on both. Revalidate permissions and current eligible memory at consumption/
dispatch; do not reuse revoked, deleted or otherwise disallowed memory.
Cover global and Space opt-outs, and a memory removed after prefetch, while
keeping allowed prefetch fast and discarded prefetch free of mark-used writes.

**2. [P2] Stop silently removes already detected questions from the sample.**
`latency.begin` is called only when `answerScheduled` starts (line 384),
or when `surfaceMissed` eventually displays a missed card (line 453).
`QuestionScheduler.stop()` drops waiting jobs without either path. A missed
card deferred behind a stream can similarly be discarded on teardown before
its timing record is created.

Independent engine probe: start question A, advance 100 ms, submit distinct
question B and advance 10 ms so it is detected and queued, then Stop.
Expected: terminal records for both questions (A aborted, B cancelled/aborted
before dispatch). Actual: exactly one aborted record, for A; B is absent.
Start timing at the detection/job decision independently of card display,
and finalize every accepted job once on Stop, including queued and deferred
missed work. Keep reason/outcome counts explicit and test the denominator.
No new answer or card should be opened merely to record a stopped question.

**3. [P2] A stale renderer paint can be attributed to a newer take.**
`Overlay.tsx:182` schedules two frames carrying only contribution id and
the callback's eventual current time. Reset (line 213) clears the sets but
does not invalidate that callback. `metrics.ipc.ts:16` supplies no take;
the recorder's time check (line 253) accepts an old acknowledgement when
it arrives after the replacement's first token.

Independent real Cue Card renderer probe controls the animation frames:
flush “Old answer”, leave its acknowledgement pending, reset the same card,
start the replacement with only `**`, then release the old frames after the
new first-token time. The old text is confirmed absent. Actual: the callback
reports `metrics.firstUseful` and the real LatencyRecorder accepts that time
for the replacement, although it never received useful words. Its useful
paint should still be unset. Tie acknowledgements to the actual take/render
generation, invalidate outstanding callbacks on reset/clear, and reject old
reports even when their timestamp is later than the new take's first token.
Retain both existing useful-paint cases and add this controlled race plus a
valid replacement-paint control.

**Independent verification:** six submitted unit suites pass (64 tests).
The copied engine fixture adds two failing review cases and one passing
control; its five original cases still pass. Both supplied renderer cases
pass; the added stale-paint race fails. The consent probe and its control
both pass with only the prior EngineSession source substituted. No live
provider, real audio or desktop capture was used. Temporary runnable probe
files were removed from the source tree after saving exact copies under:

`C:/Users/Dev/.codex/visualizations/2026/11/18/01a1ec25-cf9f-7460-8b5a-84e60cef5585/`

- `m72b-engineSession.review.test.ts.txt` — copy to
  `src/main/services/engine/engineSession.review.test.ts` to run.
- `m72b-useful-paint.review.spec.ts.txt` — copy to
  `e2e/useful-paint.review.spec.ts` to run in the hidden renderer harness.
- Browser failure output: `test-results/m72b-review/`.

**Next work:** one M7.2b correction commit with failing-before/passing-after
regressions and appropriate full offline/unit/typecheck/build checks.
Preserve UI-04 and the accepted provider/scheduler/grounding contracts.
Return for review before M7.2c. Live General/Technical p50/p95, cold starts,
detection targets and coding performance remain unmeasured; the proposed
coding budget is a proposal, not an accepted result. The follow-up/long-JD/
30+ exchange fixtures still belong to this milestone's measurement coverage.
No need to ask the user again for routine corrections; the file handoff is
updated, but delivery to the idle Claude session is not verified.

### M7.2b correction review — `286920f`: three findings resolved; evidence still open

**The correction is accepted for the three findings from `cee0adc`. No
additional blocking finding in this focused correction review. M7.2b is
not yet accepted as a milestone, and M7.2c is not opened.**

- **Memory:** `revalidateRecalled` checks global and Space consent again,
  intersects prefetched IDs with the current eligible scoped rows, and uses
  their current text. Errors return no memory. The call precedes the outgoing
  context, mark-used writes and answer request. Global/Space opt-outs,
  deleted/ineligible and edited memory, plus allowed/no-prefetch controls,
  pass in the real-engine/recall tests with simulated vendors.
- **Stop:** queued jobs produce aborted-before-dispatch records through the
  scheduler hook; deferred missed jobs are recorded at teardown. The tests
  assert exactly two records for two detected questions and no extra card.
  Abort after context loading is checked before building the provider request.
- **Paint ownership:** main sends the take before the stream; the renderer
  returns that take and invalidates old reset generations at both frames.
  Main rejects old or missing takes. The held-frame race now sends no old
  report; the replacement's own useful words report the current take and are
  accepted. Existing Markdown/bullet cases also pass.

Independent verification on the integrated working tree:

- Eight focused unit suites: **170 passed** (engine latency, recorder,
  scheduler, engine scheduling, failover, memory, live embedding and pipeline).
- Production build and both typechecks: **pass**.
- `useful-paint`, `cue-toolbar`, `popovers`: **16 passed**, including the two
  new paint cases, four toolbar checks and all eight popover cases.
- `git diff --check`: **pass**. No reviewer production changes, live provider,
  device or desktop capture were used in this review.

The engineer's reported full runs are **1,241 unit passes / two live skips**,
**96 integrated E2E passes**, and **92 commit-only E2E passes**. The four-case
toolbar difference remains correct. The reported commit-only unit run had
1,240 passes and three skips before its build; the extra build-dependent skip
is explicitly disclosed. These full runs were not repeated in this focused
review. The simulation confirms **30 embeddings per category, 60 overall**;
the docs table's per-category label has been clarified.

**Next authorized engineer work — finish M7.2b evidence preparation:**

1. Add the outstanding follow-up/topic-change, long resume/JD and 30+
   exchange/archived/resumed measurement fixtures. Assert the expected facts,
   sources and retained context; include no-interim and stalled-embedding
   variants. Keep General and simple Technical samples separate.
2. Prepare a reproducible benchmark runner/export with the real retrieval,
   memory and renderer paint path, stable fixture IDs, stage/outcome/route/
   effort/context-size data, cold/warm splits and explicit failed/unanswered
   samples. Offline runs must remain clearly simulated; do not infer live
   p50/p95 from them or shrink the knowledge base to meet the target.
3. Submit a concrete live run plan: synthetic data, exact provider/model/STT
   and reference configuration, >=30 warm General + >=30 warm simple
   Technical questions, >=5 fresh-process cold runs, request/token/cost caps,
   commands, time limits and evidence paths. Keep any real-audio setup and
   permissions explicit. Prepare this before seeking live-run approval;
   there is useful independent work now, so do not wait for the user to relay
   another routine go-ahead.

Targets remain warm final-to-first-useful-paint p50 <=1.5 s / p95 <=3 s per
category and final-to-decision p95 <=1.5 s, with full grounding. Coding's
budget remains proposed and unmeasured; manual Ask/regenerate/solver timing
is not covered by this correction. M7.2c still owns the remaining integrated
audio/detection/recovery/recall-cost checks and M7.3 the release gate.

**Reported limitation retained as CTX-01:** document content cached before
deletion is not revalidated at answer dispatch. This predates the memory
consent correction and is not closed by it. Record it for the integrated
grounding/lifecycle review in M7.2c; establish the required deletion behavior
and a regression there. No new finding about cross-profile data is implied.

Preserve the uncommitted UI-04 files. No push, version bump or release.
The current engineer handoff is updated; direct delivery to the idle Claude
session remains unverified.

### M7.2b evidence review — `c9d225b` accepted; `74f12cd` changes required

**The "Tell me about…" prefetch fix `c9d225b` is accepted.** The submitted
prefetch regression and real-engine fixture benchmark pass independently.
Interview rules are consulted only in scheduler/Q&A modes; the dangling
fragment guard and ambient behavior remain covered. The prior three findings
remain resolved at `286920f`.

The offline fixtures and clearly simulated results are useful, but **the
live driver/report in `74f12cd` require corrections before live-run approval**.
No paid call, live STT, audio device or capture was used in this review.

**1. [P2] A late question's record is relabelled as the current fixture.**
`e2e/live-perf01.spec.ts:102–135` remembers the file's row count, waits for
any new row, then attaches the current fixture id to `rows.at(-1)`. It does
not correlate the record with that fixture's transcribed question/card/take.
A previous timed-out answer arriving while B's audio is sent can therefore
become B's measured answer. Multiple finals/takes can also write more than
one row, of which only the last is retained by the collector.

An offline probe executes the actual `ask` function, with the Page/provider
edges replaced: a late `questionId: late-question-A` row arrives while fixture
B is being sent. Actual result: that row is returned with B's fixture id.
The normal one-answer collection control passes. Correlate fixtures with
their actual transcript/card/take lifecycle, preserve all raw records, and
quarantine/cancel/settle timed-out work so it cannot contaminate later samples.
Test late A during B, out-of-order completions, split finals and latest takes.

**2. [P2] The acceptance exporter judges row count instead of fixture validity.**
`metrics/report.ts:81` treats 30 warm rows as sufficient. The live runner
(`bench/perf01.report.run.test.ts:26–56`) does not validate the planned fixture
manifest, duplicate fixture labels, category membership or complete decision
evidence. Grounding failures are only appended to a list. Consequently the
export can show every target as met for an invalid run.

The actual `npm run perf01:report` was run on offline fake rows: 30 warm
General answers all labelled G01, 30 warm Technical answers all T01, five
cold rows per category, **70 grounding failures**, and no block-summary files.
It exits 0 and reports General/Technical sample counts, p50, p95, cold counts
and detection all **met**. Only one distinct warm fixture per category was
present; detection fell back to the question records.

Validate against a run/fixture manifest (run id, block, expected fixture and
cold-process identities), flag duplicates/missing/misattributed evidence,
and require grounding/configuration and all-turn decision evidence for live
acceptance. Retain measured latency as diagnostics if useful, but expose an
explicit invalid/incomplete verdict so those rows cannot imply acceptance.
Keep every expected unanswered fixture in the denominator. Add a valid
complete-run control alongside incomplete/duplicate/grounding-failed cases.

**3. [P2] The advertised token cap is not enforced at the end of a block.**
`live-perf01.spec.ts:101` checks the previous total only before starting a
question; line 138 increments it without checking again. A final or single
cold question can exceed the limit and the whole block still succeeds.
An offline probe runs the actual `runBlock` with a one-token cap and a
two-token answer. It resolves successfully, writes the summary and stops
normally; the expected cap error never occurs.

Additionally, only the chosen answer record's usage is added. Setup parsing/
embeddings, classifier/follow-up calls, and requests without usage are outside
that accounting, while the proposed paid volume includes them. Setup is
repeated for all twelve fresh-process blocks, not just once. Correct the
cap/stop behavior and define a complete conservative budget (or accurately
bounded separate budgets) before requesting approval. Reserve bounded work
before dispatch, treat unknown usage explicitly, check limits on every
completion and block boundary, and always preserve evidence/stop the session
on cap/failure exits. Update the run plan's total volume and caps accordingly.
Test the final-question cap, cross-block accumulation, failed/missing usage
and auxiliary/setup work entirely offline.

**Independent evidence:**

- `npm run bench:perf01`: **six passed**, one opt-in report runner skipped.
  Full synthetic indexing, grounding, follow-up, 32-exchange recall, resume
  and archive cases pass, and the result is labelled simulated.
- Prefetch, recorder, report and catalog-effort suites: **57 passed**.
- Two offline driver probes fail; their normal-answer control passes. The
  driver was copied with only test registration removed and helper exports
  added; actual collection/cap functions ran against fake Page responses and
  synthetic local files. No app or vendor was started by these probes.
- The actual exporter reproduces the invalid-coverage verdict above.
- `git diff --check` passes. Temporary source probes were removed after
  saving exact copies in the session visualization directory:
  `m72b-prep-driver.review.ts.txt`, `m72b-prep-driver.review.test.ts.txt`,
  `m72b-prep-invalid-coverage-report.json`. The fake report inputs/outputs are
  in `bench-results/perf01/review-repeated-fixtures/`; these are reviewer
  probes, **not live evidence**.

The engineer's full 1,285 unit passes / three skips, clean typecheck,
96 integrated and 92 commit-only E2E passes are recorded as submitted;
those complete suites were not repeated in this focused review.

**Next authorized work:** one focused evidence-tooling correction with
offline regressions and a revised ready-to-review run plan. Do not change
the accepted prefetch/provider/scheduling fixes or overwrite UI-04. Include
preflight validation that the live reference configuration and required
visible second-monitor windows really hold; offline guard window placement
does not run in the live fixture. Return before any paid run or M7.2c.
PERF-01 targets remain unmeasured, coding remains proposed, CTX-01 stays open.

### M7.2b evidence correction review — `492a6cc`: changes required (2026-11-19)

The original late-A-during-B attribution case is fixed, duplicate/missing
fixture coverage and grounding failures now invalidate reports, and the
request meter refuses the tested over-cap requests before sending them.
Setup runs once, and the revised plan includes parsing and auxiliary work.
These improvements are retained. No live calls, app session, audio device or
capture was used in this review. Three P2 issues remain in the evidence path:

1. **A failed preflight passes its Playwright test.** In
   `e2e/live-perf01.spec.ts:302–306`, the failed-preflight branch writes
   not-run lines and returns from `runBlock()`. Its `finally` does stop and
   preserve evidence, but the return skips the assertion at line 377. An
   actual-driver probe with a wrong answer model records `preflight-failed`,
   calls Stop once, and resolves successfully. Consequently the serial suite
   may continue into later paid blocks instead of stopping as the plan says.
   Fail the test after cleanup on every unsuccessful preflight; add a driver
   regression and a serial-run check that later blocks do not execute.

2. **An old completed take hides its in-flight replacement.**
   `perf01.collect.ts:116,131,160` only sees completed rows and considers a
   question settled once *any* non-superseded outcome exists for its ID.
   A genuinely completed take 1 remains in the raw file when a correction
   starts take 2. Collection immediately selects take 1 and `settle()`
   immediately returns true while take 2 is still running. The driver writes
   this sample once and does not reconcile it from the final raw evidence.
   This can report the old wording's fast paint instead of the corrected
   answer, and start the next fixture behind work it believed was settled.
   A probe using the real LatencyRecorder confirms take 1 is returned while
   take 2 has no outcome; a separate settle probe returns at 0 ms rather
   than waiting for the replacement at 1,000 ms. Track current take/lifecycle
   and reconcile samples after quiescence. Check the real driver's saved row,
   final attribution, context and extra-question counts, not just a helper
   called after all rows have already arrived.

3. **The evidence gate does not compare the meter with the manifest caps.**
   `perf01.evidence.ts:298` checks only `meter.capped`, not numeric totals or
   the caps actually installed in each process. The checked-in valid-control
   fixture itself uses a manifest token cap of 1 and an uncapped meter with
   300,000 reserved tokens. The real `liveReport()` calls it valid and marks
   General/Technical targets met. This also matters to a reused output folder:
   the driver's line 397 retains its old manifest while the new environment
   can install different caps in the meter. Reject cap disagreement and
   over-cap totals; bind a resumed folder to its approved configuration or
   require a new run. Include token/request/STT/question totals and process
   coverage in the validation. Keep a complete within-cap control valid.

**Independent verification:** `npm run bench:perf01 -- --reporter=dot
--maxWorkers=1 --minWorkers=1`: 62 passed, one opt-in exporter skipped. Four
temporary offline probes fail on the issues above; two controls pass (latest
completed take selected with both rows present, complete within-cap evidence
valid). The preflight probe runs the actual driver functions with only Page,
files and bridge responses faked. No provider, Electron launch, synthesizer or
audio device is used. All temporary source helpers/tests were removed after
copies were saved to the session visualization directory:

- `m72b-492a6cc-driver.review.ts.txt`
- `m72b-492a6cc.review.test.ts.txt`
- `m72b-492a6cc-evidence.review.ts.txt`
- `m72b-492a6cc-over-cap-report.json`

Fake outputs under `bench-results/perf01/review-492a6cc/` are marked reviewer
probes, not live evidence. Reported full-suite and dry-run results are in the
overall status above; they were not independently rerun here.

**Next authorized work:** one focused correction commit for these three
issues, with failing-before/passing-after evidence and an updated live plan
where behavior changes. Preserve accepted production fixes and uncommitted
UI-04. No paid run is authorized; PERF-01 remains unmeasured. Keep strict
grounding and weak-attribution invalidation. Coding remains proposed,
CTX-01 stays open, and M7.2c/M7.3 stay queued. The prepared assignment is in
ENGINEER-HANDOFF.md; file availability is not proof of direct delivery.

### M7.2b evidence correction review — `e7a268b`: one new P2 (2026-11-19)

**The three previous findings are resolved.** Failed preflight now preserves
evidence/Stops and throws; a stopped-run guard prevents later blocks from
starting. Collection and settling follow the latest announced take, and
final reconciliation saves its own context and timing. Manifest binding
refuses reuse and validates cap totals, installed caps, process coverage,
refusals and ledger/request-log agreement. These fixes are accepted; they
are not being reassigned.

**[P2] Register the dry-only test so a live run does not launch its app.**
`e2e/live-perf01.spec.ts:175–176` requests the test-scoped `dashboard` fixture
and calls `test.skip(!CFG.dry)` inside the test body. Playwright must set up
the fixture before entering that body. In a live run this launches an app
process between the seed and the first warm block, then skips the body.
The app loads the meter and appends its PID, but it is neither the seed nor
a block. `perf01.evidence.ts:344` therefore correctly emits
`process-unexpected`, making an otherwise complete live run invalid. The
inverse runtime skips also launch unused warm/cold apps in dry mode.

Move conditional registration/skipping before fixture initialization in
both directions. Keep strict process coverage. Do not whitelist unexplained
processes, disable the meter, or use paid calls to test this correction.
Cover the live and dry registration paths with a fake launch fixture and
check that the intended tests alone initialize the app. Reuse the existing
driver/validator tests after this small correction.

**Independent evidence:** `npm run bench:perf01 -- --reporter=dot
--maxWorkers=1 --minWorkers=1`: **89 passed, one opt-in exporter skipped**.
An actual Playwright probe using only a fake test-scoped app fixture records
`[seed, dry run, warm]` for the current live registration shape; the expected
`[seed, warm]` assertion fails. A registration-time skipped control records
only its seed and warm fixtures and passes. Probe result: one failed, three
passed, two intentionally skipped. This launched no Electron, browser,
provider, synthesizer, audio device or capture. Temporary source/config files
were removed after saving copies in the session visualization directory:

- `m72b-e7a268b-runner.review.config.ts.txt`
- `m72b-e7a268b-runner.review.spec.ts.txt`

Outputs under `bench-results/perf01/review-e7a268b-runner/` are marked offline
review evidence. Submitted full-suite/dry-run counts are recorded in the
overall status; they were not repeated here.

**Next authorized work:** one small runner-registration correction with
offline failing-before/passing-after evidence. Preserve UI-04 and all
accepted fixes. No live run or paid-plan approval yet. PERF-01 stays open,
M7.2c/M7.3 stay queued, coding remains proposed and CTX-01 stays open. The
current prepared assignment is ENGINEER-HANDOFF.md; direct delivery has not
been verified.

### Windows preview review — `e721dc2`, `43b0d46`, `4823c52` (2026-11-19)

**Accepted for the user's local Windows preview interview.** The registration
finding is closed at `e721dc2`; live/dry test registration chooses the active
tests before fixture initialization, and no-key mode skips before launch.
The actual regression independently passes **15**, with **13 intentional
no-key skips**. No app/provider/audio/capture runs in that regression.
UI-04 is now committed at `43b0d46` with its existing verification retained.
The `4823c52` prerelease-aware What's New implementation and version identity
independently pass **3 unit tests**. No new product/benchmark scope is assigned.

**Submitted evidence:** clean typecheck, 1,369 unit passes, 111 offline E2E
passes (13 intentional no-key registration skips), two dry-run passes;
installer upgrade from published 2.2.2 retained synthetic data/settings and
applied the one migration with a pre-migration backup; an isolated copy of
the user's data opened; uninstall retained data; fresh install started cleanly.
These installation/full-suite checks are reported by the engineer and were
not independently repeated. The installer was independently located and
signature-checked, without running it (historical artifact, superseded by
the `1c75cd1` rebuild below):

- File: `release/BrainCue Copilot Setup 2.3.0-preview.1.exe`
- Size: 100,201,150 bytes; Authenticode: `NotSigned`.
- SHA-256: `31723AF631B3F97736396B4E0B2A1AD191DEDBF887B9507368D47BBE93848BF4`

**Small release-note corrections before external sharing** (not a new
application defect or a block on the current local interview):

1. `changelog/2.3.0-preview.1.md:58`: replace "3 s at worst" with the actual
   **p95 <=3 s** target, and "typically" with **p50 <=1.5 s**. A p95 is not a
   hard maximum; neither is verified live yet.
2. Lines 50–51: memory is revalidated **before an answer request is sent**,
   including prefetched memory. Turning it off cannot withdraw content
   already dispatched. Replace the claim about an answer already being
   answered with this precise boundary.

Commit the wording fix and rebuild before distributing, since What's New is
embedded. Record the new artifact hash then; the hash above identifies the
current installer. No repeated full install cycle is requested for wording
alone. Keep the preview limitations, and mark any eventual GitHub release
explicitly **prerelease**, never stable/latest; the current publishing config
defaults to a draft and does not itself guarantee a prerelease flag. No push,
tag, draft creation or publication is authorized by this review.

**Data incident and preservation:** the engineer disclosed that installed
2.2.2 briefly opened the real `%APPDATA%/braincue` before isolation, and its
backup was made afterwards. Reported integrity/count checks are recorded;
there is no pre-run snapshot proving that only preferences changed. Do not
repeat an old-version launch or restore over the user's active data. Codex
copied the supplied frozen backup out of the temporary folder to the
gitignored, local-only project path
`bench-results/private-backups/userdata-backup-20261119-121700/`.
**1,419 file hashes verified; zero mismatches.** The source was retained.
Do not attach either backup to releases or logs. The installed preview and
development app share the real user-data directory; avoid concurrent runs.

**Next check:** the user runs the installed preview through General/simple
Technical questions, a referential follow-up, earlier-speech recall, Stop,
history, Resume and final Stop. Afterwards inspect only that session/time
window's local timing records and captured/saved behavior. Record actual STT,
provider/model/effort, outcomes and sample count. A small on-device-STT run
can inform a limited preview decision; it cannot close the formal reference
PERF-01 gate requiring 30 warm per category plus fresh-process cold samples.
Do not begin an automated paid benchmark or capture the absent user's audio.
Coding remains proposed, CTX-01 remains disclosed/open, and M7.2c/M7.3 remain
open for formal/stable acceptance. Current instructions are in
ENGINEER-HANDOFF.md; direct delivery is not verified.

### Preview release-note correction — `1c75cd1` (2026-11-19)

**Accepted; no remaining release-note findings.** The wording-only diff
states the unmeasured targets as p50 <=1.5 s / p95 <=3 s, separately for
General and short Technical. Memory consent is rechecked before dispatch,
including prefetched memory; already-sent input cannot be withdrawn. The
notes also distinguish simulated-provider tests from live speed evidence.

The rebuilt installer was independently checked without running it:

- File: `release/BrainCue Copilot Setup 2.3.0-preview.1.exe`
- Size: **100,201,300 bytes**; Authenticode: **NotSigned**.
- SHA-256: `F1A2151B8B09B5BB563DAAD9E835D296A35191088E3A8FE66EAC1DF1DA263C69`

This replaces the earlier `31723AF6...` artifact recorded in the preceding
review. The engineer reports reinstalling this build and checking the
installed wording. Full install/upgrade/fresh-install tests were not repeated
for this wording-only change, as requested. `git diff --check` is clean.

The user-run interview is next; no further offline correction is assigned.
After the user confirms completion, inspect only that test's session/time
window and report timing counts, actual STT/provider/model/effort, per-question
outcomes and useful-word timing, and History/Resume behavior. A short test
supports a limited preview decision; PERF-01 and formal M7.2c/M7.3 remain
open. Nothing is pushed, tagged or published.

### Windows prerelease publication — user authorized (2026-11-19)

The user explicitly requested release after accepting `1c75cd1`. This
supersedes the prior no-push/tag/publication instruction for this one
**Windows 2.3.0-preview.1 prerelease**, not stable 2.3.0. The controlled user
interview has not happened; no latency target or formal gate is marked met.

Publish the verified installer, its matching blockmap, preview-channel
metadata and SHA-256 checksums. The release must be `prerelease: true` and
`make_latest: false`; retain v2.2.2 as stable. Do not upload `latest.yml` or
claim macOS/Linux coverage. The tag points to the reviewed application plus
release documentation/workflow changes; the binary remains the verified
`1c75cd1` build. Prerelease tags skip the three-platform stable publisher;
manual workflow builds and stable tags retain their existing behavior.

The stable release ritual (board reset and milestone closure) is deferred:
this is a preview within the current train, and M7.2b/PERF-01, M7.2c/M7.3,
CTX-01 and the coding budget remain open. Keep review history and the feature
branch; no merge into master is part of this preview publication.

**Published:** 2026-11-19 20:17:16 UTC, GitHub release `451879154`,
`prerelease: true`, `draft: false`, `make_latest: false`. Tag
`v2.3.0-preview.1` resolves to `78f7530a20f0c824441cebf41c203529e960dd02`.
The production build/typecheck passed before the release commit. All four
uploaded asset sizes and GitHub SHA-256 digests match the prepared manifest.
The release contains the Windows installer, matching blockmap, `preview.yml`
and `SHA256SUMS.txt`. No app code changed after the accepted installer build.

**Post-publication verification passed:** the public installer was downloaded
without authentication and matches all 100,201,300 bytes and the recorded
SHA-256. The GitHub latest-release endpoint still returns v2.2.2, with the
same stable asset IDs, sizes and digests as before publication. The tag's
Release workflow run `44606867768` completed as **skipped**; it built or
published no additional platform artifacts. Local verification evidence is
gitignored under `bench-results/release-2.3.0-preview.1/`.

### User follow-ups — model clarity, interview speed and Cue Card polish (2026-11-18)

**Latest user steering:** the user is away for several hours and authorizes
autonomous progress plus a Cue Card toolbar/layout polish. Codex implemented
UI-04 in a separate checkout (`braincue-toolbar` under the session's visualization
workspace), then integrated only its renderer files and new layout spec after
27 focused checks passed. The engineer's AI-02 correction is separately
committed at `8d0c24d`; it was not overwritten or bundled with the toolbar.
The integrated full offline run passes all 92 cases. Direct messaging to the
existing Claude session is not connected; the shared board is the handoff
record. The M7.2b/c/M7.3 acceptance targets
remain unchanged; real audio, paid/live runs, push and release stay explicit.

These reports extend the existing backlog. They do not replace earlier
requirements or reopen accepted M1–M6 wholesale. The engineer owns the
focused implementation; Codex reviews each checkpoint. No item closes on a
claim or screenshot alone: record the commit, regression evidence, measured
results where applicable, reviewer decision and remaining limitations here.

| ID | Priority | Report / evidence | State and checkpoint |
| --- | --- | --- | --- |
| UI-01 | P2 | The compact Cue Card cuts off the beginning of the “Answer that” tooltip. Reproduced at 467 × 462: the tooltip extended 111 px past the left edge. | Resolved in `3557fa9`; measured wrapping/placement and resize regressions independently pass. Preserve in the M7.2a correction. |
| UI-02 | P2 | Dropdowns stay open after outside clicks. Dialogs stop the bubbling dismissal event; click-through can forward the needed press to another app. More also lacked outside dismissal. | Resolved in `3557fa9`; capture-phase dismissal, nested Escape, blur, Settings handoff and click-through regressions independently pass. Preserve in the M7.2a correction. |
| UI-03 | P2 | The full OpenAI/Anthropic model catalog is 495.36 px wide and clips outside 360 and 467 px Cue Cards despite the new horizontal shift. | Resolved in `084cd07`; full catalogs, row bounds, keyboard/pointer reachability, resize and wide controls independently pass. Preserve in the remaining correction. |
| UI-04 | P2 | User requests a cleaner Cue Card layout and toolbar: the current dense, uneven controls look poor. | Accepted — Codex implementation committed unchanged at `43b0d46`. Consistent toolbar geometry, grouped secondary controls in a scrollable popover, one Ask surface; earlier focused/full offline verification retained and engineer reports 111 E2E passes at preview HEAD. |
| AI-01 | P1 | User sees `Default (gpt-6.2-astra)` in Cue Card settings and `GPT-4.1` in the General interview chip. The screenshot compares a **coding-solver setting** with the **live-answer selection**; it does not establish which model handled that answer. The distinction and actual route must be clear. | Resolved by `3557fa9` + `084cd07` with offline adapter-boundary, provenance, labels, stale-reply and field-level-write evidence. Real-provider performance remains separate. AI-02 tracks the outstanding dashboard draft gap. |
| AI-02 | P2 | An unrelated settings push clears an unsaved dashboard per-task model choice; Save then submits `{ modelOverrides: {} }` and can report success. | Resolved — `8d0c24d`, M7.2a accepted. Four real-panel regressions assert preserved drafts, refreshed untouched tasks, a newer edit during Save and the actual Save payload. |
| PERF-01 | P1 | User reports unacceptable response delays during general interviews and simple technical questions, while allowing more time for coding challenges. No duration can be inferred from the screenshots. | Open — implementation/tooling corrections accepted through `e721dc2`; `1c75cd1` limited Windows preview awaits the user's short interview. Formal live targets remain unmeasured; a short local-STT run does not satisfy the reference sample counts. |
| CTX-01 | P2 | Engineer reports that documents deleted after prefetch can still ground the next answer; document revalidation was outside the memory-consent correction. | Open — track in M7.2c's integrated grounding/lifecycle review. Establish the deletion contract and regression; this review does not claim it fixed. |

**Baseline inspection before `3557fa9`, retained as the reason for M7.2a:**

- `overlay/panels/SettingsModal.tsx` loads and saves `models.coding` and
  `modelDefaults.coding`; its model options are a separate hardcoded legacy
  list. This is not the General interview's answer setting.
- `lib/modelChoice.ts` maps General and Technical to `answer`, and coding
  interviews to `coding`. Its `currentModel()` uses the configured override
  or preset default. `ModelChip` displays that result; it does not use
  `AppSettings.effectiveModels`, which main already resolves per task.
- The actual answer route is captured in `engineSession.generateContribution`
  at dispatch and can change on its bounded same-provider retry. Existing
  latency metadata is seeded earlier in `answerScheduled`; it must not be
  treated as proof of the route of every attempt or the successful answer.
- The prior UI patch was then uncommitted: four renderer source files,
  `e2e/popovers.spec.ts`, and accompanying docs. It is now included in
  `3557fa9`; preserve it in corrections. At baseline, all
  54 renderer checks (46 existing + eight new), typecheck/build and diff
  whitespace checks passed. No real audio/provider run established model
  correctness or interview speed in that task.

**M7.2a — truthful, understandable model selection (one focused handoff).**

1. Reproduce the reported configuration without calling a live provider:
   General answers, simple Technical answers and the coding solver can have
   different models. Trace persisted selection → effective backend route →
   request attempt → what the UI says. Fix the confirmed discrepancy or
   stale-state path, rather than forcing different tasks to share a model.
2. Keep the normal UI concise: clearly name **Interview answers** versus
   **Coding solver**. The live chip must identify the relevant task and
   effective route. A coding-only setting must not appear to control the
   General answer. Use the shared provider/model policy and picker; remove
   the modal's separate legacy option list. Keep deeper explanations in
   details instead of adding repeated setup paragraphs or another picker.
3. Synchronize dashboard, live chip and settings after edits, override clear,
   provider/key changes and same-provider model failover. Distinguish the
   model configured for the next request from the model that produced an
   existing answer. An in-flight attempt stays pinned to its captured route;
   changing settings must not relabel that answer or send its data elsewhere.
   Capture actual provider/model per attempt and the route that succeeded,
   without keys or transcript text in diagnostic logs.
4. Supply adapter-boundary regressions proving which provider/model received
   each task, plus renderer checks showing consistent task-specific labels
   and refresh after a change/fallback. Retain M2 route pinning, readiness and
   retry limits. Integrate and review UI-01/UI-02 without discarding the
   existing working-tree patch; preserve its eight cases and all other
   renderer cases. Return for review before M7.2b.

**M7.2b — fast general and simple technical interviews (one focused handoff).**

Baseline findings from `8d0c24d`, before the M7.2b implementation: `LatencyRecorder`
persists a row only on `firstVisibleAt`; failed/unanswered attempts therefore
need an explicit terminal record and denominator. `decisionToGrounded`
currently combines queueing, retrieval and recall rather than attributing
them individually. The renderer acknowledges the first nonblank streamed
chunk, which can contain only Markdown syntax; verify actual useful visible
answer content for the acceptance measurement. Extend the instrumentation
before drawing a performance conclusion. Keep logs free of transcript,
answer text and keys. These are M7.2b measurement tasks, not evidence that
the latency target has been met.

1. Establish a baseline and attribute the delay before optimizing. Measure
   speech end → STT final, detection, queue wait, document retrieval,
   conversation/archive/memory recall, dispatch → first answer token,
   first useful answer painted, and answer completion. Include retries,
   aborts, timeouts, failures and unanswered questions; do not hide slow or
   missing answers by omitting them from the sample. Identify approximate
   local-STT speech-end anchors explicitly.
2. General questions and short technical explanations use the interactive
   `answer` path. A technical topic or the Technical style alone must not
   silently invoke the slow coding/deep-reasoning path. Automatic selection
   should favor measured responsiveness for this task on the chosen
   provider; preserve explicit user overrides and explain a slow custom
   choice briefly rather than silently replacing it or its provider.
3. On the named reference configuration, with the real retrieval/context
   path enabled, require **warm final → first useful answer painted p50
   <=1.5 s and p95 <=3 s**, separately for General and simple Technical.
   Keep **final → decision p95 <=1.5 s**. Use at least 30 warm questions in
   each answer category, report counts and p50/p95, and show cold starts
   separately (at least five fresh-process runs, with small-sample limits
   stated). Also report speech-end → first visible and completion timings so
   STT or excessively long answers cannot be hidden behind fast generation.
   A spinner, “thinking” label or empty card is not a useful answer paint.
4. Test the first question, follow-ups, topic changes, long resume/JD and
   30+ exchange/archived/resumed contexts. Preserve grounding, context recall,
   detection precision >=95%, on-time recall >=90%, scheduling and privacy.
   Do not meet latency by dropping the knowledge base, speech or questions.
   Report hardware, network/STT, request provider/model/effort, context/token
   sizes, sample counts, cold/warm split and stage timings. Before/after runs
   must use comparable fixtures and configuration.
5. Benchmark coding challenges separately: more reasoning time is allowed,
   with useful progress and cancel/retry behavior. Propose and justify its
   separate latency/timeout budget in the handoff; do not mix coding samples
   into normal-interview results or use coding as an excuse for slow short
   technical answers. Unmet interview targets remain open; do not weaken the
   target to declare completion. Return the optimization and evidence for
   review before M7.2c.

**M7.2c — remaining integrated evidence, then M7.3.** Finish the existing
controlled real-audio, held-out detection, grounding, interruption/recovery,
Stop/Keep/history/resume and persisted-recall cost/retained-heap checks above.
Reuse M7.2b evidence where configuration and behavior are unchanged; repeat
only affected checks. M7.3 remains the release/privacy/platform/accessibility
gate. M7.1 correction review → M7.2a → M7.2b → M7.2c → M7.3 is the order.
Adding these reports does not authorize paid/live runs, push, version bump
or release. M7.1 and M7.2a are accepted; the M7.2b code correction is accepted
at `286920f`, and the prefetch fix at `c9d225b`; evidence-tooling corrections
are accepted through `e721dc2`. The limited Windows `v2.3.0-preview.1`
prerelease is published, with user-run interview validation still pending;
this is not a completed M7 gate.
Controlled live
performance/audio measurements remain M7.2b/c evidence and must use an
explicitly authorized live setup; do not open the absent user's microphone
or call-audio capture to manufacture that evidence.

## Decision log

| Date | Decision |
| --- | --- |
| 2026-11-19 | User authorized publication of Windows `2.3.0-preview.1` with unmeasured live speed disclosed. Published as a prerelease; v2.2.2 stays stable. Formal PERF-01 and M7.2c/M7.3 remain open; no board reset or milestone closure for this preview. |
| 2026-10-07 | v2.2.2 is a patch train cut from user reports, not from the Roadmap; 5.2–5.5 stay unscheduled until the app has had real-world hours on 2.2. |
| 2026-10-07 | Answer styles collapse to **General \| Technical**: the question type is something the classifier knows, not something a user should set mid-interview. Performance and a clean Cue Card over configurability. |
| 2026-10-07 | Post-release work never continues on a merged release branch; every train starts its own branch from master. |
| 2026-11-17 | Interview Copilot becomes the primary feature: interview is the default activity and the first action, and its pipeline is what gets measured first. Other activities keep working unchanged. |
| 2026-11-17 | Model ids are policy data filtered by each account's own model list, not hard-coded defaults — a retired default (gpt-4.1-nano) silently disabled detection for a month. |
