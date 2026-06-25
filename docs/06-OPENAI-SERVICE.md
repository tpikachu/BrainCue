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

## Cross-cutting
- **Cost/usage**: each call returns token usage; persisted on `ai_answers.tokens`
  and surfaced in the UI ("what was sent to OpenAI").
- **Grounding guard**: a post-check can flag answers that reference entities not
  present in the context (best-effort).
- **Abort**: every streaming call accepts an `AbortSignal` so pause/stop cancels
  in-flight generation.
- **Privacy**: context sent to OpenAI is exactly the retrieved chunks + question
  + profile summary — shown verbatim in the "Data sent" panel.
