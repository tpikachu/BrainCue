# Interview Copilot — the primary feature

> Status: product priority set 2026-11-17 (the interview-first cycle,
> `feature/interview-copilot-first`). Meetings, Companion and every other
> activity keep working unchanged; the defaults now lead with the interview.

The experience this optimises, end to end:

> Pick the candidate profile → pick the interview Space that holds the JD →
> check audio and AI readiness → Start → fast, relevant answer cues grounded in
> the résumé, the JD and what was actually said.

This document is the design of record for the four pieces that make that work:
question detection and scheduling (§1–2), in-session continuity and grounding
(§3–4), provider-aware model selection and readiness (§5–6), and the
interview-first UI (§7). Evidence and how to re-measure it are in §8.

## 1. Question detection (`engine/interview/`)

**What was wrong.** Every interviewer final went to a classifier prompted
"classify the interviewer utterance", with nothing but that one utterance. The
classify default (`gpt-4.1-nano`) was retired by OpenAI on 2026-10-23; from
then every classification threw, the error was logged, and **no question was
ever answered automatically** for an OpenAI user on the Balanced or Low-cost
preset. Imperative requests ("Tell me about yourself.") were often judged
not-a-question even when the model was up.

**Now — rules where reliable, the model where ambiguous** (`detector.ts`,
`questionHeuristics.ts`):

| Verdict | Decided by | Examples |
| --- | --- | --- |
| question | rule, no model call | "Tell me about yourself." · "Walk me through that project." · "Why that approach" · "Have you used Kafka" · "I'm curious how you…" |
| not | rule | backchannel ("Okay.", "Mm-hmm"), courtesy ("That's a great example, thanks"), logistics ("Can you hear me?"), rhetorical idioms, a wh-clause used as a subject ("What we do here is…") |
| fragment | rule → held 1.2 s for its second half | "So walk me through the" |
| ambiguous | classifier, with the last 4 speaker-labelled turns | "And your role", "Say more about the ranking change." |

The classifier's output is validated with zod field by field — a wrong type
fails closed (`"confidence": "high"` is 0, not a yes). It has a 1.2 s timeout;
at the timeout the **rule lean** decides (an elliptical "And your role" leans
yes; a statement leans no), and the model keeps going for up to 5 s — a late
"yes" still answers the question unless the conversation has moved on (a newer
interviewer question, or the candidate already replying). A model the account
no longer has is reported (`reportUnavailable`) so the next turn resolves to
the next candidate on the same provider.

## 2. Scheduling (`questionScheduler.ts`)

v1 returned early when an answer was streaming, so a question asked during an
answer was transcribed and never evaluated. The scheduler's policy:

1. **Detection never stops.** Every interviewer final is evaluated.
2. **One answer streams at a time.** A distinct question detected while one
   streams (or while a manual Ask / regenerate holds the slot) is queued FIFO
   and answered as soon as the slot frees.
3. **Revisions coalesce.** A repeat of the in-flight or queued question within
   20 s (duplicate final, transcriber revision) is dropped; a longer copy
   replaces the queued text.
4. **Continuations and corrections supersede.** "…and how you tested it" or
   "Sorry, I meant the second project" within 8 s of the last question, before
   the candidate has spoken, re-answers **the same card** (same question row)
   with the joined wording; an in-flight stream is aborted first.
5. **Fragments wait** 1.2 s for their second half.
6. **Nothing disappears silently.** Past 3 queued questions, or when the user
   pauses with questions waiting, each becomes a visible card with no answer
   and "Press ↻ to answer it".

Interim transcripts never create a card (they only prefetch grounding). The
candidate's own microphone turns are recorded and close the continuation
window, but never trigger. The Cue Card's **Answer that** button answers the
interviewer's latest words (joining a split question) when detection missed.

## 3. In-session continuity (`conversationContext.ts`)

The 10-item, 300-character history buffer was the only continuity, and it
showed BrainCue's own suggestion as "You answered:", so a short follow-up
retrieved on wording the candidate may never have said. It is replaced by a
bounded per-session context, rendered per answer as a **snapshot taken
synchronously at stream start** (turns arriving mid-stream cannot change it):

| Block | What | Bound |
| --- | --- | --- |
| recent | last turns verbatim, speaker-labelled, numbered `[#n]` | 12 turns / 2 400 chars |
| earlier | one line per earlier exchange: the question + what the candidate actually said | 12 exchanges |
| recalled | older turns BM25-matched to this question | 3 turns |
| open | earlier questions the candidate never answered | 3 |
| suggestions | BrainCue's earlier leads — labelled *not evidence* | 3 |
| subject | for a referential follow-up only, the exchange it continues | 1 |

No model call and no summarisation pass: deterministic, so it can never invent
a fact, and it costs nothing on the hot path. Turns are ordered by when they
were **spoken** (the echo guard commits own turns ~1.5 s late). A follow-up is
referential when it is short and anaphoric ("Why that one?", "What was your
role there?") and names nothing new; a topic shift ("Let's move on…", "And what
about Kubernetes?") is not. Retrieval for a referential follow-up carries the
subject from **what the candidate said**; BrainCue's suggestion stands in only
when no candidate speech was captured (no microphone).

**Resume** restores the session's own turns and answers from its rows
(`enginePersistence.sessionTimeline`, scoped by session id). Each session owns
its context, so another session, profile or Space can never leak into an
answer; retrieval stays scoped to the session's profile and Space. Continuity
does not depend on long-term memory or archives (both optional and
consent-gated).

## 4. Grounding and answer behaviour (`openai/answer.ts`, `rag/retriever.ts`)

- **Sources are ranked in the system prompt.** CONTEXT and MEMORY establish
  facts; "You said" lines are the candidate's own words; "BrainCue suggested"
  lines prove nothing. A `(jd)` chunk is labelled *employer requirement, not the
  candidate's experience*. General knowledge may explain a concept, never become
  a claim about the candidate.
- **Documents and transcript are data.** The prompt says to ignore instructions
  inside them; a test pins that an injected line stays inside the data block.
- **Missing evidence**: the fabrication guard (⚠ + honest framing) now also
  allows naming the one detail only the candidate can supply.
- **Source balance**: when the top-k holds only résumé chunks (or only JD), the
  best *relevant* chunk of the missing side (≥ 60 % of the best score) replaces
  the weakest of the crowded side. Irrelevant chunks are never forced in.
- **Without an embedding key** documents are still chunked (local work) and
  ranked with BM25; vectors are only compared within one embedding space —
  the read path now filters by provider/model/dimension (it had no check).

## 5. Model selection (`shared/modelPolicy.ts`, `openai/models.ts`)

The user picks a **provider** and **Fast / Balanced / Quality**. Each chat task
resolves to an ordered candidate list for that provider and preference; the
first one the account can use wins. "Can use" = the provider has a key, the
account's own model list (discovery — `GET /models`, cached, refreshed at
startup and on key change, never on the answer path; a list older than 7 days
stops filtering) includes it, and it has not failed as unavailable this
process.

Defaults (first candidates), verified 2026-11-17 — OpenAI against an account's
live `/v1/models`, the others against vendor docs only:

| Provider | Fast answer | Balanced answer | Quality answer | Classify | Coding (Balanced) |
| --- | --- | --- | --- | --- | --- |
| OpenAI | gpt-6-luna | gpt-6-luna | gpt-6.1-terra | gpt-6-luna | gpt-6.2-astra |
| Anthropic | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 | claude-haiku-5-5 | claude-opus-5-5 |
| Google | gemini-3.5-flash-lite | gemini-3.8-flash | gemini-4-argon | gemini-3.5-flash-lite | gemini-4-carbon |
| Groq | openai/gpt-oss-20b | openai/gpt-oss-120b | openai/gpt-oss-120b | openai/gpt-oss-20b | openai/gpt-oss-120b |

Sources: developers.openai.com/api/docs/models (+ /deprecations),
platform.claude.com/docs/en/about-claude/models/overview (+ /effort),
aistudio.google.com/docs/models (+ /openai), console.groq.com/docs/models.
OpenRouter suggestions are unverified; discovery decides.

**Capability metadata, not names.** The catalog carries each model's accepted
reasoning efforts (lowest first), whether thinking can be disabled, a latency
class and its lifecycle (current / deprecated / retired, with shutdown dates).
Live tasks (classify, answer, mock) and parsing always send the **lowest**
effort the model accepts — `none` on GPT-6 Luna/Terra (no reasoning headroom
added), thinking disabled on Haiku 5.5, `minimal` on Gemini, `low` on GPT-OSS.
The installed OpenAI SDK (4.104) types only low/medium/high; one function
(`providers/effort.ts` `reasoningBody`) bridges that type — the API accepted
`none` in live runs.

**Overrides** (Advanced, per task) win while they can run. Picking a preference
no longer wipes them. An override **pins its task to its provider** (M2): a
model the account does not list, or one that failed as unavailable, falls back
to that provider's own plan — never to the chat provider; an override whose
provider has no key is kept as it is, so readiness blocks with the fix ("add
the key, or clear the override") instead of the task silently moving
elsewhere. The reason is shown in Settings and the start checklist.
Preferences are stored under the legacy preset names (`low_cost` / `balanced` /
`best`), so an older build reading the same database still understands them.

**Failover** is bounded: at most one retry, and only before the first visible
token — a partly streamed answer is never replayed. An unavailable model falls
to the next candidate **on the same provider** (no interview data goes to a
provider the user did not choose — the retry is refused if the next route is
on any other provider, override or not). **Each attempt's route is captured
before it is sent** (`taskRoute`) and travels with the request
(`ChatStreamRequest.route` / `ChatJsonRequest.route`): the routed provider and
the adapter both use exactly that provider + model, a model error marks THAT
route (`markRouteUnavailable`), and `retryRouteAfterModelError` allows only a
different model on the same provider. Resolving "the task's route" when the
error arrived blamed whatever the task resolved to by then — a concurrent
failure marked the healthy fallback, and a key removed mid-request moved the
retry to another provider; a network/5xx error retries once after
400 ms; auth and quota errors surface with the provider named. Cross-provider
failover is deliberately not built: it needs an explicit consent setting first.

## 6. Readiness (`services/readiness.ts`)

The start gate used to be "is there an OpenAI key?". It is now three separate
capabilities, each with the actual problem and the next action:

- **chat** — the provider the answer and classify tasks resolve to has a key;
  the explanation line names the model and why it was picked.
- **transcription** — cloud (OpenAI key) or on-device (model downloaded).
- **retrieval** — never a blocker: `embeddings` with an OpenAI key, else
  `lexical`, with the limitation stated.

**The latency-tolerant features follow the same routing** (M2,
`openai/chatTask.ts`): résumé/JD/company parsing, prep briefs and story drafts
(the parsing task), the coaching report (the answer task), mock-interview
questions and sparring feedback (the mock task) all go through the routed
chat provider — they used to call the OpenAI SDK with `model(task)`, which
handed a Claude id to OpenAI once Anthropic was selected. They share the live
path's bounded failover: a model error marks the model unavailable and retries
once on the next candidate of the same provider, never after the first
streamed token.

**Per-feature readiness** (`readiness.features`), used by the screens that
start them: `parsing` (the parsing task's provider has a key), `mock` (an
OpenAI key for the interviewer's voice, the mock task's provider for its
questions AND the answer task's provider — a mock streams real answer cues;
`mockManager.start` checks all three before creating anything), `sparring`
(an OpenAI key for voice + transcription, and the mock task's provider; it
writes no answer cues), `tailoring` (OpenAI only — its long,
no-retry request is an OpenAI SDK option; it asks OpenAI for an OpenAI model
via `openaiOnlyModel`, never `model(task)`). Each blocked feature carries the
reason and the fix.

Still OpenAI-only: embeddings, cloud transcription, voice (and so the spoken
half of practice), résumé tailoring.

## 7. Interview-first UI

- `DEFAULT_ACTIVITY` is `job` (Interview) and leads `ACTIVITY_ORDER`; stored
  Spaces and sessions keep their kinds; an unknown kind still reads `custom`.
- Home leads with **Start interview**; **Other conversation** opens the same
  start flow on Meeting. There is still one start flow and one activity list.
- The start modal ("Start an interview") adds a **readiness checklist**:
  candidate + résumé, interview Space + JD, audio, AI model (with its
  explanation), transcription, and the lexical-retrieval note — each problem
  with a link to its fix.
- The Cue Card during an interview: status, Pause/Stop, the current question
  and answer, the General | Technical chip, **Answer that** + Ask, and a compact
  transcript (latest line; one tap for the full one). Model, history,
  pronunciation and clear moved behind "⋯". Two duplicated controls (a second
  companion bar, a second memory editor) were removed.
- **Capture truth**: the dashboard reports which audio streams actually flow,
  and again when a track ends; the Cue Card names a missing stream and what it
  costs ("Call audio is not captured — questions can't be heard").
- **Startup is all-or-nothing** (M1, `store/useLiveSession.ts`). `startNew` /
  `resumeExisting` return a `StartResult` — `{ ok: true, sessionId }` only once
  the session exists AND its audio pipeline is attached; otherwise
  `{ ok: false, stage: 'capture' | 'start' | 'audio', error }`:
  - `capture` — no stream could be acquired (picker refused, mic denied, no
    device): no session is created.
  - `start` — the session IPC failed: every acquired track is stopped.
  - `audio` — the AudioContext/pump failed to attach: the tracks are
    stopped, then the session is rolled back — stopped, and a new one also
    deleted (it heard nothing; a resumed one keeps its earlier content).
    The rollback's own save prompt is suppressed ONE-SHOT (only during its
    stop), so a later successful run of the same session prompts normally.
    Only what was confirmed is claimed: a rejected stop leaves the session
    in the store, visibly live, with "may still be running" and
    `cleanup: 'failed'`, and Stop retries the same rollback; nothing is
    deleted before the stop is confirmed. A stop that succeeds with a
    failed delete says so and names the record to remove from Sessions.

  The start modal stays open on any failure and shows the reason. Capture
  status is reported only AFTER the pipeline is attached, and a track that
  already ended during setup is not reported as live. One missing stream is
  still a running session with a notice that names the missing side.

## 8. Evidence and how to re-measure

**Instrumentation** (`engine/metrics/latency.ts`): per answered question,
speech end → final, final → decision, decision → grounded, final → first token,
and final → **first visible** (the overlay reports after two animation frames,
i.e. after paint). p50/p95, cold (first answer of the process) vs warm. Each
completed record is appended to `<userData>/metrics/latency.jsonl` — ids and
timestamps only, never text; `api.metrics.latency()` returns the summary plus
hardware. Speech end is the server VAD's speech-stopped (OpenAI Realtime) or
the last interim delta (the local engine has no VAD event).

**Detection evaluation** (`interview/eval/`):
- `detectionSet.ts` — 115 labelled turns, the development set (rules were tuned
  on it). `detectionHoldout.ts` — 65 turns written afterwards and never used for
  tuning. `detection.eval.test.ts` runs both deterministically with the
  classifier unavailable (the floor).
- `detection.live.test.ts` — the real detector, prompt, validation and timeout
  against a real provider, sequential. Skipped unless `BRAINCUE_LIVE_EVAL=1`;
  spends tokens.

Results on 2026-11-17 (i9-10900K, 32 GB, Windows 11, home network; OpenAI
`gpt-6-luna`, effort `none`; live services, not mocks):

| Measure | Result | Target |
| --- | --- | --- |
| Precision, all 180 turns (live) | 1.000 | ≥ 0.95 |
| Recall, all 180 turns — on time / eventual (with late verdicts) | 0.945 / 0.991 | ≥ 0.90 |
| Held-out (65): precision · recall on time / eventual | 1.000 · 0.850 / 0.975 | — |
| Rules only, held-out (classifier dead) | P 1.000 · R 0.850 | floor |
| Final → decision p50 / p95 (live) | 0 ms / 1 213 ms | p95 ≤ 1.5 s ✅ |
| Late model verdicts, final → decision p50 / p95 (n = 5) | 1 815 / 2 010 ms | (these miss 1.5 s) |
| Classifier round trip p50 / p95 (n = 44) | 1 781 / 2 689 ms | — |
| Final → first **token** (no retrieval), warm p50 / p95 (n = 15) | 1 876 / 3 241 ms | first visible p95 ≤ 3 s — **not yet met at p95; first visible not measured live** |

Every classifier call in the live run exceeded the 1.2 s timeout; round trips
from this machine run 1.1–3 s for every candidate model probed (gpt-6-luna,
gpt-6.1-terra, gpt-4.1-mini, gpt-5-nano, gpt-5-mini). That is why detection
decides by rule wherever a rule is reliable, and why late verdicts exist.
First **visible** content and speech-end → final need the running app with
real audio: run the manual script in the handoff, then read `latency.jsonl`.

The held-out set is small and hand-written; it is a regression signal, not a
benchmark. Grow it from real misses (never from a user's transcripts without
their say-so), and keep tuning and measuring on different sets.
