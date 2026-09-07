# OpenAI Service Layer Design

Lives entirely in the **main process** under `src/main/services/openai/`.
The renderer never imports the SDK and never sees the key.

## Provider capability layer (v2, `src/main/providers/`)

OpenAI is the **reference provider** behind capability interfaces
(PRD §6.7): `chat` / `embedding` / `realtimeStt` / `batchStt` / `speech` /
`vision`, resolved per capability by `providers/registry.ts`. Interfaces carry
**transport only** — prompt building, format ceilings, and domain events stay
in the service modules below, so a second provider is a transport swap, not a
rewrite. OpenAI-specific quirks (reasoning-effort param + reasoning-token
headroom) live in `providers/openai/`, which wraps these modules unchanged.

### Multi-provider v1 (v2.2, milestone 5.1): `chat` + `vision` routed PER TASK

Since v2.2 the `chat` and `vision` capabilities can be served by **Anthropic,
Google Gemini, Groq and OpenRouter** as well as OpenAI, chosen **per task** —
the coding solver can run on `claude-fable-5-1` while the live cue stays on
`gpt-4.1-mini`. The catalog (`CLOUD_PROVIDERS`, `MODEL_CATALOG`) lives in
`src/shared/providers.ts`; everything below is main-process only.

- **Qualified ids.** A per-task override in `AppSettings.models[task]` may be a
  qualified id — `anthropic/claude-opus-5`, `openrouter/openai/gpt-5` — and a
  bare id still means OpenAI, so every setting written before v2.2 resolves
  exactly as before. `models.ts` exposes `resolveModel(task)` →
  `{ provider, model }` (via `parseModelId`, which strips only a KNOWN provider
  prefix so OpenRouter's own `vendor/model` ids survive), while `model(task)`
  keeps returning the **bare** vendor id so OpenAI call sites are unchanged.
- **Routing.** The registry selects `routed` for `chat` and `vision`
  (`providers/routed.ts`): each call reads the task's provider and dispatches
  to that provider's registered adapter (`<provider>:chat`). Vision has no
  task of its own — the screenshot solver **is** the `coding` task, so it
  follows the coding model. `providerFor('chat')` stays the only entry point;
  the coding paths (`coding.ts` text solver, `capture/codingMode.ts`
  screenshots) now go through the seam too. Routing reads the task route
  through `providers/taskRoute.ts`, a dependency-free slot `models.ts` fills
  at load — when `models.ts` is stubbed (unit tests) everything routes to
  OpenAI.
- **Transports.** Three cover every provider: `openai` (Responses API),
  `anthropic` (native Messages API, `providers/anthropic/`) and
  `openai-compatible` (`providers/openaiCompatible/` — the `openai` SDK with
  the vendor's `baseURL` on the **Chat Completions** API, since Google, Groq
  and OpenRouter do not implement Responses; one factory covers all three,
  OpenRouter additionally sends `HTTP-Referer`/`X-Title`). Every adapter
  yields the same `ChatStreamEvent`s (deltas, then `usage` last) and vision
  adapters share `visionSolvePrompt` from `codingPrompt.ts`.
- **Anthropic thinking / effort policy** (from the current API reference —
  not training-era patterns): `claude-fable-5-1` has thinking always on, so
  the `thinking` parameter is **omitted** and depth is set with
  `output_config.effort`; it also opts into server-side fallbacks
  (`fallbacks: 'default'` + beta `server-side-fallback-2026-07-01`, on the
  `client.beta.messages` surface) so a safety refusal re-runs on a fallback
  model in the same call. `claude-opus-5` / `claude-sonnet-5` run adaptive
  thinking by default (omitted too) with `output_config.effort`.
  `claude-haiku-4-5` supports neither → neither is sent. Never
  `budget_tokens`, `temperature`, `top_p`. Effort: live paths (`answer`,
  `classify`, `mock`, `parsing`) → `low`; `coding` / `tailor` → the user's
  reasoning-effort override (`minimal|low`→`low`, `medium`, `high`) else
  `high`. `max_tokens` = the caller's ceiling (default 4096) + 1024 headroom
  on reasoning models. `stop_reason: 'refusal'` → "The model declined this
  request."
- **Keys per provider** — `services/security/providerKeys.ts`, same rules as
  the OpenAI key ([07](07-API-KEY-SECURITY.md)); adapters resolve theirs
  lazily through `providers/keys.ts`, and a task routed to a provider with no
  key fails with "<Provider> needs an API key — add one in Settings →
  Language Models." (surfaces in the Cue Card via the sessionError path).
  `providers/testKey.ts` does the cheap `GET /models` check per provider.
- **Errors.** `providers/normalizeError.ts` (`normalizeProviderError`) is what
  the engine's error path calls: Anthropic SDK errors get 401/429/status
  messages, OpenAI-compatible adapters re-throw vendor-named plain Errors,
  everything else falls through to `normalizeOpenAIError`.
- **Capability gaps as UI states.** A provider that lacks a capability a task
  needs (Groq for vision) throws `CapabilityUnavailableError` with a hint
  naming the provider and the fix ("Groq can't read screenshots. Pick a
  vision-capable model for the coding solver…") — never a bare SDK error.
- Embedding, realtime STT, batch STT and speech still select OpenAI; the
  Settings UI + Cue Card model picker land with the renderer work.

- Engine-facing call sites go through the registry: `answer.ts`,
  `questions.ts`, `followup.ts` (chat), `rag/retriever.ts` + `indexProfile.ts`
  (embedding), `engine/sourceAdapter.ts` (realtimeStt), `engine.ingestAudio`
  (batchStt) — plus the newer consumers: the meeting/companion salience
  classifiers (`engine/trigger/salience.ts`, `companionSalience.ts` — chat
  `json`), the memory extractor + approved-only recall (`services/memory/` —
  chat + embedding), the voice layer (`services/voice/quickAnswer.ts`
  chat streaming, `voiceService` speech), and since v2.2 both coding solvers
  (`coding.ts` → chat, `capture/codingMode.ts` → vision). The remaining
  modules (parsing/brief/stories/tailor/interviewer/feedback call sites)
  still call the OpenAI SDK directly and migrate opportunistically — a
  non-OpenAI override on those tasks is not honored until they do.
- A capability the selected provider lacks throws `CapabilityUnavailableError`
  with a user-safe message (surfaces in the session-error banner).
- **Embedding identity**: `embeddings` rows store `provider` + `model` + `dim`;
  the write path refuses to mix identities (`rag/embeddingIdentity.ts`) —
  switching embedding provider/model requires a re-index (UI for that lands
  later).
- Per-capability selection: `chat`/`vision` → `routed` (per task, above);
  everything else → OpenAI.

## Model configuration (`models.ts`)

Resolution order: **per-task user override (`settings.models[key]`) → active preset's
table → built-in default**. There are three presets (`settings.modelPreset`):

```ts
export const PRESETS = {
  balanced: { // default
    answer: 'gpt-4.1-mini', classify: 'gpt-4.1-nano', parsing: 'gpt-4.1-mini',
    embedding: 'text-embedding-3-small', transcription: 'gpt-4o-transcribe',
    tts: 'gpt-4o-mini-tts', mock: 'gpt-4.1-mini',
    coding: 'gpt-5-mini',   // reasoning solver — clipboard text AND screenshots
  },
  low_cost: { /* …balanced, but parsing→nano, transcription→gpt-4o-mini-transcribe */ },
  best:     { /* full gpt-4.1 on answer/parsing/mock; coding→gpt-5; classify→gpt-4.1-mini */ },
};
```
> **Task-routed, not one-model-fits-all.** The live hot paths (`classify` every turn,
> the read-along `answer`) stay on FAST non-reasoning models in **every** preset —
> "best" upgrades them to the full `gpt-4.1` (higher quality, still snappy) rather than
> a reasoning model, which would add latency without helping a grounded cue. A
> reasoning model is reserved for the latency-tolerant `coding` solver.
> The UI shows **Custom** when a per-task override diverges from the preset.

### Reasoning effort
GPT-5 / o-series models accept a `reasoning.effort` (`low`/`medium`/`high`). It's
attached ONLY to reasoning models via `reasoningParam(key)` (never sent to gpt-4.1/4o,
which reject it). Per-task defaults live in `defaultEfforts` (`coding: 'low'`) and are
overridable via `settings.reasoningEfforts` — switchable live for coding in the Cue Card.

Model ids are configuration, not contracts — kept in one file so they can be tuned
without code changes; validate availability via `settings:test-api-key` / **Load my
models**. (`gpt-5-*` ids should be verified against the live model list before relying
on them.)

## Client (`client.ts`)
- Lazily constructs `new OpenAI({ apiKey })` using the decrypted key from
  `services/security/apiKey.ts`.
- Rebuilds the client when the key changes; caches otherwise.
- Centralizes timeout, `maxRetries`, and error normalization
  (`normalizeOpenAIError` → user-safe string; full error only to local log).

## Functions

### parsing.ts — `parseResume(text)`, `parseJobDescription(text)`, `parseCompany(text)`
Uses Responses API with a JSON instruction to return typed JSON (defensively defaulted):
- Resume → `{ skills[], projects[], workHistory[], metrics[], education[], certifications[], techStack[], leadership[] }`
- JD → `{ requirements[], responsibilities[], keywords[], focusAreas[] }`
- Company → `{ overview, products[], techStack[], values[], culture[], recentNews[], interviewAngles[] }`
  from text scraped off the company website (see `services/documents/companyResearch.ts`),
  used to tailor answers to the company.

### brief.ts — `generateBrief(input) => InterviewBrief`
Powers the **Pre-Interview Brief**. Input is the candidate's parsed résumé, the job's
parsed JD, and (optionally) parsed company research. One Responses call (`parsing` model,
`json_object`) returns a grounded study brief — `summary`, ranked `likelyQuestions`
(`{question, why}`), `gaps` (`{requirement, coverage: strong|partial|missing, howToAddress}`),
`strengths` (`{point, evidence}`), and `companyAngles`. Output is defensively defaulted and
coverage is normalized, so a malformed response can't crash callers. The system prompt
forbids inventing experience/employers/metrics/company facts — thin data yields fewer items,
not fabrication. The `jobs:brief` handler gathers résumé+JD+company from the repos and guards
on key/résumé/JD presence; the brief is returned (not persisted) and shown in the dashboard's
`BriefModal`.

### stories.ts — `generateStories(input) => StoryDraft[]`
Powers the **STAR Story Bank**. From the candidate's parsed résumé (+ raw text), one
Responses call (`parsing` model, `json_object`) extracts 4–8 reusable STAR stories, each
tagged with 1–3 competencies from a **closed set** (`COMPETENCIES`, kept in sync with the
`StoryCompetency` union) plus demonstrated skills. Output is defensively parsed: competencies
are clamped to the closed set, non-string skills dropped, and stories missing
title/situation/action/result are filtered out (so a degenerate response yields fewer/zero
stories, never a crash). The system prompt forbids inventing employers/projects/metrics.
The `stories:generate` handler bails if extraction is empty, then `replaceStories`
(`rag/indexProfile.ts`) **embeds first and commits rows + `story` chunks + embeddings in one
transaction** — a failed embedding leaves the prior bank intact. `indexStories` re-embeds on
edit/delete with the same embed-before-mutate guarantee. Stories surface live as `📖 story`
source chips via the normal retriever (they're just `story` chunks). **Story-to-tell cue:**
`retrieve` (rag/retriever.ts) embeds the question once and, alongside the top-k, force-includes
the single best-matching `story` chunk when its score ≥ `STORY_CUE_MIN_SCORE` (`@shared/types`) —
so it grounds the answer, stays citable, and the Cue Card surfaces it as a prominent
**"📖 Story to tell"** callout (`StoryCue` in Overlay.tsx, derived from the `contextSent` chunks —
no extra IPC event or embedding call).

### tailor.ts — `tailorApplication(input) => TailorResult`
Powers **Tailor Resume** (v1.3) — **switched off**, see [20](20-QUARANTINE.md). One call (new `tailor` model key — full `gpt-4.1` on
balanced, `gpt-5` on best; latency-tolerant, quality-critical) takes the BASE resume ×
JD × application questions and returns `{ candidateName, jobTitle, company,
tailoredResume, answers[] }`. The prompt grounds EVERYTHING in the base resume (reword/
reorder/emphasize — never invent employers, dates, metrics, or skills), mirrors the JD's
keywords only where truthful (ATS matching), and mandates ATS structure: single column,
standard H2 sections, plain markdown, no tables/images. Answers are first-person and
grounded. Defensively parsed; throws if no resume comes back (so nothing persists).
The `applications:tailor` handler then materializes a profile (uploaded-base path),
a dedicated job (JD), and the application row; `indexJob` embeds the tailored resume as
job-scoped `tailored` chunks, and `vectorStore.search` drops base `resume` chunks for
jobs that have them — live sessions ground in the TAILORED resume + JD.

### embeddings.ts — `embed(texts: string[]) => Float32Array[]`
Batches inputs, returns vectors; caller stores BLOBs. Records model + dim.

### questions.ts — `classifyQuestion(text) => DetectedQuestion`
Small/fast model. Returns `{ text, type, confidence, strategy }`. Also used as a
cheap "is this actually a question?" gate before answer generation.

### answer.ts — `streamAnswer(input) => AsyncIterable<AnswerEvent>`
Input: `{ question, contextChunks, profile, format, pronunciation, interviewType, signal? }`.
Builds a **grounding** prompt:
- System: persona + rules ("ground answers in provided context; never invent
  experience; if no relevant experience, give a transferable-skills answer and
  set a risk warning"); FORMAT is a hard constraint; plus a **naturalness / anti-AI-tone**
  directive (contractions, varied sentence length, no corporate/AI tells or hedging — must
  read 100% human, never AI-generated).
- **Grounded / proof-linked answers:** `buildContext` numbers the chunks `[1] (resume) …`;
  the prompt makes the model cite those numbers inline after each grounded claim
  (e.g. `…cut p99 latency 40% [1]`). The Cue Card renders the cited `[i]` as source chips
  (the `Citations` component, backed by the `contextSent` chunks). **Fabrication guard:**
  for anything the context can't support the model must not invent it — it leads with
  `⚠`, says it's not in the candidate's background, and pivots to a cited transferable
  framing.
- User: question + retrieved context + profile summary + the chosen answer format.
- **Pronunciation guide** (v1.2, ON by default, live-toggleable): the answer stays clean
  (no inline respellings); instead, if any words are genuinely hard, the model appends a
  `[[PRONUNCIATION]]` section with one pipe-delimited line per word
  (`word | part of speech | singular | respelling`). The Cue Card splits this out
  (`overlay/pronunciation.ts` `splitPronunciation`, tolerant of model-output variance) and
  renders a structured "🗣 How to say it" panel below the answer. Adds +160 `max_output_tokens`
  headroom so the guide never eats the answer.
- **Persona:** the system prompt frames the model as the candidate themselves — "You ARE the
  candidate … answering ON THEIR BEHALF, in first person" — never third-person.
- `format` — the single answer control (v1.2): `key_points` (terse bullets) | `explanation`
  (a natural, flowing first-person explanation) | `detailed` (thorough, with one example) |
  `story_teller` (a short, vivid first-person story — "you are ME telling MY OWN story").
  It also sets a hard `max_output_tokens` ceiling (220 / 340 / 800 / 420) so "key points" can never
  drift long regardless of the prompt. (The old format/tone × length split — `star`/`technical`/
  `conversational` — was removed.)
Streams tokens (`{type:'delta', token}`), then a `usage` event, then a structured
`meta` event `{ talkingPoints[], resumeMatch, star?, clarifyingQuestion?, riskWarning?,
followupQuestion }`. **Status:** the prose answer + token usage are live; the meta pass
is currently a stub (empty `talkingPoints`, `star: null`, only a `riskWarning` when no
context matched) — the M2 structured second pass is not yet implemented. The handler
relays deltas to the overlay and persists the final answer to `ai_answers`.

**Memory grounding** — `buildMemoryBlock(memories)` (exported from answer.ts)
renders APPROVED memories recalled for the question into a clearly-delimited
prompt block; both `streamAnswer` and the voice quick-answer use it. Only
user-approved memories ever reach a prompt (see `services/memory/recall.ts`).

**In-session history** (2026-09-06) — `buildHistoryBlock(history)` renders what
THIS live session has already heard and answered (`SessionHistory`: `heard`
turns and `asked` question/answer pairs, oldest first) into an
`EARLIER IN THIS CONVERSATION` block placed right before `QUESTION:`, with an
instruction to resolve references against it and never cite or restate it. The
engine owns the buffer (`EngineSession.history`: 10 items, turns clipped to 300
chars, answers to 700; a regenerate updates its entry; the question's own turn
is excluded from its snapshot). Before this every cue was a stateless
two-message call, so "what about the second option?" was unanswerable in a
meeting — the Responses API is still called without `previous_response_id`; the
history is prompt text. A short follow-up (≤ 8 words) also carries the previous
question into the retrieval query. Absent/empty history leaves the prompt
byte-identical.

### Voice quick answers — `services/voice/quickAnswer.ts` (cross-reference)
The summon path ("Talk to BrainCue") streams a short spoken-style answer via
the `chat` capability, grounded the same way (RAG + approved memories). It
accepts an optional `personaPreamble` (built deterministically by
`engine/persona.ts` from companion personality prefs) prepended to its system
prompt — byte-identical prompts when absent. Sentence-level TTS chunking for
playback lives in `services/voice/sentenceStream.ts`.

### transcription.ts — `transcribeChunk(audio, mime) => string`
Sends an audio chunk to the transcription model; returns text (used for the
chunked path and mock-answer audio).

### realtime.ts — `RealtimeTranscriber`
Realtime API session for delta-level STT latency; PCM is streamed one-way via
`session:realtime-audio`. Event parsing lives in `realtimeEvents.ts`.

**Two streams, two transcribers (2026-09-07).** A live session hears BOTH the
call (system loopback) and the user's microphone; there is no "listen to"
choice any more. `engine.begin` opens one transcriber per captured stream
through `createRealtimeSource` (`providerFor('realtimeStt')`), from the
activity's capture plan (`shared/activities.ts` `capturePlan`):

| Stream | Speaker tag | Trigger? |
|---|---|---|
| `system` (the call) | the mode's `remoteSpeaker` — `them` (meeting), `interviewer` (interview) | **yes** — question detection / ambient policy run on these turns only |
| `mic` (the user) | the mode's `localSpeaker` — `you` (meeting), `candidate` (interview) | no — persisted, broadcast, remembered (`You said: …` in the answer prompt's history block), never answered |

**Echo guard** (`engine/echoGuard.ts`). On laptop speakers the microphone
hears the call, so every remote turn would arrive a second time as the user's
own words (Chromium's echo cancellation only cancels audio the renderer plays
itself, not Zoom/Meet in another window). Own turns are therefore *held* for
1.5 s before they are committed; if the call said the same words within the
last 6 s (≥ 80 % word overlap for turns of three words or more, exact match for
shorter ones) the own turn is dropped, in either arrival order. The
microphone is never the trigger path, so the hold adds no latency to
questions; `teardown` flushes anything still held. Drops are logged as a word
count only. Verified live 2026-09-07 with the same audio fed to both streams
170 ms apart on both engines: every mic copy dropped, every call turn kept.
| solo activities (`listensTo: 'mic'`) | one `mic` transcriber tagged `remoteSpeaker` (`you`) | yes — the user IS the trigger source |

Each `session:realtime-audio` frame carries its `source`, and
`engine.feedRealtimeAudio` routes it to that stream's transcriber. Interim
deltas are broadcast for the trigger stream only (the UI keeps one in-flight
line); the mic stream surfaces as finals. A session started without an activity
(the rehearsal facades, v1 rows on resume) opens the remote transcriber only,
as v1 did.

**Cost.** With the cloud engine this is two Realtime sockets per session, so
transcription cost roughly **doubles** (the mic socket is billed for its audio
whether or not the user speaks). The local engine (below) decodes both streams
on one recognizer at no extra cost beyond CPU.

This is the `openai` implementation of the `realtimeStt` capability. Since the
local engine landed, `realtimeStt` may instead resolve to `local` — the
sherpa-onnx worker in `services/stt/` — when the user picks it in Settings and
the model is installed (`services/stt/index.ts` `applySttSelection()`). Both
take the same base64 PCM16 24 kHz and emit the same deltas/finals, so the
engine does not know which one is speaking. `sttReady()` answers "can a live
session transcribe right now?" for either: a key for cloud, an installed
model for local. See [22 · Local speech-to-text](22-LOCAL-STT.md).

### coding.ts — `solveFromOcr(text, language)`, vision.ts — `solveFromImages(dataUrls[], language)`
Given a coding problem as text (clipboard/selection) or as one-or-more screenshots,
streams (explanation-first): a natural **Approach** paragraph, complexity, edge cases,
then the **optimal** solution as commented, runnable code. The shared prompt is
`codingRules(language)` (`codingPrompt.ts`): mandates the optimal solution + stated
time/space complexity, writes the code in the chosen `language` (default `javascript`,
a live Cue Card picker persisted as the `codingLanguage` setting), and requires clear
inline comments. Deliberately **résumé/JD-free** — a coding problem is unrelated to the
candidate's profile. Both paths use the same `coding` model + `reasoningParam('coding')`.
A long problem spans several viewports, so `solveFromImages` sends all captured screenshots
in ONE request (instruction-first, scroll order, `detail:'high'`) and the model reconstructs
them — the buffer + thumbnail strip + the `codingLanguage` lookup live in
`capture/codingMode.ts` (see `capture:add-region`/`solve-buffer`).

### interviewer.ts — `generateQuestion(...)` & tts.ts — `speak(text, voice)`
Power the mock-interview mode: `generateQuestion` produces the next question and
per-answer feedback; `speak` renders the interviewer's voice (returns audio Buffer).

### feedback.ts — `evaluateAnswer(input) => SparringFeedback`
Powers **Sparring** (the two-way voice mock). Given the question, the candidate's
transcribed spoken answer, and their résumé/JD context, one Responses call
(`mock` model, `json_object`) returns coaching feedback — `verdict`, a 1–5 `rating`,
`strengths[]`, `improvements[]`, and one actionable `tip` (ideally naming a real résumé
item they could have used). Output is defensively parsed: the rating is rounded + clamped
to 1–5, arrays are string-filtered, and missing fields default — a malformed model reply
can't crash the turn loop. The prompt judges ONLY what the candidate actually said and
forbids inventing experience.

The `sparringManager` (in-memory, no DB) drives the turns:
`generateQuestion` + `speak` to ask, `transcribeChunk` on the recorded clip, then
`evaluateAnswer`; the question is committed to history only after TTS succeeds so a
transient failure can't skip a turn.

## Cross-cutting
- **Cost/usage**: each call returns token usage; persisted on `ai_answers.tokens`
  and surfaced in the UI ("what was sent to OpenAI").
- **Grounding guard**: a post-check can flag answers that reference entities not
  present in the context (best-effort).
- **Abort**: every streaming call accepts an `AbortSignal` so pause/stop cancels
  in-flight generation.
- **Privacy**: context sent to OpenAI is exactly the retrieved chunks + question
  + profile summary — shown verbatim in the "Data sent" panel.

### When nothing in the Space matches (fabrication guard, per framing)

The system prompt's FABRICATION GUARD is framing-specific. The **interview**
text is v1, byte for byte ("not in their background… transferable skills").
The **conversation** text (meetings, companion) forbids a plausible figure,
date, status or decision outright, asks for a leading "⚠" and one clause
saying it is not in the notes, then only what *is* grounded — what the notes
do say, who would know, or the one question to ask back. Two more things
change under conversation framing when `contextChunks` is empty: the
`CONTEXT:` block itself reads "(NOTHING in this Space matches the question… no
figure, no status, no decision, no owner…)" — the cue sits where the model
looks for facts, which is what finally made the rule hold — and the `meta`
`riskWarning` is "Nothing in this Space covers this — the answer is not
grounded." (interview keeps "No matching profile experience found."). Verified
live 2026-09-07: "what is our Q3 budget" on an empty Space went from "$500K…"
to "⚠ Budget for Q3 marketing isn't in my notes. — Ask Finance or Marketing
leads…".
