# Engine Extraction Plan — v2 execution contract

> Status: audit done + plan approved 2026-07-21 (Prompt 0 of the external
> implementation-prompts doc). This is the condensed execution contract for
> Prompts 1–5; vision [00](./00-VISION.md) · spec [01](./01-PRD.md) · roadmap
> [10](./10-ROADMAP.md) · UX [11](./11-UX-NAVIGATION.md).

## Verdict

No rewrite. Extract the proven interview vertical slice into a generic
conversation engine; add modes as configuration. The riskiest asset is the
concurrency discipline in `sessionManager.ts` — the `answering`/`answerAbort`
slot-ownership rules ([sessionManager.ts:512-521](../src/main/services/session/sessionManager.ts#L512-L521)),
the synchronous slot claim before the classify await, abort-before-broadcast
ordering, delete-then-insert answer replacement only after stream completion,
and the follow-up generation guard. These are pinned by parity tests
(`sessionManager.parity.test.ts`) before anything moves.

## Naming (locked)

**Space** in the UI, **ContextPack** internally (jobs → packs of `kind='job'`;
kinds: `job|subject|project|meeting|personal|game|custom`).
`SessionMode = interview|practice|interviewer_assist|meeting|tutor|companion`.
Every output becomes a **Contribution** (`planned → streaming → completed →
dismissed/accepted/corrected/failed`), kinds: answer, code, context,
action_item, open_question, suggested_question, coverage, warning,
tutor_prompt, memory_suggestion, summary. `Speaker → you|them|agent|unknown`
(old rows mapped at read). The LLM classifies salience; **deterministic gates**
(confidence, cooldown, presence, mute, budget) decide whether to speak.
Providers are **capability interfaces** (Chat / Embedding / RealtimeStt /
BatchStt / Speech / Vision), never one god interface. These supersede the older
"Context Pack (UI)" wording in 01-PRD/11-UX and the roadmap's Phase-2
multi-provider slot (seam at Prompt 4, second provider deferred to Prompt 11).

## Target structure

```
src/main/services/engine/                      src/main/providers/
  engine.ts  engineSession.ts  modeDefinition.ts  types.ts  registry.ts  errors.ts
  contextEvent.ts  contribution.ts  grounding.ts   openai/{chat,embeddings,realtimeStt,
  sourceAdapter.ts  persistence/                            batchStt,speech,vision}.ts
  trigger/{triggerPolicy,reactiveQuestionPolicy,summonedPolicy}.ts
  modes/interview.mode.ts        // persona, scenario config, follow-up, STAR cues
```

`sessionManager.ts` stays as a thin facade; every existing IPC channel keeps
its exact signature. `AnswerEvent` (delta/meta/usage) is already shared across
answer/coding/vision and becomes the provider-neutral `ChatEvent`.

## Migration sequence (rollback = boot-time DB backup, added in Prompt 2)

| Mig | Contents | Risk |
| --- | --- | --- |
| 0008 ✅ | **Rename went LOGICAL, not physical** (shipped 2026-07-21): TS/table objects are `contextPacks`/`packId` but physical names stay `jobs`/`job_id` — drizzle maps them, so no table rebuild, no FK re-pointing, no `fkRebuild.ts` changes, and `db:generate` stayed non-interactive. Shipped as three ALTERs (+`jobs.kind` default 'job', +`sessions.mode` default 'interview', −`profiles.answer_style`) + a mode backfill UPDATE (live→interview, mock/sparring→practice) | Was **High** under the physical plan; **Low** as shipped — plus fixture-DB test + backup-before-migrate |
| 0009 | `contributions` table; interview answers dual-write (`ai_answers` stays source of truth) | Low |
| 0010 | `embeddings.provider` (default `'openai'`; model+dim already stored); mismatch → explicit re-index requirement | Low |

Speaker strings stay on disk; repos map old↔new at read. No row deletion
anywhere; the only destructive DDL is the provably-dead `answer_style`.

## Compatibility rules

- No IPC channel renamed/removed through Prompt 5; new `engine:*` +
  `contribution` events are additive; an adapter dual-emits legacy
  `answerDelta/Meta/Done/Reset/Followup` until the overlay migrates.
- The interviewType/answerFormat zod enums (duplicated inline in
  session/mock/sparring/profiles `.ipc.ts`) are extracted to one shared module
  in Prompt 2.
- Overlay: `answerCards.ts` seeds the ContributionCard store (`isCoding` →
  `kind`); unknown kinds render a safe fallback card. Frozen e2e selectors:
  window sizes, `/Stop|Pause/` button text, the `Interviews` h3.

## Gates (every PR)

Typecheck + build + full unit suite; phase boundaries also run
`scripts/privacy-affinity/hardtest.js`. Baseline guardrails (Prompt 1):
`src/main/test/architecture.test.ts` (renderer/preload/shared can never import
OpenAI/DB/electron-main modules; built renderer bundle carries no
`api.openai.com`/key-store/DB markers) and
`sessionManager.parity.test.ts` (start → transcript persistence → classify
gate → retrieval → stream order → persistence → stop, plus the stale-abort
race). Test DB: real drizzle migrations on in-memory **sql.js**
(`src/main/test/dbHarness.ts` — better-sqlite3 is Electron-ABI and can't load
under vitest); the harness's `fixture` param is Prompt 2's migration-test
entry point.

## PR sequence

1. `feat/v2-baseline` — Prompt 1: lockfile metadata repair + the guardrail
   tests above. Zero runtime changes. ✅ this PR
2. `feat/v2-schema-packs` — Prompt 2: 0008 + backup-before-migrate + shared
   zod enums + repo aliases + fixture test; docs 04/05 regenerated.
3. `feat/v2-engine` — Prompt 3: engine extraction + 0009; golden
   event-sequence parity; docs 02/05/06.
4. `feat/v2-providers-seam` — Prompt 4: capability interfaces, OpenAI as
   reference impl, 0010; engine-on-fakes suite.
5. `feat/v2-contribution-cards` — Prompt 5: overlay decomposition.
6. Prompts 6–11 per the external doc (Spaces UX → Meeting → Memory → Voice →
   Companion → hardening).

## Known doc drift (fix in the PR that touches each subsystem)

04-DATABASE: lists dropped `ai_answers` columns, omits `sessions.kind` and the
`answer_feedback` table, claims a nonexistent `transcript_chunk_id` FK, stale
enums/settings keys. 05-IPC-MAP: missing `story_teller`, phantom rich
`answer-meta` payload, missing `answer-followup`/`transcriber-status`/
`overlay-clickthrough`, stale domain list. 03-WINDOWS: overlay event table
lists 6 of ~18 subscriptions. 06-OPENAI-SERVICE: wrong classifier type name
(`ClassifiedQuestion` + `isQuestion`), contradicted coding output order,
missing `tailor` preset/effort and its 300s/no-retry override.
02-ARCHITECTURE: `vectors/` dir is provisioned but unused (embeddings live
in-DB).
