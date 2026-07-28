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
room when we decided this".

**Resolution is exact** on a normalized match key (case- and
punctuation-insensitive) or a registered alias. An unrecognised spelling
becomes its *own* entity rather than being guessed into an existing one:
over-splitting is visible and recoverable in one click, whereas silently
folding two different people called Sarah into one corrupts memory in a way
that is nearly impossible to notice and worse to unpick. Merging is therefore
a user action, and it is non-destructive — the losing entity is tombstoned
with a pointer to the winner, so stale references still resolve and the
loser's spelling starts finding the survivor.

Entity counts and the retrieval path both filter to **current** memories, so a
superseded fact never inflates what the app claims to know about an account.

### 3.3 Retrieval: four signals, one gate

Recall keeps today's contract (semantic score is the gate; nothing below the
floor surfaces) and gains three retrieval paths that are **unioned before
ranking**:

```
surface    semantic ≥ MEMORY_MIN_SCORE          -- topical match, as before
        OR (lexical ≥ MEMORY_MIN_LEXICAL        -- names it specifically
            AND the query names something the memory actually contains)
        ∪ entity_facts(entities_in_query)       -- structured (M3)
filter     current only (supersededBy IS NULL, validTo null-or-future),
           approved only, scope-allowed, embedding-identity-matched
rank       semantic + 0.45·lexical + importance + recency (+ entity bonus, M3)
budget     top-k with a per-memory char cap, unchanged
```

**The surfacing contract changed in M2.** Previously semantic score was the
sole gate, which meant a memory could never be recalled by *naming the thing
it is about*: embeddings blur identifiers, so "ticket ATL-4471" sits nowhere
near the memory recording ATL-4471 and the cosine floor discarded it. Now
either signal can surface a memory, and both contribute to ranking.

The lexical half is IDF-weighted so rare tokens dominate: a shared ticket id
or proper noun outweighs three shared common words. Anchoring uses **document
frequency** rather than raw IDF, because IDF's magnitude moves with corpus
size — the same token scores 0.69 among 2 memories and 2.0 among 40, so an
absolute threshold silently stops working in small stores. The entity path
(M3) makes account/person questions reliable.

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
`memory:ingest`, `memory:review-many`, `memory:merge`, `memory:split`,
`memory:conflicts`, `memory:history`, `memory:entit*`.
The Library › Memory surface grows into a manager: create a memory by hand,
paste or drop a document as "things to know about me" (chunk → propose →
approve in bulk), browse by entity, see conflicts, and view a fact's history
chain. Nothing bypasses the approval gate — imported items land `pending` too.

**Ingest is deliberately less timid than session extraction.** A transcript is
something the app overheard, so the ≤ 5 cap and the 0.6 floor are the price of
not being creepy. A document is something the user *handed over*: the intent is
explicit, so ingest reads the whole thing at up to 8 facts per ~2.4k-character
window. Everything else is unchanged — the sensitive filter still rejects
before persistence, consolidation still drops what is already known, and every
candidate still lands `pending`. `chunkText` keeps an over-long paragraph
whole, which is correct for a résumé and wrong for extracted PDF text with no
blank lines in it, so ingest re-splits anything over the window on a sentence
boundary. A document longer than 40 windows is read from the start and the
result **says so** rather than passing a partial read off as complete.

**Merge and split are the two edits a text field cannot express.** Merge folds
several memories into one sentence the user writes; split breaks a candidate
that bundled three facts into three. Both **archive** their sources instead of
deleting them, so the judgement stays reversible and readable. Both produce
approved rows only when every input was already approved — the approval gate
exists so nothing the *model* wrote is remembered unreviewed, and a human who
approved every input and typed the output has reviewed it. Split does **not**
copy `factKey` onto the parts: a single-valued fact broken into several
statements is no longer single-valued, and several current rows under one key
is precisely what §3.1 exists to prevent.

**Consolidation is shared by every producer** (`consolidate.ts`). Session
extraction, document ingest, and anything added later go through one function,
so invariants 1 and 2 are structural rather than a rule each new caller has to
remember. Deduplication now matches on normalized *content* within the scope a
candidate would land in, not only on `factKey` — previously a plain sentence
could be re-proposed after every session forever, and re-proposing something
the user rejected quietly ignores their answer.

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

## 5. Portability — the memory is the user's to take

Memory becomes the most valuable thing in the app and, until now, the least
portable: it lived in one SQLite file with no way out. `memory:export` writes a
profile's memory to a JSON file the user names and places; `memory:import`
merges one back.

**Plain JSON, deliberately not an encrypted blob.** This file is the most
sensitive artefact BrainCue produces, which is exactly why it must be
*inspectable* — the user can open it, read every line, edit it, diff two
exports, and feed it to something else. An opaque container would hide the one
thing they most need to verify. The UI states plainly what the file contains;
where it is then stored (a drive, a backup, a sync folder) is the user's
decision. **Nothing is uploaded by the app**, in keeping with the local-first
contract. Optional passphrase encryption is a reasonable future addition, not
a substitute for legibility.

What an export contains and what it never contains:

| In | Out |
| --- | --- |
| Memories that are currently true — approved, pending, and archived | Superseded revisions (historical; their ids mean nothing elsewhere) |
| Category, importance, confidence, fact key, validity, timestamps | Rejected candidates — the user already said no |
| Space **titles** (not ids), so scope survives the trip | The API key, settings, documents, transcripts |
| Embedding vectors + the identity that produced them | Anything the sensitive filter would have blocked (never stored) |

**Import is a merge, never a replace.** Nothing existing is deleted. Rules:

- Every incoming item passes the **sensitive filter** — a hand-edited file is
  untrusted input regardless of what it claims to be.
- **Duplicates** (same normalized content, same scope) are skipped, so
  importing the same file twice is a no-op.
- **Fact keys still supersede** (§3.1): restoring a newer value retires the
  one already here, with history intact.
- An **unknown Space** name imports as profile-global rather than creating a
  dangling reference — slightly-too-visible is recoverable, a broken foreign
  key is not.
- **Vectors are reused only when the embedding identity matches**; otherwise
  approved rows are re-embedded on import and the count is reported.
- Two modes: `review` (default — everything lands `pending`, for a file from
  anywhere) and `restore` (preserves the exported statuses, for the user's own
  backup, where forcing re-approval of hundreds of items would just teach them
  to rubber-stamp).

## 6. Scale plan

Stay on brute-force scoring until measured pain, then swap the `VectorStore`
backend — the interface already anticipates this.

**Measured** (`recall.bench.test.ts`, 1536-dim vectors, dev laptop):

| Rows | Semantic | Lexical | Total |
| --- | --- | --- | --- |
| 1,000 | 9.5 ms | 14.8 ms | **24 ms** |
| 5,000 | 17.2 ms | 47.6 ms | **65 ms** |
| 10,000 | 41.5 ms | 95.0 ms | **137 ms** |

Two results worth acting on, both of which contradict the original guesses:

1. **The 80 ms budget is crossed near 5–6k memories, not 20k.** For a profile
   accumulating facts from daily calls that is a matter of months, so M5 is
   nearer than "someday".
2. **Lexical costs more than semantic at scale** (95 ms vs 41 ms at 10k),
   because `buildIndex` re-tokenizes every candidate on every query. So the
   first optimisation is not an ANN index at all — it is caching the lexical
   index per profile (invalidated on write) or persisting tokens. That is
   cheaper to build and buys more than `sqlite-vec` would.

Revised trigger points:

| Signal | Action |
| --- | --- |
| > ~4k embedded rows per profile | Cache/persist the lexical index (kills the dominant cost) |
| p95 recall > 80 ms after that | Move scoring to a worker thread — it is already off the DB |
| > ~20k embedded rows per profile | Adopt `sqlite-vec` (ANN) behind the same `VectorStore` interface |
| Cross-device sync requested | Separate design — out of scope here |

**Why not SQLite FTS5** for the lexical half: the test harness (sql.js 1.14)
ships FTS3/FTS4 but **not** FTS5. An FTS5 virtual table would fail every
migration under test and leave the path that decides what an agent says aloud
unverifiable; FTS4 has no BM25 ranking, which is the only reason to want FTS.
Scoring in JS (`lexical.ts`) is testable on every engine and gives direct
control over rare-token weighting. The swap point, if it is ever justified,
is that module's interface rather than its callers.

## 7. Delivery

| Stage | Content |
| --- | --- |
| **M1 · Truthfulness** ✅ | Additive migration (§3.1), supersession + conflict review, consolidation stage 2, `memory:create` / `memory:conflicts` / `memory:history`. The twin cannot be built before this — it is the "don't state a stale fact" guarantee. |
| **M2 · Recall quality** ✅ | IDF-weighted lexical scoring (`lexical.ts`), the semantic ∪ lexical surfacing contract (§3.3), and the scale benchmark. FTS5 was evaluated and rejected — see §6. |
| **M3 · Entities** ✅ | `entities` + `memory_entities` (migration 0014), exact name/alias resolution, the entity retrieval path in recall, non-destructive user-driven merge, and the `memory:entit*` IPC. Entity-browse UI remains. |
| **M4 · Authoring** ✅ | Document ingest (`ingest.ts`), shared consolidation (`consolidate.ts`), bulk review, merge/split, and the Library › Memory manager — conflicts, history, entity browse, and export/import all reachable at last. |
| **M6 · Portability** ✅ | Export/import a profile's memory as inspectable JSON (§5). Shipped alongside M1 — a store the user cannot get their data out of is not one they should trust with more of it. |
| **M5 · Scale** | Worker-side scoring, `sqlite-vec` behind the interface if the benchmark says so |

M1 is the dependency for [15 · Delegate](15-DELEGATE.md); M2–M4 improve it but
do not block it.
