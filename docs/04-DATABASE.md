# Database Schema (SQLite + Drizzle)

All tables live in `userData/app.db`. IDs are text UUIDs. Timestamps are unix
epoch millis (integer). JSON columns store stringified JSON. Embeddings are
stored as `BLOB` (Float32Array bytes) for compactness; the retriever decodes
them for cosine search.

## ER overview

```
profiles 1───* documents 1───* chunks ──* embeddings
   │                                   (1:1 chunk:embedding)
   ├──* notes
   ├──* stories                      (STAR stories; also indexed as `story` chunks, job_id null)
   ├──* applications ──1 jobs        (Tailor Resume: each application owns a dedicated, hidden job; its tailored resume = that job's `tailored` chunks)
   ├──* jobs ────* chunks            (JD + company-research + tailored chunks carry job_id; resume/note/story chunks have job_id null)
   │       └──── sessions            (a session optionally references the job it's for)
   └──* sessions 1──* transcript_chunks
                 1──* detected_questions 1──* ai_answers
                 1──1 session_reports

settings (singleton-ish key/value, incl. encrypted API key)
```

A **profile** is just the candidate (name, role, resume). Each **job** the
candidate targets is a separate row holding its own job description; one profile
can have many jobs, and each job is parsed/indexed independently.

## Tables

### `profiles`
| col | type | notes |
|---|---|---|
| id | text PK | uuid |
| name | text | |
| target_role | text | |
| target_company | text | nullable |
| interview_type | text | enum: behavioral/technical/coding/system_design/product/sales/general |
| answer_style | text | enum: concise/detailed/star/technical/conversational |
| language | text | default 'en' |
| resume_text | text | extracted raw text (nullable) |
| jd_text | text | extracted raw text (nullable) |
| parsed_resume | text(json) | structured candidate JSON |
| jd_text / parsed_jd | text / text(json) | **legacy** — single-JD fields kept for back-compat; new JDs live on `jobs` |
| created_at / updated_at | int | |

### `jobs`
A job the candidate is targeting. One profile → many jobs; each holds its own
job description and is parsed/indexed independently.
| col | type | notes |
|---|---|---|
| id | text PK | uuid |
| profile_id | text FK | cascade on profile delete |
| title | text | role/interview name, default '' |
| company | text | nullable |
| jd_url | text | nullable — optional link to the original posting (reference only; not parsed) |
| jd_text | text | nullable — JD text that is parsed + embedded |
| parsed_jd | text(json) | structured JD JSON |
| company_url | text | nullable — optional company website to research |
| company_research | text | nullable — readable text scraped from the company site (parsed + embedded as `company` chunks) |
| parsed_company | text(json) | nullable — structured interview-relevant research (overview, products, values, culture, …) |
| created_at / updated_at | int | |

### `documents`
Uploaded file metadata + parsed text.
| id | profile_id FK | kind (resume/jd/note/other) | filename | mime | source_path | text | created_at |

### `notes`
Freeform additional notes attached to a profile.
| id | profile_id FK | content | created_at |

### `applications`
A Tailor Resume application: the ATS-friendly resume tailored from a base resume × JD,
plus grounded answers to the application questions. Owns a dedicated jobs row (hidden
from the Interviews UI) whose `tailored` chunks ground that application's interviews.
| id | profile_id FK (cascade) | job_id FK (cascade) | name | job_title | company | base_resume | tailored_resume | answers (json[]) | created_at | updated_at |

### `stories`
Reusable STAR stories extracted from the résumé, tagged by competency + skills.
Profile-level (reused across every interview); also indexed as `story` chunks so
they can ground live answers.
| id | profile_id FK | title | situation | task | action | result | competencies (json[]) | skills (json[]) | created_at | updated_at |

### `chunks`
Chunked text from documents/notes/profile fields/stories/tailored resumes for RAG.
| id | profile_id FK | job_id FK (nullable) | source_type (resume/jd/note/company/story/tailored) | source_id | ord | content | token_count | created_at |

`job_id` is set on JD, company-research, **and** `tailored` chunks (all cascade on job
delete); resume/note/story chunks have `job_id` null. `story` chunks are managed
by `indexStories` (one chunk per story) and are deliberately **excluded** from the
résumé/notes re-index, so re-saving a résumé doesn't wipe the curated story bank.
`tailored` chunks (an application's tailored resume, indexed by `indexJob`) REPLACE the
base `resume` chunks in retrieval whenever the selected job has them — that's how
"Start interview" on an application grounds in the tailored resume instead of the base.

### `embeddings`
| id | chunk_id FK (unique) | model | dim | vector BLOB | created_at |

### `sessions`
| id | profile_id FK | job_id FK (nullable, on delete set null) | interview_type | status (idle/live/stopped) | started_at | ended_at | created_at |

### `transcript_chunks`
| id | session_id FK | speaker (interviewer/candidate/unknown) | text | is_final (int bool) | t_start | t_end | created_at |

### `detected_questions`
| id | session_id FK | text | type | confidence (real) | strategy | transcript_chunk_id FK | created_at |

### `ai_answers`
| id | question_id FK | direct_answer | talking_points (json[]) | resume_match (json) | star (json, nullable) | clarifying_question | risk_warning | followup_question | model | tokens (json) | created_at |

### `session_reports`
| id | session_id FK (unique) | summary | strengths (json) | improvements (json) | per_question (json) | created_at |

### `settings`
Key/value singleton store.
| key TEXT PK | value TEXT |

Known keys:
- `openai_api_key_enc` — safeStorage ciphertext (base64). **Never** returned raw.
- `openai_api_key_present` — `'1'`/`'0'` flag the renderer may read.
- `models` — json overrides for model ids.
- `overlay_prefs` — json `{opacity, fontSize, mode}`.
- `privacy_mode` — `'1'`/`'0'`.
- `data_consent_ack` — `'1'` once user acknowledges the compliance reminder.
- `tour_done` — `'1'` once the first-run guided tour is completed/skipped.

## Deletion semantics
Deleting a profile cascades to its documents, notes, stories, applications, jobs,
chunks, embeddings, sessions, and everything under sessions (FK `on delete cascade`).
Deleting a job cascades to its JD/company/tailored chunks and nulls `sessions.job_id`
(the session history is kept). Deleting an application removes its dedicated job the
same way, then the application row. Original uploaded files in `userData/documents/`
are removed by the documents service.

## Indexes
- `chunks(profile_id)`, `jobs(profile_id)`, `stories(profile_id)`,
  `applications(profile_id)`, `applications(created_at)`,
  `embeddings(chunk_id)`, `transcript_chunks(session_id)`,
  `detected_questions(session_id)`, `ai_answers(question_id)`,
  `sessions(profile_id)`, `documents(profile_id)`, `notes(profile_id)`.
