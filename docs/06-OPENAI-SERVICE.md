# OpenAI Service Layer Design

Lives entirely in the **main process** under `src/main/services/openai/`.
The renderer never imports the SDK and never sees the key.

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

### embeddings.ts — `embed(texts: string[]) => Float32Array[]`
Batches inputs, returns vectors; caller stores BLOBs. Records model + dim.

### questions.ts — `classifyQuestion(text) => DetectedQuestion`
Small/fast model. Returns `{ text, type, confidence, strategy }`. Also used as a
cheap "is this actually a question?" gate before answer generation.

### answer.ts — `streamAnswer(input) => AsyncIterable<AnswerEvent>`
Input: `{ question, contextChunks, profile, style, length, pronunciation, interviewType, signal? }`.
Builds a **grounding** prompt:
- System: persona + rules ("ground answers in provided context; never invent
  experience; if no relevant experience, give a transferable-skills answer and
  set a risk warning"); LENGTH is a hard constraint.
- **Grounded / proof-linked answers:** `buildContext` numbers the chunks `[1] (resume) …`;
  the prompt makes the model cite those numbers inline after each grounded claim
  (e.g. `…cut p99 latency 40% [1]`). The Cue Card renders the cited `[i]` as source chips
  (the `Citations` component, backed by the `contextSent` chunks). **Fabrication guard:**
  for anything the context can't support the model must not invent it — it leads with
  `⚠`, says it's not in the candidate's background, and pivots to a cited transferable
  framing.
- User: question + retrieved context + profile summary + the chosen format/length,
  plus optional pronunciation hints for rare/technical terms.
- `length` (`key_points` | `detailed`) also sets a hard `max_output_tokens` ceiling
  (220 / 800) so "key points" can never drift long regardless of the prompt.
Streams tokens (`{type:'delta', token}`), then a `usage` event, then a structured
`meta` event `{ talkingPoints[], resumeMatch, star?, clarifyingQuestion?, riskWarning?,
followupQuestion }`. **Status:** the prose answer + token usage are live; the meta pass
is currently a stub (empty `talkingPoints`, `star: null`, only a `riskWarning` when no
context matched) — the M2 structured second pass is not yet implemented. The handler
relays deltas to the overlay and persists the final answer to `ai_answers`.

### transcription.ts — `transcribeChunk(audio, mime) => string`
Sends an audio chunk to the transcription model; returns text (used for the
chunked path and mock-answer audio).

### realtime.ts — `RealtimeTranscriber`
Realtime API session for delta-level STT latency; PCM is streamed one-way via
`session:realtime-audio`. Event parsing lives in `realtimeEvents.ts`.

### coding.ts — `solveFromOcr(text)`, vision.ts — `solveFromImages(dataUrls[])`
Given a coding problem as text (clipboard/selection) or as one-or-more screenshots,
streams: approach, edge cases, time/space complexity, solution outline (and code).
Both paths use the same `coding` model + `reasoningParam('coding')`. A long problem
spans several viewports, so `solveFromImages` sends all captured screenshots in ONE
request (instruction-first, scroll order, `detail:'high'`) and the model reconstructs
them — the buffer + thumbnail strip live in `capture/codingMode.ts` (see `capture:add-region`/`solve-buffer`).

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
