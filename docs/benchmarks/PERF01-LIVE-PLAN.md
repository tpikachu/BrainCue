# PERF-01 live benchmark: run plan

**Status: prepared and offline-checked, not run.** This run makes paid calls to OpenAI with synthetic data under the user's own key. It needs explicit approval of this plan before it starts. Nothing in this repository runs it automatically.

## 1. What it measures and decides

It measures the M7.2b / PERF-01 acceptance targets on one named reference configuration, with the full knowledge base and context path:

| Target | Measure | Samples |
| --- | --- | --- |
| Warm General | final → first useful paint p50 ≤ 1.5 s, p95 ≤ 3 s | 30 (after 1 unmeasured warm-up) |
| Warm simple Technical | same | 30 (after 1 warm-up) |
| Detection | final → decision p95 ≤ 1.5 s, over every evaluated turn | every turn in the warm blocks |
| Cold starts | the same measure, reported separately | 5 General + 5 Technical, each in a fresh app process |

The same run also reports:

- speech end → final and speech end → first useful paint, so slow endpointing can't hide behind fast generation;
- final → complete, so an overly long answer can't hide behind a fast first token;
- every stage;
- outcomes, with unanswered questions in the denominator;
- the actual provider, model and effort;
- context sizes and grounding misses.

A target that isn't met, or doesn't have enough samples, stays **open**. A run whose evidence fails the check in §7 gives **no verdict at all**. Coding is not part of this run: its budget remains a proposal (docs/23-INTERVIEW-COPILOT.md §8).

## 2. Data

All data is synthetic and versioned: `src/main/services/engine/bench/perf01.fixtures.ts`, `perf01-v1`. These are the same fixtures the offline benchmark asserts on, question by question.

- **Candidate:** "Jordan Vega (synthetic)", Staff Backend Engineer.
- **Résumé:** 14 projects, about 9.5 k characters.
- **JD:** 6 sections (about 4.1 k characters), plus Northwind company research, 3 sections (about 2.0 k). The company research is appended to the JD text, because research is normally scraped from a URL.
- **Memories:** 2 approved, created through the app.
- **Questions:**
  - `G01`–`G30`: General — behavioural, project, fit, salary and relocation.
  - `T01`–`T30`: short Technical explanations, not coding.
  - Each has the fact its answer must be grounded on.
  - `W00` is the unmeasured warm-up of each warm block.

No real person's data and no user transcript is used. The app runs on isolated E2E user data, so the user's own profiles and settings are untouched.

**Setup runs once.** The seed step creates the profile, Space and memories, and indexes them, in one app process. Every block then starts a **fresh app process on a copy** of that user data, with an empty latency file. Setup is not repeated twelve times.

**What is sent to OpenAI, and nothing else:**

| When | What | Task and model |
| --- | --- | --- |
| Setup, once | the synthetic résumé, JD and company text | embeddings (`text-embedding-3-small`) |
| Setup, once | the synthetic JD and company text, for structured JD parsing | parsing (`gpt-6-luna`) |
| Setup, once | the 2 synthetic memories | embeddings |
| Each process | a model warm-up (a `GET`, no tokens) | — |
| Each question | its synthesized speech | speech-to-text (`gpt-4o-transcribe`) |
| Each question | the question text, for retrieval | embeddings |
| Ambiguous questions | the question text | classifier (`gpt-6-luna`) |
| Each question | the question with its retrieved synthetic context | answer (`gpt-6-luna`) |
| Each answer | the question and answer, for a follow-up prediction | classify task (`gpt-6-luna`) |

The meter (§5) refuses any main-process connection to another host. The session is never kept, so no archive summary or memory suggestion is sent.

## 3. Reference configuration

| Item | Value |
| --- | --- |
| Commit | recorded in `manifest.json` (`git rev-parse HEAD`, plus the count of uncommitted files) |
| Build | production build (`npm run build`), launched by the live E2E tier with isolated user data |
| Hardware | the development desktop: i9-10900K, 32 GB, Windows 11, with a second monitor. The driver records the CPU, cores, memory and OS from `api.metrics.latency()` in each block summary. |
| Network | the home broadband connection. Record the connection type and a speed-test result in `run-notes.md` before the run. |
| Answer model | OpenAI `gpt-6-luna`, pinned by an override for the run. Reasoning effort `none` (the live task's lowest, recorded per answer). Output ceiling 360 tokens (General) / 600 (Technical). |
| Classifier | OpenAI `gpt-6-luna` (pinned). Rules decide clear turns; the classifier is asked only on ambiguous ones, with a 1.2 s time limit. |
| Parsing | OpenAI `gpt-6-luna` (pinned), setup only |
| Embeddings | OpenAI `text-embedding-3-small`; request bounded at 2.5 s. Normal interview answers wait at most 350 ms for unfinished grounding, then rank the current local documents/memories lexically. Ready interim results are reused. Coding retains a longer allowance. |
| Speech-to-text | OpenAI Realtime GA transcription, `gpt-4o-transcribe`, server VAD (300 ms prefix, 600 ms silence) |
| Memory | on, globally and for the Space |
| Answer style | General block: General. Technical block: Technical. |

**Preflight, per block, before any audio.** A block whose preflight fails sends no speech. It is recorded as `preflight-failed`, with every fixture `not-run`. The preflight checks:

- **Route:**
  - The effective answer and classify models are `gpt-6-luna`, with no model notice and no effort override.
  - Every route (answer, classify, parsing) is OpenAI.
  - Chat is ready, retrieval uses embeddings, and memory is on.
- **Speech-to-text:**
  - Cloud transcription is ready.
  - The model and VAD settings come from the session's own configuration message, seen by the meter in this process: `gpt-4o-transcribe`, server VAD, 300 / 600 ms.
- **This process:**
  - The meter is loaded and not capped.
  - The latency file is empty.
  - The seeded profile is present.
- **Windows:**
  - A secondary display exists.
  - The dashboard and the Cue Card are visible, not minimized, and on the secondary display, according to the meter's window snapshot from this process.
  - Chromium reports the Cue Card page as `visible`.

The preflight's findings are written into `blocks.jsonl`.

## 4. Audio and capture

- **Speech source:** each question is synthesized **locally** by Windows' built-in speech synthesizer to a 24 kHz PCM16 mono WAV (`scripts/perf01/make-audio.ps1`). This uses no network and opens no audio device.
- **Delivery:** the driver streams each WAV into the session through the app's own audio IPC (`session.sendRealtimeAudio`), at real-time pace in 100 ms frames. That is followed by 1.5 s of silence so the VAD ends the turn.
- **Nothing else is opened.** The meter refuses microphone, call-audio and screen capture in main, as the offline guard does: permission requests, display media and `desktopCapturer`. Any attempt is logged in `ledger/requests.jsonl`.
- **Optimistic speech:** synthetic speech is cleaner than a real interviewer's. Speech end → final may therefore be optimistic, and is reported as measured on synthetic speech.
- **Screen requirement:**
  - Both app windows must be **visible on the second monitor** during the run: the dashboard, which streams the audio, and the Cue Card, which paints.
  - The meter moves every window to a secondary display; the offline guard's placement is not active in the live tier.
  - A hidden or minimised Cue Card does not paint. The preflight checks visibility, and a block whose warm-up never paints stops.
  - Screen 1 stays the user's.

## 5. Budget, caps and stop conditions

**The meter enforces the budget in main** (`scripts/perf01/live-meter.cjs`, loaded with `--require` into the app's main process only). For every provider request:

1. The request is **held until its body is complete**. This covers `fetch` and `http`/`https`, which the OpenAI SDK and the realtime upgrade use.
2. A **conservative upper bound is reserved**: the body's bytes / 3 as prompt tokens (English JSON is about 4 bytes per token), plus the body's own output ceiling. A request with no ceiling is charged 8,192.
3. The request is **sent only if the run's caps still allow it**. Otherwise it is refused, as an offline machine's would be, and the ledger is marked **capped** for the rest of the run.

Two more limits:

- **Speech-to-text audio** is metered by the second as it is sent. Audio past the cap is not sent.
- **One ledger serves the whole run** (`ledger/meter.json`). Setup, every block and every fresh process draw on the same budget. The ledger counts every request class (answer, classifier, prediction, embeddings, parsing, retries, warm-up), whether or not the provider reports usage.

**The driver stops between questions** (`bench/perf01.budget.ts`). Before each question it checks that a whole question's worst case still fits the remaining budget. After each question, and again at the end of a block, it stops if the ledger is capped. A stopped block writes the fixtures it did not reach as `not-run`. The block is `stopped`, its evidence is saved, and the run is incomplete.

**The worst case per question, from measured sizes.** The offline benchmark records what the meter would reserve for every answer request the real prompt builder produced: at most 4,365 (General), 4,653 (Technical) and 5,042 (in the 32-exchange session). The benchmark fails if any exceeds the 6,000 answer reserve.

| Request | Reserve |
| --- | --- |
| Answer, one attempt | 6,000 |
| Classifier, at most one | 1,000 |
| Follow-up prediction | 1,000 |
| Query embeddings, up to 3 | 1,000 |
| **Per question** | **9,000 tokens, 9 requests** (6 plus 3 for retries) |
| Setup, once: JD parsing (≈ 11 k with its 8,192 ceiling), indexing (≈ 6 k), memories, warm-ups | 25,000 tokens, 30 requests |

**Caps** (environment variable, default):

| Cap | Default | Variable |
| --- | --- | --- |
| Questions spoken, whole run | 72 (2 × 31 warm + 10 cold, exactly the plan) | `PERF01_MAX_QUESTIONS` |
| Reserved tokens, whole run | 673,000 (25 k setup + 72 × 9 k) | `PERF01_MAX_TOKENS` |
| Provider requests, whole run | 678 (30 + 72 × 9) | `PERF01_MAX_REQUESTS` |
| Speech-to-text audio, whole run | 900 s (72 × at most 11.5 s = 828 s) | `PERF01_MAX_STT_SECONDS` |
| Failed or unpainted questions per block before it stops | 5 | `PERF01_MAX_FAILURES` |
| Wait for a question's record | 30 s | `PERF01_QUESTION_TIMEOUT_MS` |
| Wait for earlier answers to finish before the next question | 30 s, then the block stops | `PERF01_SETTLE_MS` |
| Pause between questions | 15 s | `PERF01_GAP_MS` |
| Wall clock | 45 min per warm block, 5 min per cold run, 5 min for the seed (Playwright test timeouts) | — |

**Expected volume** (well under the caps):

| Item | Count |
| --- | --- |
| Answers | 72 |
| Answer tokens, actual | about 3 k prompt (the measured requests are about 12 KB: system, context and question) + up to 0.6 k completion each, about 250 k in total |
| Classifier and prediction calls | up to 144, small |
| Query embeddings | up to about 216 |
| Setup | 1 parse, a few embedding batches |
| Speech-to-text | about 7 minutes of audio |

**Cost:**

- **Worst case,** bounded by the caps: 673,000 tokens × the higher of the per-token input and output prices of `gpt-6-luna` on the run date, plus 15 minutes of `gpt-4o-transcribe`. Compute it from OpenAI's price list on the run date, and record it in `run-notes.md` before the run.
- **Expected:** a fraction of that, because the reservations overstate the real usage.
- **App estimate:** the app's own estimate (`companion/costMeter.ts` rates) is about US $0.60 for the expected volume: answer, classifier and embedding floors plus about 300 k tokens. It is deliberately conservative, and it is not billing.

**Expected time:** about 45 minutes in total.

## 6. Commands (PowerShell, from the repository root)

```powershell
git rev-parse HEAD                                   # recorded in manifest.json too
npm run build
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# 1. Dry run, offline: seed, seed copy, meter, window snapshot, audio, report gate. No session, no provider.
$env:PERF01_DRY = '1'; $env:PERF01_OUT = "bench-results\perf01\dry-$stamp"
npx playwright test -c playwright.live.config.ts e2e/live-perf01.spec.ts
Remove-Item Env:PERF01_DRY, Env:PERF01_OUT
# 2. The live run — ONLY after approval. Needs OPENAI_API_KEY in .env. Both windows go to the second monitor.
$env:PERF01_LIVE = '1'; $env:PERF01_OUT = "bench-results\perf01\live-$stamp"
npx playwright test -c playwright.live.config.ts e2e/live-perf01.spec.ts
Remove-Item Env:PERF01_LIVE, Env:PERF01_OUT
# 3. The report: validates the folder first, and FAILS unless the evidence is valid.
$env:PERF01_RESULTS = "bench-results\perf01\live-$stamp"; npm run perf01:report; Remove-Item Env:PERF01_RESULTS
```

Do not use `npm run test:e2e:live` for this: it also runs the other live specs. The targeted command above runs only this driver.

**One folder, one run.** The manifest binds `PERF01_OUT` to the caps and reference it was written with. A folder that already holds a manifest is refused before anything launches, so a run is never resumed or mixed with another. Use a new stamp for every run, dry or live.

**Stopping.** The tests run in series, so a failed test skips every later one. The driver also enforces this itself: any unsuccessful block (preflight failed, a cap, in-flight work, a driver error) saves its evidence, stops its session and then **fails its test**. No later block of the run starts once one has stopped. The report then shows the run as incomplete.

**Only the active mode's tests exist.** A live run registers the seed and the 12 blocks. A dry run registers the seed and the dry check. An inactive test is never registered and then skipped: Playwright sets up a test's app fixture before its body runs, so it would launch a metered app process that belongs to no block. The evidence check rejects such a process (`process-unexpected`).

## 7. Evidence, and the check before any verdict

Evidence goes to `bench-results/perf01/live-<stamp>/`. That folder is gitignored and outside `test-results/`, which Playwright clears on every run.

| File | Content |
| --- | --- |
| `manifest.json` | the plan: run id, fixture version, commit and uncommitted-file count, caps, reference route and effort, and every block with its category, warm-up and fixture ids |
| `seed.json`, `seed-userData/` | the seeded profile and Space, and the seed's app process; the user data each block copies |
| `blocks.jsonl` | per block: start and end, the app process id, the status (`complete`, `stopped`, `preflight-failed`) and its reason, and the preflight's findings |
| `rows.jsonl` | one line per planned fixture, written once at the end of its block and **reconciled from all the block's evidence**. It holds the sample record (its question's current take), the fixture id, how it was attributed (detected text, or the final's time window), whether **that take's** context held the expected fact, whether usage was reported, and split-final and superseded counts. A fixture whose current take never finished, or with nothing attributed, is `no-record`. One the block never reached is `not-run`. |
| `<block>-progress.jsonl` | what the loop saw at each question (provisional: the question and take collected then) |
| `<block>-watched.json` | the watched Cue Card state at the end: each question's latest wording, detection time and latest take, and the context each take was sent with |
| `<block>-summary.json` | `api.metrics.latency()` at the end of the block: every evaluated turn's decision time, plus hardware |
| `<block>-latency.jsonl` | the app's raw records, unlabelled, all of them |
| `<block>-attribution.jsonl` | every raw record with the fixture it was attributed to, and how |
| `ledger/meter.json` | the budget: reserved tokens, requests, refusals, speech-to-text seconds, request classes, the models on the wire, the speech-to-text configuration, and the cap if one was hit |
| `ledger/requests.jsonl` | one line per request: its class, model, size and reservation, and whether it was sent. It holds no content. |
| `ledger/windows.json` | the latest displays and windows snapshot |
| `audio/` | the synthesized questions |
| `report.md`, `report.json` | the acceptance view from `npm run perf01:report` |

**Attribution.** A record is never matched by row order. It goes to a fixture by the question the app detected, which is the card title, matched against every fixture of the block. A record with no text, missed before its card opened, goes by the time window its final fell in. So a late record for one question can't become the next question's sample.

**Takes.** A record is written only when a take finishes. A corrected question starts a new take on the same card, and the earlier take's finished record stays in the file. The driver watches each card's latest announced take in the Cue Card page (`latencyTake`). A question counts as finished only when its **current** take is.

- **Collection** waits for the current take; an earlier take is never the sample.
- **Settling** before each question waits for every question's current take. If something is still in flight after 30 s, the block stops.
- **The saved line** is reconciled at the end of the block from every raw record, so a replacement that started after collection is the one saved. A replacement still running at the end leaves the fixture unanswered and the block stopped.

**The evidence check** (`bench/perf01.evidence.ts`). The report gives verdicts only if the folder matches its manifest. All of these must hold:

- **Blocks:** every planned block completed, passed its preflight, and ran in its own process.
- **Fixtures:** every planned fixture appears exactly once, in its block and category.
- **Cold and warm:** cold samples are their process's first answer, and warm samples are not.
- **Answers:** every answer used `openai/gpt-6-luna` at effort `none`, and its context held its fact.
- **Attribution:** every attribution was clear.
- **Decision evidence:** every warm block has its all-turn decision summary.
- **Budget**, bound to the manifest:
  - Every process of the run (the seed and each block) loaded the meter with exactly the manifest's caps, and no other process did.
  - Reserved tokens, requests, speech-to-text seconds and questions spoken are all within the manifest's caps.
  - The ledger's totals agree with its own request log.
  - Nothing was refused (a cap, capture or another host), and the meter never capped.
  - Only the reference models and speech-to-text model were on the wire.

  The driver checks the installed caps before it spends anything: before the seed, and in every block's preflight.

Any issue makes every verdict "invalid evidence". The latencies stay in the report as diagnostics. The report command fails on invalid evidence. Missing fixtures stay in the denominator as unanswered.

The handoff carries `report.md`, the commit, and `run-notes.md` (network, prices on the day, and anything unusual).

## 8. Already checked offline

- **The offline benchmark** (`npm run bench:perf01`):
  - It runs the same fixtures through the real engine, database, retrieval, recall, archive and answer prompt, with simulated vendors.
  - It asserts each question's grounding and stage timings.
  - It measures the answer reservations the budget is based on.
  - It writes `bench-results/perf01/simulated-report.md`, labelled SIMULATED.
- **The attribution** (`perf01.collect.test.ts`) passes these cases, all on the code the driver collects with:
  - a late record for A arriving while B is asked;
  - out-of-order completions;
  - a final landing in the next window;
  - split finals;
  - several takes;
  - a record with no text;
  - settling;
  - with the real `LatencyRecorder`: an answered take 1 and a running take 2 (collection and settling wait for take 2; it is never take 1), a take 2 that never finishes, and a split question detected before its first record.
- **The evidence check** (`perf01.evidence.test.ts`):
  - It passes a complete valid run as the control.
  - It rejects the review case: 30 × G01, 30 × T01, 70 grounding misses and no decision summaries.
  - It rejects each kind of invalid evidence on its own, including the meter bound to the manifest: totals over a cap, a process with other or no installed caps, a block process without the meter, an extra metered process, a seed without one, a ledger that disagrees with its log, any refused request, and a manifest without caps.
  - It rejects the second review case: a manifest capped at 1 token with a 300,000-token ledger.
- **The meter** (`perf01.meter.test.ts`) runs real child processes on the OpenAI SDK and `ws`, against a fake loopback provider. It shows:
  - a refused request never reaches the provider;
  - the one-token cap case;
  - the final request over the cap;
  - accumulation across processes;
  - unbounded requests and setup calls;
  - the request cap, and that it fails closed;
  - non-provider hosts refused;
  - speech-to-text seconds metered and capped, with its model recorded.
- **The block loop** (`perf01.budget.test.ts`) shows:
  - the one-token cap stops before speaking;
  - a final question over the cap stops the block;
  - not-run lines;
  - accumulation across blocks;
  - that unreported usage changes nothing;
  - setup spending is counted;
  - no meter, nothing asked;
  - in-flight work stops the block;
  - a warm-up that never paints stops the block.
- **The driver** (`perf01.driver.test.ts`): the real `runBlock`, `seedRun` and `bindRun`, with real files and a fake app on a virtual clock. It shows:
  - a failed preflight saves its evidence, stops the session once, sends no speech and **fails**, and the next block refuses to start;
  - caps installed differently from the manifest fail the block before any audio, and stop the seed before any setup;
  - a passing control, with its sample saved with its take's grounding;
  - a correction's take 2 saved with its own timing and grounding;
  - a replacement during the gap reconciled to take 2;
  - a replacement still running at the end leaves the fixture unanswered and the block stopped;
  - the next fixture is not sent while a replacement is running;
  - a folder that already holds a manifest is refused.
- **Playwright's serial mode**, checked on a throwaway spec with this suite's layout: after a failed block, every later test did not run.
- **Registration** (`e2e/perf01-register.spec.ts`, in the offline E2E tier): the real registration runs under Playwright with a fake app fixture that records which tests initialize it.
  - Live mode initializes the app only for the seed and the 12 blocks, which all run.
  - Dry mode initializes it only for the seed and the dry check.
  - Without the live flag or a key, nothing initializes.
- **The dry run passes**, under the offline guard:
  - the seed in one process;
  - a fresh process on its copy, which sees the profile and has an empty latency file;
  - the meter loaded once in main, with the manifest's caps, and sending nothing;
  - its window snapshot from that process, with every window on the secondary display;
  - 61 audio files, 1–10 s each;
  - the report gate rejecting the unrun folder;
  - a second run on the same folder refused before anything launches;
  - exactly 2 metered processes (the seed and the dry check), with no test skipped.
- **Not yet exercised:** the live session start, real STT, the paint reports in a visible Cue Card, and real provider traffic through the meter. The first live block's preflight and stop conditions cover them.
