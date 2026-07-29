# 14 · Long-term memory

How BrainCue's per-profile long-term memory stores what it learns, how it
retrieves it, and how the user stays in control of it.

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
| `memories` table — per profile, Space-scoped or profile-wide, category, provenance (`sourceRefs`), confidence, importance, sensitive flag, approval `status`, inline embedding + **embedding identity** (provider/model/dim), `createdAt`/`updatedAt`/`lastUsedAt`/`expiresAt` | `db/schema.ts` |
| Post-session extraction — LLM, zod-validated, ≤ 5 candidates, confidence floor 0.6, hard sensitive-content rejection; everything lands `pending` | `memory/extractor.ts` |
| Recall — hybrid semantic ∪ lexical, consent-gated globally and per Space, fails soft (`[]` never breaks an answer) | `memory/recall.ts`, `memory/lexical.ts` |
| Secrets / payment / health / sensitive-personal never persisted | `memory/sensitiveFilter.ts` |
| Review, approval, editing, scope changes | `MemoryPage.tsx` → `memory.ipc.ts` |

Three invariants hold everywhere and are each pinned by a test:

1. **Only `approved` memory is ever recalled.** Extraction proposes; the user
   decides. Nothing reaches an answer without a click.
2. **Sensitive content is never written**, not even via a user edit — a paste
   into the review queue is re-checked, so the queue cannot be used to smuggle
   a secret past the filter.
3. **Recall never throws.** Every failure path returns `[]`. Memory improves an
   answer or is absent from it; it does not break one.

## 2. Scope

Two independent questions, deliberately kept apart:

- **Where a conversation is kept** — its Space. No Space, nothing kept.
- **How far what it taught reaches** — a candidate marked `profile` is stored
  profile-wide and recalled in every Space; one marked to a Space is recalled
  only inside it.

An interview Space learning "they drill into API design" should not colour a
standup. "Prefers concise bullet answers" should colour everything.

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

Two filters run before any of this: **approval + scope + expiry** in
`recallRows`, and **embedding identity** in `recall.ts` — vectors from a
different provider/model/dimension are skipped until re-embedded rather than
mis-ranked against the current space.

**Why not SQLite FTS5.** Evaluated and rejected. The test harness (sql.js)
ships FTS3/FTS4 but not FTS5, so an FTS5 virtual table would fail every
migration under test and leave this path — which decides what the app says out
loud — unverifiable. FTS4 has no BM25 ranking, which is the only reason to want
FTS in the first place.

## 4. Consent

Long-term memory is **off until the user turns it on**. `memoryEnabled` gates
it globally; each Space can opt out individually. Both switches sit together on
the Memory page, because "summaries of conversations" and "long-term memory
about you" read as the same thing to a user and must be chosen side by side.

With consent off, the extractor is never called — the model does not see the
transcript at all. This is a real short-circuit, not a filter on the result.

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

- **Contradiction.** Nothing dedupes a *changed* fact. "Launch is in March" and
  "launch moved to May" both persist, both match, and ranking picks one.
  Exact-sentence dedupe exists (`alreadyKnown`) and stops a recurring meeting
  re-proposing what you already answered — but it matches normalised text, so a
  new value for an old fact reads as a new memory. This is the most significant
  gap; the fix is a normalised fact key plus supersession, keeping the old row
  as history and letting recall see only the current one.
- **No entities.** `category: 'person'` is a string on a sentence; there is no
  *Sarah* to hang facts on, so "what do we know about Acme?" is a similarity
  search that misses anything phrased differently.
- **No authoring.** IPC exposes review / update / archive / delete but no
  *create* and no *import*. The user cannot say "here is what you should know
  about me", which is the fastest way to make memory useful on day one.
- **No export.** Memory is local and has no backup or portability story.
