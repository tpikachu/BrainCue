# Database Schema (SQLite + Drizzle)

All tables live in `userData/app.db`. IDs are text UUIDs. Timestamps are unix
epoch millis (integer). JSON columns store stringified JSON. Embeddings are
stored as `BLOB` (Float32Array bytes) for compactness; the retriever decodes
them for cosine search.

> **v2 naming (migration 0008):** the domain calls them **Context Packs**
> ("Spaces" in the UI) — the PHYSICAL table/column names remain `jobs`/`job_id`
> (a logical rename avoids table rebuilds; see `docs/12-ENGINE-PLAN.md`). In
> Drizzle the table is `schema.contextPacks` and the columns are `kind`,
> `packId`, etc. This doc lists physical names with the TS name alongside where
> they differ.

Before applying **pending** migrations, `initDb` snapshots the DB
(`app.db.pre-migrate.bak`, via `VACUUM INTO`) — the rollback path, since the
migration runner has no down-migrations. Migration 0008 is covered by a
lossless-migration test against a committed v1.5.x fixture
(`src/main/db/migration.test.ts` + `src/main/test/fixtures/pre-v2.db`).

## ER overview

```
profiles 1───* documents 1───* chunks ──* embeddings
   │                                   (1:1 chunk:embedding)
   ├──* notes
   ├──* stories                      (STAR stories; also indexed as `story` chunks, job_id null)
   ├──* applications ──1 jobs        (Tailor Resume: each application owns a dedicated, hidden pack; its tailored resume = that pack's `tailored` chunks)
   ├──* jobs (context packs) ──* chunks   (JD + company-research + tailored chunks carry job_id; resume/note/story chunks have job_id null)
   │       └──── sessions            (a session optionally references the pack it's for)
   └──* sessions 1──* transcript_chunks
                 1──* detected_questions 1──* ai_answers
                 1──* answer_feedback     (Sparring per-answer coaching)
                 1──1 session_reports

settings (singleton-ish key/value, incl. encrypted API key)
```

A **profile** is the user (name, role, resume). Each **context pack** bundles
what a session is about — every v1 pack is `kind='job'` (its own JD + company
research); other kinds (`subject`, `project`, …) arrive with their modes.

## Tables

### `profiles`
| col | type | notes |
|---|---|---|
| id | text PK | uuid |
| name | text | |
| target_role | text | |
| target_company | text | nullable |
| interview_type | text | enum: behavioral/technical/coding/system_design/general (legacy default; type is chosen per run) |
| language | text | default 'en' |
| resume_text | text | extracted raw text (nullable) |
| jd_text / parsed_jd | text / text(json) | **legacy** — single-JD fields kept for back-compat; JDs live on packs |
| parsed_resume | text(json) | structured candidate JSON |
| created_at / updated_at | int | |

`answer_style` was dead (never read or written) and was dropped in 0008.

### `jobs` — TS: `contextPacks`
A Context Pack. One profile → many packs; each parsed/indexed independently.
| col | type | notes |
|---|---|---|
| id | text PK | uuid |
| profile_id | text FK | cascade on profile delete |
| kind | text | ContextPackKind: job/subject/project/meeting/personal/game/custom — all v1 rows are 'job' (0008 default) |
| title | text | role/interview name, default '' |
| company | text | nullable |
| jd_url | text | nullable — optional link to the original posting (reference only; not parsed) |
| jd_text | text | nullable — JD text that is parsed + embedded |
| parsed_jd | text(json) | structured JD JSON |
| company_url | text | nullable — optional company website to research |
| company_research | text | nullable — readable text scraped from the company site (parsed + embedded as `company` chunks) |
| parsed_company | text(json) | nullable — structured interview-relevant research |
| notes | text | nullable — free-form client notes (shown in setup + Cue Card) |
| created_at / updated_at | int | |

### `documents`
Uploaded file metadata + parsed text.
| id | profile_id FK | kind (resume/jd/note/other) | filename | mime | source_path | text | created_at |

### `notes`
Freeform additional notes attached to a profile.
| id | profile_id FK | content | created_at |

### `applications`
A Tailor Resume application: the ATS-friendly resume tailored from a base resume × JD,
plus grounded answers to the application questions. Owns a dedicated pack (hidden
from the Interviews UI) whose `tailored` chunks ground that application's interviews.
| id | profile_id FK (cascade) | job_id FK (cascade) — TS: `packId` | name | job_title | company | base_resume | tailored_resume | answers (json[]) | created_at | updated_at |

### `stories`
Reusable STAR stories extracted from the résumé, tagged by competency + skills.
Profile-level (reused across every interview); also indexed as `story` chunks so
they can ground live answers.
| id | profile_id FK | title | situation | task | action | result | competencies (json[]) | skills (json[]) | created_at | updated_at |

### `chunks`
Chunked text from documents/notes/profile fields/stories/tailored resumes for RAG.
| id | profile_id FK | job_id FK (nullable) — TS: `packId` | source_type (resume/jd/note/company/story/tailored) | source_id | ord | content | token_count | created_at |

`job_id` is set on JD, company-research, **and** `tailored` chunks (all cascade on
pack delete); resume/note/story chunks have `job_id` null. `story` chunks are managed
by `indexStories` (one chunk per story) and are deliberately **excluded** from the
résumé/notes re-index, so re-saving a résumé doesn't wipe the curated story bank.
`tailored` chunks (an application's tailored resume, indexed by `indexJob`) REPLACE the
base `resume` chunks in retrieval whenever the selected pack has them — that's how
"Start interview" on an application grounds in the tailored resume instead of the base.

### `embeddings`
| id | chunk_id FK (unique) | model | dim | vector BLOB | created_at |

`model` + `dim` already identify the embedding space; the provider column joins
them in the provider-seam phase (mixing spaces is refused — a switch requires a
re-index).

### `sessions`
| col | type | notes |
|---|---|---|
| id | text PK | |
| profile_id | text FK | cascade |
| job_id | text FK | nullable, on delete set null — TS: `packId` |
| mode | text | **SessionMode** (0008): interview/practice/interviewer_assist/meeting/tutor/companion. Backfilled live→interview, mock/sparring→practice |
| kind | text | **deprecated** v1 discriminator: live/mock/sparring (kept for compatibility) |
| interview_type | text | behavioral/technical/coding/system_design/general |
| status | text | idle/live/stopped |
| started_at / ended_at / created_at | int | |

### `transcript_chunks`
| id | session_id FK | speaker | text | is_final (int bool) | t_start | t_end | created_at |

`speaker` rows are legacy `interviewer`/`candidate`/`unknown` on disk; the v2
vocabulary is `you`/`them`/`agent`/`unknown` and old values are mapped at read
via `normalizeSpeaker()` (`@shared/types`) — no rows are rewritten.

### `detected_questions`
| id | session_id FK | text | type | confidence (real) | strategy | transcript_chunk_id (plain text column — **no FK constraint**) | created_at |

### `ai_answers`
| id | question_id FK | direct_answer | risk_warning | followup_question | model | tokens (json) | created_at |

(The v0 expanded-meta columns — talking_points/resume_match/star/
clarifying_question — were dropped in migration 0007.)

### `answer_feedback`
Per-answer coaching from a Sparring drill (the Practice Loop): one row per
answered question, written as it happens so practice compounds into Reports
trends; the drill's report is assembled from these at end().
| id | session_id FK (cascade) | question_id FK (cascade) | answer_transcript | rating (1–5) | verdict | strengths (json[]) | improvements (json[]) | tip | competency (StoryCompetency, nullable) | created_at |

### `session_reports`
| id | session_id FK (unique) | summary | strengths (json) | improvements (json) | per_question (json) | created_at |

### `contributions` (v2, migration 0009)
Generic engine outputs — answers dual-write here; Meeting cards and reports
live here natively. `meta`/`source_refs` are json (provenance: question /
chunk / memory / transcript ids).
| id | session_id FK cascade | kind | status | title | body | meta (json) | source_refs (json) | created_at | updated_at |

### `memories` (v2, migration 0011)
Local memory, ONE lifecycle table: a row is a MemoryCandidate while
`status='pending'` and a durable MemoryItem once `'approved'`
(rejected/archived stay out of recall). The embedding lives ON the row
(`embed_provider/model/dim/vector`), so deleting a memory removes its vector
atomically and memory vectors can never leak into document retrieval. Scope:
`pack_id` null = global to the profile, set = one Space. Sensitive content is
rejected before insert (see 07). Never synced anywhere.
| id | profile_id FK cascade | pack_id FK cascade (null=global) | category | content | source_refs (json) | confidence | importance | sensitive | status | embed_provider | embed_model | embed_dim | embed_vector (blob) | created_at | updated_at | last_used_at | expires_at |

`jobs.memory_enabled` (0011) is the per-Space opt-out; the global consent
switch is the `memory_enabled` settings key (default off).

### `settings`
Key/value singleton store.
| key TEXT PK | value TEXT |

Known keys (see `SETTINGS_KEYS` in `settings.repo.ts`):
- `openai_api_key_enc` — safeStorage ciphertext (base64). **Never** returned raw.
- `openai_api_key_present` — `'1'`/`'0'` flag the renderer may read.
- `models` — json per-task model-id overrides.
- `model_preset` — active cost/quality preset (balanced/low_cost/best).
- `reasoning_efforts` — json per-task reasoning-effort overrides.
- `overlay_prefs` — json `{opacity, fontSize, mode}`.
- `overlay_bounds` — json persisted Cue Card position/size.
- `audio_prefs` — json `{source, micDeviceId}`.
- `shortcuts` — json global-shortcut accelerator overrides.
- `coding_language` — coding-solver output language.
- `privacy_mode` — `'1'`/`'0'`.
- `hide_taskbar_icon` — `'1'`/`'0'` (tray-only mode).
- `data_consent_ack` — `'1'` once user acknowledges the compliance reminder.
- `memory_enabled` — `'1'`/`'0'` global memory consent (absent = off; no
  extraction or recall until the user enables it in Library › Memory).
- `tour_done` — `'1'` once the first-run guided tour is completed/skipped.

## Deletion semantics
Deleting a profile cascades to its documents, notes, stories, applications, packs,
chunks, embeddings, sessions, memories, and everything under sessions (FK
`on delete cascade`). Deleting one memory removes its embedding with it (the
vector is a column on the row).
Deleting a pack cascades to its JD/company/tailored chunks and nulls `sessions.job_id`
(the session history is kept) — done explicitly in a transaction
(`contextPacksRepo.delete`) so it works on legacy DBs whose FKs predate the
cascade actions. Deleting an application removes its dedicated pack the same
way, then the application row. Original uploaded files in `userData/documents/`
are removed by the documents service.

## Indexes
- `chunks(profile_id)`, `jobs(profile_id)`, `stories(profile_id)`,
  `applications(profile_id)`, `applications(created_at)`,
  `embeddings(chunk_id)`, `transcript_chunks(session_id)`,
  `detected_questions(session_id)`, `ai_answers(question_id)`,
  `answer_feedback(session_id)`, `sessions(profile_id)`,
  `documents(profile_id)`, `notes(profile_id)`.
