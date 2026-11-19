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

A target that isn't met, or doesn't have enough samples, stays **open**. Coding is not part of this run: its budget remains a proposal (docs/23-INTERVIEW-COPILOT.md §8).

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

No real person's data and no user transcript is used. The app runs on isolated E2E user data, so the user's own profiles and settings are untouched.

**What is sent to OpenAI:**

- the synthetic résumé, JD and company text, for embedding at setup;
- each question's speech, to speech-to-text;
- the question with its retrieved synthetic context, to the answer model;
- classifier and follow-up calls on the question text.

Nothing else is sent.

## 3. Reference configuration

| Item | Value |
| --- | --- |
| Commit | recorded at run time (`git rev-parse HEAD`) |
| Build | production build (`npm run build`), launched by the live E2E tier with isolated user data |
| Hardware | the development desktop: i9-10900K, 32 GB, Windows 11. The driver records the CPU, cores, memory and OS from `api.metrics.latency()` in each block summary. |
| Network | the home broadband connection. Record the connection type and a speed-test result in `run-notes.md` before the run. |
| Answer model | OpenAI `gpt-6-luna`, pinned by an override for the run. Reasoning effort `none` (the live task's lowest, recorded per answer). Output ceiling 360 tokens (General) / 600 (Technical). |
| Classifier | OpenAI `gpt-6-luna` (pinned). Rules decide clear turns; the classifier is asked only on ambiguous ones, with a 1.2 s time limit. |
| Embeddings | OpenAI `text-embedding-3-small` (2.5 s limit on the live path) |
| Speech-to-text | OpenAI Realtime GA transcription, `gpt-4o-transcribe`, server VAD (300 ms prefix, 600 ms silence) |
| Memory | on, globally and for the Space |
| Answer style | General block: General. Technical block: Technical. |

## 4. Audio and capture

- **Speech source:** each question is synthesized **locally** by Windows' built-in speech synthesizer to a 24 kHz PCM16 mono WAV (`scripts/perf01/make-audio.ps1`). This uses no network and opens no audio device.
- **Delivery:** the driver streams each WAV into the session through the app's own audio IPC (`session.sendRealtimeAudio`), at real-time pace in 100 ms frames. That is followed by 1.5 s of silence so the VAD ends the turn.
- **Nothing else is opened:** no microphone, call-audio capture or screen capture.
- **Optimistic speech:** synthetic speech is cleaner than a real interviewer's. Speech end → final may therefore be optimistic, and is reported as measured on synthetic speech.
- **Screen requirement:** both app windows must be **visible on the second monitor** during the run: the dashboard, which streams the audio, and the Cue Card, which paints. A hidden or minimised Cue Card does not paint, so no useful-paint report arrives. The driver aborts a block if its warm-up never paints. Screen 1 stays the user's.

## 5. Caps and stop conditions

| Cap | Default | Variable |
| --- | --- | --- |
| Questions sent, whole run | 80 (2 × 31 warm + 10 cold, plus margin) | `PERF01_MAX_QUESTIONS` |
| Tokens (prompt + completion), summed from the records | 400,000 | `PERF01_MAX_TOKENS` |
| Failed or unpainted questions per block before it stops | 5 | `PERF01_MAX_FAILURES` |
| Wait for a question's record | 30 s | `PERF01_QUESTION_TIMEOUT_MS` |
| Pause between questions | 15 s | `PERF01_GAP_MS` |
| Wall clock | 45 min per warm block, 5 min per cold run (Playwright test timeouts) | — |

**Expected volume:**

| Item | Count |
| --- | --- |
| Answers | about 72 |
| Answer tokens, prompt | about 2.5 k each, about 180 k in total |
| Answer tokens, completion | 43 k at most |
| Follow-up predictions | up to 72 small calls |
| Classifier calls | up to 72, on ambiguous turns only |
| Query embeddings | up to about 150 |
| Setup embeddings | about 40 chunks, in a few batched calls |
| Speech-to-text | about 8 minutes of audio |

**Expected time:** about 40 minutes in total.

**Cost:** compute it from OpenAI's prices on the run date: tokens per model × price, plus transcription minutes × price. The app's own deliberately conservative estimate, which is not billing (`companion/costMeter.ts` rates), is under US $1 for this volume. If the cap is hit, the run stops and is reported as incomplete.

## 6. Commands (PowerShell, from the repository root)

```powershell
git rev-parse HEAD                                   # record in run-notes.md
npm run build
# 1. Dry run — offline: synthetic data, audio and framing; no session, no provider.
$env:PERF01_DRY = '1'; npx playwright test -c playwright.live.config.ts e2e/live-perf01.spec.ts; Remove-Item Env:PERF01_DRY
# 2. The live run — ONLY after approval. Needs OPENAI_API_KEY in .env.
$env:PERF01_LIVE = '1'; npx playwright test -c playwright.live.config.ts e2e/live-perf01.spec.ts; Remove-Item Env:PERF01_LIVE
# 3. The report.
$env:PERF01_RESULTS = 'bench-results\perf01\live-<stamp>'; npm run perf01:report; Remove-Item Env:PERF01_RESULTS
```

Do not use `npm run test:e2e:live` for this: it also runs the other live specs. The targeted command above runs only this driver.

## 7. Evidence

Evidence goes to `bench-results/perf01/live-<stamp>/`. That folder is gitignored and outside `test-results/`, which Playwright clears on every run.

| File | Content |
| --- | --- |
| `run.json` | fixture version, caps, start time, platform |
| `rows.jsonl` | one line per question: the app's record, plus its fixture id, block, the time it was asked, and whether its grounding held the expected fact. A question with no record has its own line. |
| `<block>-summary.json` | `api.metrics.latency()` at the end of the block: every evaluated turn's decision time, plus hardware |
| `<block>-latency.jsonl` | the app's raw records, unlabelled |
| `audio/` | the synthesized questions |
| `report.md`, `report.json` | the acceptance view from `npm run perf01:report`: per category and cold/warm, censored p50/p95, verdicts, stages, outcomes, routes and effort, context sizes, unanswered questions and grounding misses |

The handoff carries `report.md`, the commit, and `run-notes.md` (network and anything unusual).

## 8. Already checked offline

- **The offline benchmark** (`npm run bench:perf01`) runs the same fixtures through the real engine, database, retrieval, recall, archive and answer prompt, with simulated vendors. It asserts each question's grounding and stage timings, and writes `bench-results/perf01/simulated-report.md`, labelled SIMULATED.
- **The dry run passes:** 61 audio files are synthesized and checked (1–10 s of speech each), and the synthetic profile and Space are created through the app's IPC. Memories are skipped in the dry run because they need the embedding provider.
- **The report runner** was checked on a mock results folder: a missing question is counted as unanswered, and the warm-up is not a sample.
- **Not yet exercised:** the live session start, real STT, the paint reports in a visible Cue Card, and the token cap. The first live run exercises them, which is why its first block stops on the conditions above.
