# 14 · Persistent memory (v2)

The design of record for BrainCue's per-profile long-term memory: what it
stores, how it stays *true* over time, how it is retrieved, and how the user
stays in control of it.

Driving requirement: a profile should accumulate a durable, correctable picture
of a person's work — from call transcripts, from documents, and from what the
user types in directly — good enough that an agent grounded in it can answer
the recurring questions in a standup or a client call
([15 · Delegate](15-DELEGATE.md)) without inventing anything.

## 1. What exists today

The v1 memory subsystem is a solid foundation and is NOT being replaced:

| Piece | Status |
| --- | --- |
| `memories` table — per profile, Space-scoped, category, provenance (`sourceRefs`), confidence, importance, sensitive flag, approval `status`, inline embedding + **embedding identity** (provider/model/dim), `createdAt`/`updatedAt`/`lastUsedAt`/`expiresAt` | ✅ keep |
| `extractor.ts` — post-session LLM extraction, zod-validated, ≤ 5 candidates, confidence floor 0.6, hard sensitive-content rejection, everything lands `pending` | ✅ keep, extend |
| `recall.ts` — hybrid ranking: semantic cosine as the **gate**, lexical overlap + importance + recency as tiebreaks; consent-gated globally and per Space; fails soft (`[]` never breaks an answer) | ✅ keep, extend |
| `sensitiveFilter.ts` — secrets/payment/health/sensitive-personal never persisted | ✅ keep — invariant |
| Approval gate — only `approved` memory is ever recalled | ✅ keep — invariant |
| `sqliteVectorStore` — brute-force cosine over BLOBs behind a swappable `VectorStore` interface | ✅ keep the interface, change the backend when volume demands |

**Is the vector store "enough"?** The storage model is fine; the *search* and
the *record model* are what fall short. Two concrete limits:

1. **Retrieval is O(n) in JavaScript on the main thread.** `recallRows()` loads
   every row for the profile and scores it in a loop. At today's volume
   (dozens of memories) that is microseconds. At the volume this document
   targets — daily calls for a year — it is tens of thousands of rows per
   query, on the thread that also streams answers.
2. **Cosine similarity cannot express the things personal memory needs most:**
   which of two contradictory facts is *current*, what is true *as of* a date,
   everything known about *one person or account*, and exact recall of names,
   numbers, and dates (embeddings are lossy exactly there).

So: don't swap the database. Add the model around it.

## 2. The gaps, precisely

- **G1 · Contradiction.** Nothing dedupes a new candidate against existing
  memory. "Launch is in March" and "launch moved to May" both persist, both
  match the query, and the agent picks one at random. This is the single most
  important gap — a twin that states last month's answer confidently is worse
  than one that says nothing.
- **G2 · No entities.** `category: 'person'` is a string on a sentence. There
  is no *Sarah* to hang facts on, so "what do we know about Acme?" is a
  similarity search that misses anything phrased differently.
- **G3 · No temporal validity.** Rows have `createdAt`/`expiresAt` but no
  notion of *when the fact was true*. "Who is my manager?" cannot be answered
  as-of-a-date, and superseded facts cannot be kept for history without
  polluting recall.
- **G4 · Thin capture.** ≤ 5 candidates per session with a 0.6 floor is right
  for a copilot that must not be creepy; it is far too thin to build a
  durable picture from daily calls.
- **G5 · No exact-match index.** Lexical overlap is a JS word-set heuristic.
  SQLite ships FTS5; names, dates, figures, and identifiers should hit it.
- **G6 · No authoring surface.** IPC exposes review/update/archive/delete but
  no *create* and no *import*. The user cannot say "here is what you should
  know about me" — which is the fastest way to make memory useful on day one.
- **G7 · Transcripts are session-local.** `transcriptChunks` holds them, but
  nothing distils an archive across sessions, so "what did we agree three
  calls ago" is unanswerable.

## 3. Target model

### 3.1 Memory records get identity, validity, and lineage

Additive columns on `memories` (no destructive migration):

```
factKey        text  (nullable — a normalized slug for a single-valued fact,
                      e.g. "project:atlas/launch-date", "person:sarah/role")
validFrom      int   (defaults to createdAt)
validTo        int   (null = still true)
supersededBy   text  → memories.id   (null = current)
sourceKind     text  ('extracted' | 'authored' | 'imported' | 'derived')
revision       int   (bumped on supersession; the row is its chain's head)
```

*(`subjectId → entities.id` moves to M3 with the entities table itself — a
column referencing a table that does not exist yet buys nothing.)*

**Shipped in M1** as migration `0013`, purely additive (`ALTER TABLE ADD`), so
existing memories keep working and default to `sourceKind='extracted'`,
`revision=1`, current. Index `memories_fact_key_idx` on
`(profile_id, fact_key, superseded_by)` keeps the "is there a current row for
this fact?" lookup off a profile scan.

**The supersession rule (answers G1, G3):** at most one row per
`(profileId, packId, factKey)` may have `supersededBy IS NULL`. When a new
candidate carries a `factKey` that already has a current row, it does not
insert blindly — it enters a **conflict review**: the user sees both, and
approving the new one stamps `validTo` + `supersededBy` on the old instead of
deleting it. History is preserved; recall only ever sees current rows.
Free-text memories without a `factKey` (a story, a preference in prose) keep
today's behavior — multiple rows, no conflict.

### 3.2 Entities (answers G2)

```
entities(id, profile_id, kind, canonical_name, aliases json, summary,
         first_seen_at, last_seen_at, importance)
   kind ∈ person | org | project | product | place | topic
memory_entities(memory_id, entity_id, role)   -- many-to-many
```

Deliberately a *light* graph — a join table, not a triple store. It buys the
two queries similarity cannot do: "everything about Acme" and "who was in the
room when we decided this". Entity resolution is alias-matching plus an LLM
merge proposal that the user approves; never automatic silent merges.

### 3.3 Retrieval: four signals, one gate

Recall keeps today's contract (semantic score is the gate; nothing below the
floor surfaces) and gains three retrieval paths that are **unioned before
ranking**:

```
candidates = vector_top_n(query)              -- semantic, k≈40
           ∪ fts_top_n(query)                 -- FTS5 exact/keyword, k≈40
           ∪ entity_facts(entities_in_query)  -- structured, all current rows
filter     current only (supersededBy IS NULL, validTo null-or-future),
           approved only, scope-allowed, embedding-identity-matched
rank       semantic (gate) + lexical + importance + recency + entity-hit bonus
budget     top-k with a per-memory char cap, unchanged
```

FTS5 closes G5 and costs one virtual table plus triggers. The entity path
makes account/person questions reliable.

### 3.4 Consolidation (answers G4, G7)

Post-session extraction becomes a two-stage pipeline:

1. **Extract** — as today (zod-validated, sensitive-filtered, conservative
   *per fact*), but the ≤ 5 cap is lifted for long transcripts in favour of a
   per-1000-word budget, and each candidate may carry `factKey` + entity
   mentions.
2. **Consolidate** — before persisting, each candidate is matched against
   current memory: **identical** → drop, bump `lastUsedAt`; **refines** →
   propose a merged wording; **contradicts** → conflict review (§3.1);
   **new** → normal pending candidate.

A **session archive** is written per call regardless: the transcript stays in
`transcriptChunks` (already true), plus a durable per-session summary row so
"three calls ago" is retrievable without re-reading raw turns.

### 3.5 The user is the editor (answers G6)

New IPC (following the 4-step contract): `memory:create`, `memory:import`,
`memory:merge`, `memory:split`, `memory:resolveConflict`, `entity:*`.
The Library › Memory surface grows into a manager: create a memory by hand,
paste or drop a document as "things to know about me" (chunk → propose →
approve in bulk), browse by entity, see conflicts, and view a fact's history
chain. Nothing bypasses the approval gate — imported items land `pending` too.

## 4. Invariants (unchanged, and they bind the new code too)

1. **Only approved memory is ever recalled.** New paths (entity, FTS, import)
   filter on `status='approved'` at the repository layer, not the caller.
2. **The sensitive filter runs before persistence** on every path, including
   manual authoring and import.
3. **Consent is global + per Space**, checked before any capture or recall.
4. **Recall never breaks an answer** — every new path is inside the existing
   try/catch that returns `[]`.
5. **Embedding identity is respected** — rows from another provider/model wait
   for a re-embed rather than mis-ranking.
6. **Deletion is real.** Deleting a memory removes the row, its embedding, its
   FTS entry, and its entity links; deleting the *head* of a supersession
   chain promotes the previous revision rather than orphaning it.

## 5. Scale plan

Stay on brute-force cosine until measured pain, then swap the `VectorStore`
backend — the interface already anticipates this. Trigger points:

| Signal | Action |
| --- | --- |
| p95 recall > 80 ms | Move scoring off the main thread (worker), pre-filter by SQL |
| > ~20k embedded rows per profile | Adopt `sqlite-vec` (ANN) behind the same interface |
| Cross-device sync requested | Separate design — out of scope here |

Benchmarks land as a test (`recall.bench.test.ts`) with synthetic corpora at
1k / 10k / 50k rows, so the trigger points are observed rather than guessed.

## 6. Delivery

| Stage | Content |
| --- | --- |
| **M1 · Truthfulness** ✅ | Additive migration (§3.1), supersession + conflict review, consolidation stage 2, `memory:create` / `memory:conflicts` / `memory:history`. The twin cannot be built before this — it is the "don't state a stale fact" guarantee. |
| **M2 · Recall quality** | FTS5 index + hybrid union, recency/entity signals, benchmark test |
| **M3 · Entities** | `entities` + `memory_entities`, alias resolution with approval, entity-browse UI |
| **M4 · Authoring** | Import (paste/drop a doc), bulk approve, merge/split, history view |
| **M5 · Scale** | Worker-side scoring, `sqlite-vec` behind the interface if the benchmark says so |

M1 is the dependency for [15 · Delegate](15-DELEGATE.md); M2–M4 improve it but
do not block it.
