# 14 · Long-term memory

How BrainCue's per-profile long-term memory stores what it learns, how it stays
*true* over time, how it retrieves it, and how the user stays in control of it.

Driving requirement: a profile should accumulate a durable, correctable picture
of a person's work — good enough that an answer grounded in it is right about
the specifics, and never confidently states something the user has since
corrected.

Memory is one of the **two** things a conversation leaves behind. The other is
the session summary, and they are not the same thing — see
[16 · Continuity](16-CONTINUITY.md) for the split. Both require a Space:
`extractMemoryCandidates` returns 0 when `sessions.packId` is null.

## 1. The record

| Piece | Where |
| --- | --- |
| `memories` table — per profile, Space-scoped or profile-wide, category, provenance (`sourceRefs`), confidence, importance, sensitive flag, approval `status`, fact identity + validity + lineage, inline embedding + **embedding identity** (provider/model/dim), `createdAt`/`updatedAt`/`lastUsedAt`/`expiresAt` | `db/schema.ts` |
| Post-session extraction — LLM, zod-validated, ≤ 5 candidates, confidence floor 0.6, hard sensitive-content rejection; everything lands `pending` | `memory/extractor.ts` |
| Recall — hybrid semantic ∪ lexical, current-only, consent-gated globally and per Space, fails soft (`[]` never breaks an answer) | `memory/recall.ts`, `memory/lexical.ts` |
| Secrets / payment / health / sensitive-personal never persisted | `memory/sensitiveFilter.ts` |
| Review, approval, conflict resolution, editing, scope changes | `MemoryPage.tsx` → `memory.ipc.ts` |

Three invariants hold everywhere and are each pinned by a test:

1. **Only `approved` memory is ever recalled.** Extraction proposes; the user
   decides. Nothing reaches an answer without a click.
2. **Sensitive content is never written**, not even via a user edit — a paste
   into the review queue is re-checked, so the queue cannot be used to smuggle
   a secret past the filter.
3. **Recall never throws.** Every failure path returns `[]`. Memory improves an
   answer or is absent from it; it does not break one.

### 1.1 Scope

Two independent questions, deliberately kept apart:

- **Where a conversation is kept** — its Space. No Space, nothing kept.
- **How far what it taught reaches** — a candidate marked `profile` is stored
  profile-wide and recalled in every Space; one marked to a Space is recalled
  only inside it.

An interview Space learning "they drill into API design" should not colour a
standup. "Prefers concise bullet answers" should colour everything.

## 2. Consent

Long-term memory is **off until the user turns it on**. `memoryEnabled` gates
it globally; each Space can opt out individually. Both switches sit together on
the Memory page, because "summaries of conversations" and "long-term memory
about you" read as the same thing to a user and must be chosen side by side.

With consent off, the extractor is never called — the model does not see the
transcript at all. This is a real short-circuit, not a filter on the result.

## 3. Retrieval

Recall unions two paths and ranks the result. A memory surfaces when **either**

- its semantic score clears `MEMORY_MIN_SCORE` (0.25) — a topical match, or
- the query **names something specific that the memory actually contains** — an
  identifier, a figure, or a distinctly rare word (`hasExactAnchor`), and the
  lexical score clears `MEMORY_MIN_LEXICAL` (0.34).

then ranks by `semantic + 0.45·lexical + 0.05·importance + recency`, capped at
`MEMORY_TOP_K` (3) and clipped to `MEMORY_MAX_CHARS` (300) each.

**Why the second path exists.** Embeddings blur exactly the tokens a grounded
answer most needs to get right: proper nouns, ticket ids, version numbers,
dates, figures. `ATL-4471` and `ATL-4478` embed to nearly the same point; to a
person they are different tickets. Under a semantic-only gate a memory could
never be recalled *by naming the thing it is about* — "status of ATL-4471" sits
nowhere near the memory recording ATL-4471, and the cosine floor discarded it.

**Why the anchor is required and the lexical score alone is not enough.** A
vague query whose every word appears in a memory scores a perfect 1.0
lexically. Without the anchor test, "team plan" would drag in every memory
mentioning a team and a plan. The lexical path exists to surface exact
anchors, not to let filler words retrieve the whole store.

**Rarity is measured by document frequency, not IDF.** IDF is a *weight*, and
its magnitude moves with corpus size — the same token scores 0.69 among 2
memories and 2.0 among 40. An absolute IDF threshold silently stops working in
a small store, which is precisely where a new user lives.

Three filters run before any of this: **approval + scope + expiry + currency**
in `recallRows`, and **embedding identity** in `recall.ts` — vectors from a
different provider/model/dimension are skipped until re-embedded rather than
mis-ranked against the current space.

**Why not SQLite FTS5.** Evaluated and rejected. The test harness (sql.js)
ships FTS3/FTS4 but not FTS5, so an FTS5 virtual table would fail every
migration under test and leave this path — which decides what the app says out
loud — unverifiable. FTS4 has no BM25 ranking, which is the only reason to want
FTS in the first place.

## 4. Truthfulness over time

A memory store that cannot retire a fact will state last month's answer with
full confidence. That is worse than saying nothing, and it is the failure mode
a recurring meeting produces fastest.

### 4.1 Fact keys

A **single-valued** fact carries a `factKey` — a normalized slug like
`project:atlas/launch-date`, `person:sarah-chen/role`, `profile:user/job-title`.
Multi-valued and narrative memories (preferences, stories, workflows) leave it
null and keep coexisting as before.

The extractor emits keys under a strict regex, and **a malformed key fails the
whole candidate rather than being stored**: a wrong key silently retires a good
memory, so the prompt tells the model to omit it when unsure and the schema
enforces the shape.

### 4.2 The supersession invariant

> At most **one** row per `(profileId, packId, factKey)` may have
> `supersededBy IS NULL`. That row is the current answer.

Approving a new value for a key that already has one **retires the old row in
the same step**: `validTo` and `supersededBy` are stamped, its embedding is
cleared, and the new row's `revision` is promoted. The old row is never
deleted — `history(profileId, factKey)` reads the chain newest-first.

Three properties this is built to guarantee:

- **Enforced at the repository layer.** `recallRows` filters on
  `supersededBy IS NULL`, so no caller can ground an answer in a replaced fact
  by forgetting a check.
- **Belt and braces.** The superseded row's vector is dropped too, so it is
  unreachable even by a future retrieval path that forgets the filter.
- **Scoped per Space.** A value approved into a Space retires that Space's
  value, never the profile-wide one it does not belong to.

### 4.3 Consolidation, and who decides

Before persisting, a keyed candidate is compared against the current value:

| Case | What happens |
| --- | --- |
| Identical (normalized) | Nothing stored. The existing memory is stamped as freshly confirmed — a restatement is evidence the fact is still live, not a new fact. |
| Contradicts | Stored as a **pending candidate**. Approving it is what supersedes the old value. |
| New | Normal pending candidate. |

**The extractor never supersedes anything on its own.** A model that silently
retires the user's memories is not a feature. `memory:conflicts` pairs each
such candidate with what it would replace, and the review queue shows both: the
card is labelled *replaces a saved fact*, the current value is shown struck
through, and the button reads **Replace** rather than Approve. Discovering
afterwards that an answer quietly changed is how a memory store loses trust.

This sits alongside the older exact-restatement guard (`alreadyKnown`), which
stops a recurring meeting re-proposing something the user has *already
answered* in any status. The two answer different questions — "you already
decided this" versus "this changed" — and the keyed check runs first, because
letting the text-match guard shadow it would swallow the re-confirmation.

## 4.4 Authoring

Waiting for a conversation to mention something is the slow way to make memory
useful. **Add a memory** on the Memory page writes one directly — who you
report to, what you are building, how you like answers written — and it is
searchable immediately.

It is a faster path into the same lifecycle, never a bypass of it. The
sensitive filter still applies (and a refusal stores nothing, in any status),
the scope choice is still Space-or-everywhere, and `sourceKind` records that a
person wrote it rather than a model proposing it.

`createMemory` lands the row `pending` and the IPC layer approves it in the
same call, so the user experiences one action. The split matters: embedding is
what needs a key and a network, and it happens at approval. Creating therefore
always succeeds, and if indexing fails the memory is waiting in review rather
than lost — which is also why the Memory page refreshes after a *failed*
action, not only a successful one.

## 5. Scale

`recallRows` loads every candidate row for the profile and scores it in JS.
Measured cost per query, at real embedding width (1536), from
`recall.bench.test.ts`:

| Rows | Semantic | Lexical | Total |
| --- | --- | --- | --- |
| 1,000 | ~13 ms | ~23 ms | ~35 ms |
| 5,000 | ~22 ms | ~51 ms | ~73 ms |
| 10,000 | ~41 ms | ~100 ms | ~141 ms |

Two things this settles. Scoring is comfortably linear, so nothing accidental
is O(n²). And **lexical dominates semantic**, because the index is rebuilt on
every query — so caching the index is the first optimisation to reach for, well
before an ANN index. A daily user reaches ~1k memories in a couple of years, so
none of this is urgent; the numbers exist so the decision is made on evidence
rather than nerves.

## 6. Known gaps

Recorded honestly, because the shape of what is missing matters as much as what
is here.

- **No entities.** `category: 'person'` is a string on a sentence; there is no
  *Sarah* to hang facts on, so "what do we know about Acme?" is a similarity
  search that misses anything phrased differently.
- **No document ingest.** A user can author one memory at a time, but cannot
  point at a CV or a brief and say "learn this". `sourceKind` already
  distinguishes `imported`, so the record is ready for it.
- **No export.** Memory is local and has no backup or portability story.
- **Fact keys depend on the model choosing consistently.** Nothing yet
  reconciles `project:atlas/launch-date` with `project:atlas/launch`, so two
  spellings of one fact would coexist. Entities are the structural fix.
