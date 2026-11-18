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
   replaces the queued text, or re-answers the streaming, answered or missed
   card when the candidate has not spoken since — added words are never
   dropped as a duplicate.
4. **Continuations and corrections supersede.** "…and how you tested it" or
   "Sorry, I meant the second project" within 8 s of the last question, before
   the candidate has spoken, re-answers **the same card** (same question row)
   with the joined wording; the scheduler's own in-flight stream of it is
   aborted first. A revision never takes the slot from a manual Ask or
   regenerate: it waits at the head of the queue, on the same card.
5. **Fragments wait** 1.2 s for their second half.
6. **Nothing disappears silently.** A distinct question that will not be
   answered automatically becomes a visible card with no answer and "Press ↻
   to answer it": past 3 queued questions (the oldest waiting one), when the
   user pauses with it waiting **or still being classified**, or when the
   model recognised it only after the conversation moved on (§8). Every
   outcome that lands after a Pause (on time, a late "yes" after a timeout,
   a revision routed by rule — a longer repeat, a continuation or a
   correction — or a revision whose stale answer was still being cancelled)
   takes the same path to a missed card and is never started automatically,
   even after Resume; a revision is marked on its question's own card. A
   copy that adds no words to a question already in flight, waiting,
   answered or shown missed gets no second card; a longer one is a revision,
   never discarded. One job per card: a revision updates the question the
   scheduler keeps routing against, so a follow-up after Resume continues
   the wording the card shows (re-answering it), never an older one. An
   answer still streaming its old wording finishes on that input; its card
   shows the revision when it ends. Only Stop drops work.
   While paused, new finals are not evaluated (that is Pause).
7. **Decisions commit in arrival order** (M3). Detection runs concurrently —
   a slow classifier call never blocks the next turn's detection — but each
   turn's decision (queue, coalesce, supersede, drop) is applied only after
   every earlier turn's decision. The repeat/continuation checks run again at
   commit time, against the state earlier turns left. Cost: a turn decided by
   rule in 0 ms can wait for an earlier turn's classifier, bounded by the
   1.2 s classifier timeout.
8. **Late verdicts.** A late model "yes" for a question meanwhile asked again
   and handled produces nothing; otherwise it is answered — unless a newer
   interviewer question was asked, the candidate has started replying, or
   the session was paused since, in which case it becomes a missed card
   ("Recognised as a question only after the conversation moved on").
   "Asked again" means a copy that adds nothing: a late LONGER copy revises
   the newest question's card when that is its shorter copy and the
   candidate has not replied, and is otherwise a missed card carrying the
   added words.

**Supersession, precisely.** A turn revises an earlier question only when it
repeats it (3) or continues/corrects the LAST question within the window,
before candidate speech (4). The LAST question is the newest one decided —
answered, waiting, streaming or shown missed (a question missed across a
Pause is continued after Resume) — newest by arrival order, since two finals
can share a millisecond — and only a newer one replaces it: a queued
question starting later, or an older late verdict, never does. Every
revision (a longer copy coalescing into a queued question, a continuation,
a correction, a revision across Pause) refreshes the same metadata: wording,
transcript chunks, timing (so the continuation window runs from the
revision), arrival order and the continuation target, keeping the card and
its queue position. Never when the rules read it as not-a-question
("Sorry, can you hear me okay?" is logistics, not a correction), and never
when it is a complete question after a conjunction ("And why are you
interested in this role?" is a new card, in any capitalisation — the
transcriber often lower-cases a new turn). Everything else is a new question,
in arrival order.

Interim transcripts never create a card (they only prefetch grounding). The
candidate's own microphone turns are recorded and close the continuation
window, but never trigger. They are ordered against the interviewer's turns
by when they were captured (not by timestamp, which can tie), and count only
once the echo guard confirms them — a dropped echo never closes the window.
The continuation window runs from the latest turn that contributed to a
question: an older late copy can enrich its wording but never rewinds it. The Cue Card's **Answer that** button answers the
interviewer's latest words (joining a split question) when detection missed.

## 3. In-session continuity (`conversationContext.ts`)

The 10-item, 300-character history buffer was the only continuity, and it
showed BrainCue's own suggestion as "You answered:", so a short follow-up
retrieved on wording the candidate may never have said. It is replaced by a
per-session context, rendered per answer as a **snapshot taken synchronously
at stream start** (turns arriving mid-stream cannot change it).

**Turns are stored whole; budgets apply when a snapshot renders** (M4). Until
M4 every turn was clipped to 600 characters on the way IN, so the end of a
long answer — usually the project name and the figure — was gone before
recall could search it. Each rendered block now uses `excerpt()`: the text is
cut into pieces — sentences, and any piece longer than a small window (a
run-on sentence, or a transcript with no punctuation at all) into word
windows — and it keeps the first piece, then the pieces sharing words with the
question, then those with figures or names, in spoken order, with " … " for
omissions. Memory holds up
to 3 000 turns / 2 M characters per session; past that the oldest turns leave
memory but not the search — recall reads them from **this session's**
persisted transcript.


| Block | What | Bound |
| --- | --- | --- |
| recent | last turns, speaker-labelled, numbered `[#n]` | 12 turns / 3 600 chars, 1 200 per turn |
| earlier | one line per earlier exchange: the question + what the candidate actually said | 12 exchanges, 160 + 260 chars |
| recalled | older turns BM25-matched to this question (searched whole) | 3 turns / 500 chars each |
| open | earlier questions the candidate never answered | 3 |
| suggestions | BrainCue's earlier leads — labelled *not evidence* | 3, 180 chars |
| subject | for a referential follow-up only, the exchange it continues | 1, 700 chars said |

The whole conversation block has a tested ceiling (under 16 000 characters).

No model call and no summarisation pass: deterministic, so it can never invent
a fact, and it costs nothing on the hot path. Turns are ordered by when they
were **spoken** (the echo guard commits own turns ~1.5 s late). A follow-up is
referential when it is short and anaphoric ("Why that one?", "What was your
role there?") and names nothing new; a topic shift ("Let's move on…", "And what
about Kubernetes?") is not. Retrieval for a referential follow-up carries the
subject from **what the candidate said**; BrainCue's suggestion stands in only
when no candidate speech was captured (no microphone).

**Resume** restores the session's own turns and answers from its rows
(`enginePersistence.sessionTimeline`, scoped by session id). Transcript rows
now carry when each turn was **spoken** (ms) and the engine's **capture order**
(`capture_seq`, taken as the final arrives — before the echo guard holds the
candidate's turns), and are read back in one order (`db/transcriptOrder.ts`:
spoken time, capture order, then insertion for rows without one). The live
context breaks ties the same way, and Resume continues the capture counter.
The snapshot splits recent from older turns by **position** in that order, not
by time — a time boundary left turns tied with the oldest recent one in
neither block, so recall, earlier exchanges and open questions all missed them. Before M4 they carried
the insert time at one-second resolution, so after resume a reply still in the
echo hold when the next question arrived sorted after that question. Each session owns
its context, so another session, profile or Space can never leak into an
answer; retrieval stays scoped to the session's profile and Space. Continuity
does not depend on long-term memory or archives (both optional and
consent-gated).

## 4. Grounding and answer behaviour (`openai/answer.ts`, `rag/retriever.ts`)

- **Sources are ranked in the system prompt.** Facts about the candidate come
  only from their own material — CONTEXT chunks labelled as theirs (`resume`,
  tailored résumé, `profile`, `story`, `note`), MEMORY — and "You said" lines.
  `(jd)` and `(company)` chunks describe the employer and are never evidence of
  the candidate's experience; a requirement their material does not show is a
  gap to bridge honestly. "BrainCue suggested" lines prove nothing. General
  knowledge may explain a concept, never become a claim about the candidate.
- **Coaching reports coach what the candidate said** (`session/report.ts`,
  M4). Speech is attributed to the interviewer turn it followed: every
  interviewer turn is a boundary (backchannel and call logistics aside), not
  only those BrainCue made a card for, so a reply to a question detection
  missed is coached under that question (marked *not detected live*), never
  under the card before it. BrainCue's suggestion travels separately, labelled
  *not the candidate's answer*. A question with no captured speech is reported
  as such and never assessed; a typed Ask has no spoken turn and says so; with
  no speech at all there is no model call. Every request is capped (24 000
  characters): exchanges go out in numbered batches and the batch summaries
  are combined in one bounded call — the old 24 000-character tail cut dropped
  later questions.
  Sparring keeps its own spoken-answer feedback report.
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

**What the UI names (M7.2a, AI-01).** Two tasks are visible during an
interview, and each control says which one it sets: **Interview answers**
(`answer`, every spoken question, in every interview, coding included) and
**Coding solver** (`coding`, Solve clipboard and Capture). A coding-only
setting never reads as the answer setting.

- **What a control shows.** Each control shows main's route for the next
  request: `effectiveModels`, after override checks, discovery and runtime
  unavailability. It does not show the stored override, and it does not
  show the OpenAI preset table (`modelDefaults`), which named an OpenAI
  model for a user whose answers ran on another provider.
- **Automatic.** Its first row clears the override. It is labelled with the
  model it would use (`autoModels`), and any `modelNotices` text is shown in
  the control's detail.
- **Where the controls are.**
  - **Cue Card ⋯ tray:** the Interview answers chip always. In a coding
    interview, a Coding solver chip beside the solve tools.
  - **Cue Card settings:** the solver through the same shared picker. The old
    hard-coded list is gone.
  - **Dashboard:** the Advanced table uses the same names.
- **What a pick does.** Changing the answer model re-answers the current
  question. Changing the solver applies to the next solve.
- **Refresh.** `settings:changed` carries the fresh settings (key presence
  only) to every window. It is sent:
  - after any settings write or key change;
  - whenever a route moves without a write: a model marked unavailable, a
    new discovery list (`onRoutesChanged`).
- **Ordering (M7.2a correction).** A view hears settings in three ways: its
  own reads, its own write replies, and main's push. Replies can land after
  something newer. In `3557fa9` a held read put the previous model back on the
  chip, and Cue Card settings then saved that model back.
  - Each view (Cue Card, Cue Card settings, dashboard store) now orders what
    it receives through `renderer/lib/settingsFeed.ts`. A push always applies.
    A reply applies only if nothing newer has arrived since it was requested:
    no push, no other applied reply, no user edit there.
  - Dropping a reply loses nothing, because main pushes every change to every
    window, in order.
  - Cue Card settings keeps one feed for the Cue Card's lifetime, so a read
    from before a close/reopen is covered too.
- **Writes name one field.** A control writes only what was edited:
  `settings.set` `{ modelOverrides: { [task]: id | null } }` or
  `{ effortOverrides: … }`, merged by main against the stored map
  (`shared/settingsOverrides.ts`).
  - Changing the solver's effort keeps its model, and changing the model keeps
    the effort. No other task's override is written from a renderer's copy.
  - The Cue Card chips, Cue Card settings, the dashboard's per-task table and
    the cloud speech model all write this way. Whole-map `models` writes
    remain only for resets.
- **Unsaved dashboard drafts (AI-02).** Main sends a fresh `models` map with
  every push, so the Language Models card no longer resets its draft when
  one arrives.
  - An incoming snapshot refreshes only the tasks not edited in the card.
  - A task leaves "edited" only when its Save is confirmed, and only if it
    was not edited again while that Save was in flight.
  - Save with nothing edited writes nothing and says so.
  - Advanced opens when overrides are active, and is never closed by a push.
- **Compact catalogs (UI-03).** The kit `Dropdown` list is as wide as its
  longest row, but never wider than its window (8 px margin), and at least
  as wide as its control. Long rows wrap rather than truncate.
  - Before, `min-w-max` overrode the cap: the full OpenAI + Anthropic catalog
    was 495 px wide in 360 and 467 px Cue Cards.
  - The list is shifted inside the window and held to the room on its side.
    It is placed again when the window or the list changes size while open.
- **Next request versus existing answer.** The chips describe the next
  request. An existing answer is described by its own route, captured when it
  was sent:
  - Each card says "Answered by …" (`AnswerMetaEvent.answeredBy`). Its detail
    gives the provider and any attempt that failed over first.
  - "Sources sent to …" names the provider that card's context went to
    (`ContextSentEvent.sentTo`).
  - The saved contribution keeps `answeredBy` in its meta.
- **Route pinning.** A settings change while an answer streams applies to the
  next question; it never relabels or moves the one in flight. The coding
  solver now captures its route the same way (`streamToOverlay` →
  `solveFromOcr` / `streamSolve` `route`); before, it re-resolved inside
  each adapter.
- **Diagnostics.** Each attempt logs `answer attempt N → provider/model` and
  `answer served by …`, plus `coding solve → …`. These lines never include a
  key or any transcript text. The latency record's provider/model is the
  attempt that answered, with `failedAttempts`, not the dispatch seed.

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

**The renderer reads readiness from ONE place** (M5, `store/useReadiness.ts`):
first-run setup (`onboardingEntry`, the Done summary), Home's Finish-setup
card (`setupChecklistState.ts`), the start flow and the Interview page's
gate. It is refreshed whenever the settings store reloads (every key, preset,
override or engine change does) and when a model download finishes. There is
no OpenAI-key gate left on the default path: Anthropic (or any keyed
provider) with on-device transcription is complete; cloud transcription says
it needs an OpenAI key, and the onboarding provider tiles say what an OpenAI
key adds instead of marking it required. Sample data parses its résumé on the
parsing task's provider, so the sample interview can start on any provider.

## 7. Interview-first UI

- `DEFAULT_ACTIVITY` is `job` (Interview) and leads `ACTIVITY_ORDER`; stored
  Spaces and sessions keep their kinds; an unknown kind still reads `custom`.
- **Home** (M5): one dominant **Start interview**; Other conversation,
  Practice, Solve from screen (and Talk to BrainCue, when on) are small
  secondary actions; recent sessions; everything else — status chips, the
  other activities, Labs — under a collapsed "More ways to use BrainCue".
- **One start flow** (M5, `StartSessionModal`). For an interview it asks
  nothing but the **role**, then shows four one-line rows — Résumé, Role & JD,
  Audio (what is heard + which engine), AI (provider · model; keyword
  matching noted, not blocking) — each gap with its fix (a missing JD opens
  that role's form in place). A blocked row shows its fix as text under it,
  not only on hover; the AI row names the task and provider that is actually
  blocked (`readiness.chat.blocked` — a keyless classify override reads "no
  Anthropic key (question detection)", not the healthy answer provider). The
  activity question appears only for Other conversation or a Space of another
  kind. Practice is one quiet link. A gap is said once (on its row).
- **Disclosure** (collapsed, above Start; nothing is recorded before Start):
  what is captured, and what is sent **to whom** from `readiness.routes` —
  to the answer provider: each question, matching passages, recent and
  earlier conversation (both sides), earlier suggestions and matching
  approved memories; to the classify provider: unsettled interviewer turns
  with the last few turns, and each question with BrainCue's answer for
  follow-up prediction; to OpenAI when documents are matched by meaning; to
  the parsing provider, if kept, the transcript for the summary and memory
  suggestions.
- **Returning user: two actions.** The role defaults to the one this
  profile last interviewed for, read by id from main wherever it sits
  (`resolveDefaultSpace`; the only role if there is exactly one; never a
  guess among several). The chosen role is held as its own validated record
  (`spaceFits`: this profile, this activity), apart from the picker's page of
  100 — a role handed in or remembered is never replaced because it is not on
  that page (`pickerOptions` keeps it listed); older roles are found by
  search. A profile switch clears the choice; a deleted role is dropped from
  the default, and the role is re-read before Start, so a deleted one is
  never started against. Every lookup that can set the choice carries a
  choice generation; closing, reopening, a profile or activity change and any
  newer choice start a new one, so a late reply — success, failure or
  finalisation — never puts back a role the user has moved away from. Home → Start interview → Start
  interview. On Windows the call audio needs no OS picker (loopback); the
  first microphone use may show the OS permission prompt.
- **Interview-only lists.** `jobs.page` takes an `activity` filter
  (server-side, exact totals); the Interview page lists roles only, and
  Resume is offered only for a real interview (`isResumableInterview`: a
  live, interview-mode session — never a meeting, companion session, mock or
  sparring drill). The page's Start opens the same start flow with the role
  chosen; roles are created as interview Spaces (kind fixed, "New role").
- **Resume goes through the start flow** (M6). From the Interview page or a
  session's detail, Resume opens `StartSessionModal` with `resume`: the same
  readiness rows and disclosure, the role fixed to the interview's own
  ("Continuing the round from … — its transcript is restored and kept"), and
  an explicit **Resume interview** that continues the SAME session
  (`resumeExisting`). Another profile's interview, or one whose role was
  deleted, is blocked with why. Pressing Resume re-reads the session and its
  role as they are NOW, before any capture: still this profile's, still an
  interview, its role still there (a failed read starts nothing and says
  so). Main checks again in `engine.resume` — a missing or other-profile
  Space, or an interview with no role, is refused before the row goes live.
  Earlier content is never deleted.
- **The Cue Card** (M6, `overlay/Overlay.tsx`, `cueLayout.ts`). The header
  says what the session is doing (Listening / Answering / Paused /
  Reconnecting) and holds the live controls: Privacy, click-through,
  ⏸ Pause / ▶ Resume, ■ Stop, ⋯, hide. Then the capture warning (a missing
  stream, and what it costs), the latest transcript line (full transcript one
  tap away), **missed questions** — each with why (asked while paused,
  recognised late, asked while others waited; `AnswerMetaEvent.missed`) and
  **Answer it** — and the ONE current card: the question large, its answer,
  its retry, and "Sources sent to <answer provider>" collapsed. Earlier cards
  are kept, in arrival order, behind "Earlier (n)". Style, model, answer
  history, pronunciation, clear, the capture tools, view, settings and what
  the session is grounded in live in the ⋯ tray. A missed question never
  becomes the current card (it would push the last answer out of view) and is
  never dropped, even with answer history off. Arrival order, manual-Ask
  ownership and same-card revisions are main's and the reducer's — the
  layout only arranges them. Coding keeps its listen-only toggle visible.
  The ⋯ tray closes on an outside press, Escape or window blur; its inner
  model list consumes Escape first. Settings replaces the tray. Open controls
  suspend click-through so their outside press reaches the Cue Card.
- **Readable history** (M6, `SessionsPage`, `SessionDetailModal`,
  `sessionTimeline.ts`). Sessions are paged on the server (`session:page`).
  Opening one reads the persisted session only (`session:get`) — no key, no
  report, no network — and shows it as a timeline in capture order: what
  each person said (Interviewer / You, or Them / You), each detected question
  with "Suggested by BrainCue — not said" (or "Not answered — <why>"), and a
  meeting's other cards marked generated. A coaching report is an explicit
  button that names where the transcript goes; its failure leaves the
  conversation readable. A meeting's report is generated only when asked
  for. Delete asks first.
- **Keep / Discard** (M6, `SavePromptModal`, `keepCopy.ts`): see
  [16-CONTINUITY.md §3](./16-CONTINUITY.md) — typed outcomes per half, the
  provider named, Retry on failure, the destination validated wherever the
  picker found it, and the prompt held open while it works.
- **Keyboard and drafts** (M6, `components/ui.tsx`). `Modal` keeps focus
  inside (Tab / Shift+Tab wrap; focus that wanders is brought back), returns
  it on close, and never re-runs its focus effect on a re-render. Dismissal
  (Escape, backdrop, ×, or a body's own Cancel via `ModalCancel` /
  `useModalDismiss`) goes through a guard: `busy` refuses it and says so;
  `dirty` asks "Discard your changes?" with **Keep editing** focused. Only the
  top modal answers Escape, and an open inner control (a dropdown, the
  discard question) closes first. `Dropdown` is a select-only combobox:
  arrows / Home / End move, Enter / Space choose, type-ahead, Escape closes
  the list, `aria-expanded` / `aria-activedescendant` / `aria-selected`
  exposed; options keep focus on the combobox. Hover detail is also shown on
  keyboard focus (`TooltipShield`), and a readiness row with detail is
  focusable. The role form and the new-profile form are guarded.
  Dropdown outside presses are observed in capture phase, including inside
  dialogs that stop bubbling; moving focus away also dismisses the list.
  Tooltips wrap to the viewport and use their measured size to stay inside
  the protected window, with an eight-pixel inset. Resizing hides stale tips.
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
    The rollback is held in MAIN (`engine.rollback`, M6) from before its
    stop until confirmed: main sends no save prompt for it, and any later
    Stop of that session — the dashboard's, or the Cue Card's
    `stopActive` — runs the same rollback rather than a plain stop that
    would offer Keep. Each outcome is broadcast (`session:rollback-result`)
    so both windows say the same thing. A later successful run of the same
    session prompts normally. Only what was confirmed is claimed: a
    rejected stop leaves the session in the store, visibly live, with "may
    still be running" and `cleanup: 'failed'`, and Stop (either window)
    retries the same rollback; nothing is deleted before the stop is
    confirmed. A stop that succeeds with a failed delete says so and names
    the record to remove from Sessions.

  The start modal stays open on any failure and shows the reason. Capture
  status is reported only AFTER the pipeline is attached, and a track that
  already ended during setup is not reported as live. One missing stream is
  still a running session with a notice that names the missing side.

## 8. Evidence and how to re-measure

**Open user-reported acceptance items (2026-11-18):** [BOARD.md — user
follow-ups](./BOARD.md#user-follow-ups--model-clarity-interview-speed-and-cue-card-polish-2026-11-18)
tracks AI-01 (task-specific model clarity and proof of the actual request
route) and PERF-01 (slow General/simple Technical answers). M7.2a resolves
model clarity first; M7.2b requires warm final-to-first-useful-answer paint
p50 <=1.5 s / p95 <=3 s for General and simple Technical separately, with
full retrieval/context, cold results and speech-end latency reported too.
Coding gets a separate justified budget. The historical results below do
not close these items. UI-01/UI-02 (the Cue Card popover fixes) are committed
with M7.2a.

**Instrumentation** (`engine/metrics/latency.ts`, M7.2b). One record per
automatically detected question, each stage on its own:

| Stage | What it measures |
| --- | --- |
| speech end → final | the transcriber's endpoint wait. `speechEndSource`: `vad` (the server VAD's speech-stopped, OpenAI Realtime) or `last-delta` (the last interim word — the local engine has no VAD event; approximate) |
| final → decision | question detection; also kept for EVERY evaluated turn, question or not |
| decision → dispatch | waiting for the answer slot (queue) |
| dispatch → request | waiting for documents and memory. `retrievalMs` / `recallMs` are each one's own run time, which may have started on the interim |
| request → first token | the provider: connection, queueing, first token |
| final → **first useful** paint | the acceptance measure: the overlay reports after paint (two animation frames), and only once the painted text holds a real word (`renderer/lib/usefulText.ts`) — a bare `**` or `- ` is not an answer |
| speech end → first useful, final → complete | so slow endpointing or long answers cannot hide behind fast generation |

- **Every question ends with an outcome:** `answered`, `empty`,
  `failed` (with the error kind: auth, quota, model, network…), `aborted`
  (Stop, a manual Ask or regenerate took the slot), `superseded` (a
  revision re-answered it — written to the file; the latest take is the
  sample) or `missed` (a missed card: queue-full, paused, late). Each is
  written to `<userData>/metrics/latency.jsonl` when it ends — an answered one
  once its paint report arrives, or after 3 s without one (Cue Card hidden:
  counted as not painted).
- **Buckets:** General, Technical (the Technical style, or a
  technical-concept / system-design question) and coding (a coding
  question) are summarised apart, cold (first answer of the process) and
  warm. `endToEnd` counts an unanswered question as slower than any
  answer, so a failure can push p95 to "not answered" but never make it
  look faster. Each bucket also lists its outcome counts.
- **Takes:** a revision starts a new take; a stale stream of the earlier
  take, finishing late, cannot write into it. Manual asks and regenerates
  are not timed.
- **Content:** ids, timestamps, counts (chunks, memories, tokens), route
  names and outcome codes only — never transcript, answer text or a key.
  `api.metrics.latency()` returns the summary plus hardware.

**What M7.2b changed on the answer path** (`engineSession.gather`,
`rag/liveEmbed.ts`):

- **Memory with the documents, on the interim.** Memory recall used to start
  only after document retrieval finished — a second query-embedding round
  trip, in series, on every answer with memory on, and never prefetched.
  Both now run in parallel, and both start on the interim transcript when it
  first reads as the question. Memories are marked used only when an answer
  uses them, so a discarded prefetch changes nothing.
- **One embedding per question.** Retrieval and recall share the request
  for the same text (a few entries, a few seconds, in memory only).
- **A bounded embedding.** The live query embedding gives up after 2.5 s
  (the indexing client retries for up to minutes). Past it, the SAME
  documents and memories are ranked lexically for that question — the
  knowledge base is never dropped; memory recall falls back to what the
  question names instead of returning nothing, as it did on any embedding
  failure before. The record and log say which side fell back.
- **Unchanged:** the provider/model chosen, same-provider retry limits,
  scheduling, Pause/Stop, the answer prompt and its grounding. Live answers
  stay on the interactive `answer` task at the model's lowest reasoning
  effort, whatever the style, interview type or question type
  (`openai/answer.route.test.ts`); the coding solver is a separate feature.

**Offline pipeline benchmark** (`engine/latency.pipeline.test.ts`; the real
engine, scheduler, retrieval and recall on fake timers, simulated
providers — not live numbers). Model: one embedding 700 ms, a stalled one
6 s (every tenth question), provider first token 1 000 ms; the interim reads
as the question 1.2 s before the final for two of every three questions.
30 General + 30 Technical questions, final → first token:

| | before M7.2b (`8d0c24d`) | after |
| --- | --- | --- |
| p50 | 1 700 ms | 1 000 ms |
| p95 | 11 800 ms | 2 300 ms |
| max | 13 000 ms | 3 500 ms |
| embedding calls | 60 | 30 |

On this model the pipeline now adds nothing to the provider's first token
when context was gathered on the interim, one embedding round trip when
the question is recognised only at its final, and at most the 2.5 s cap
when an embedding stalls. Live General/Technical acceptance (warm final →
first useful paint p50 ≤ 1.5 s, p95 ≤ 3 s, n ≥ 30 each, five or more cold
starts) still needs the authorized live run; the provider's own first-token
time (1.9 s / 3.2 s p50 / p95 measured on 2026-11-17, below) is the larger
share and is not changed here.

**Coding budget (proposed, not measured).** The coding solver (screen
capture → solve, the `coding` task with deeper reasoning) is held to its own
budget and never mixed into the interview numbers: first useful content
(the approach, before the code) p95 ≤ 10 s, the complete solution p95 ≤
45 s, a 90 s hard stop with Cancel available throughout and one same-provider
retry offered, never automatic. Reasoning models spend most of their time
before the first token, and the user is reading the problem meanwhile;
anything slower than that stops being help during a timed exercise. A
coding QUESTION heard in conversation is answered on the fast `answer` path
and measured in the coding bucket above.

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
