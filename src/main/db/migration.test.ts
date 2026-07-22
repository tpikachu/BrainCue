import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { createTestDb, type TestDb } from '../test/dbHarness';

/**
 * Lossless-migration proof for the v2 vocabulary migration (0008).
 *
 * fixtures/pre-v2.db is a REAL v1.5.x database image: generated with
 * migrations 0000–0007 applied and every table populated (its
 * __drizzle_migrations bookkeeping records those, so createTestDb applies
 * exactly the pending v2 migrations). If a future migration loses rows,
 * breaks an FK, or backfills wrongly, this fails before any user hits it.
 */

let db: TestDb;
let sqlite: Awaited<ReturnType<typeof createTestDb>>['sqlite'];

beforeAll(async () => {
  const bytes = readFileSync(path.join(process.cwd(), 'src', 'main', 'test', 'fixtures', 'pre-v2.db'));
  ({ db, sqlite } = await createTestDb(new Uint8Array(bytes)));
});

describe('migration 0008 on a v1.5.x database', () => {
  it('preserves every row and every id', () => {
    expect(db.select().from(schema.profiles).all()).toHaveLength(1);
    expect(db.select().from(schema.contextPacks).all()).toHaveLength(3);
    expect(db.select().from(schema.stories).all()).toHaveLength(2);
    expect(db.select().from(schema.applications).all()).toHaveLength(1);
    expect(db.select().from(schema.chunks).all()).toHaveLength(4);
    expect(db.select().from(schema.embeddings).all()).toHaveLength(4);
    expect(db.select().from(schema.sessions).all()).toHaveLength(3);
    expect(db.select().from(schema.transcriptChunks).all()).toHaveLength(2);
    expect(db.select().from(schema.detectedQuestions).all()).toHaveLength(2);
    expect(db.select().from(schema.aiAnswers).all()).toHaveLength(1);
    expect(db.select().from(schema.answerFeedback).all()).toHaveLength(1);
    expect(db.select().from(schema.sessionReports).all()).toHaveLength(1);
    expect(db.select().from(schema.notes).all()).toHaveLength(1);
    expect(db.select().from(schema.documents).all()).toHaveLength(1);

    const profile = db.select().from(schema.profiles).all()[0];
    expect(profile.id).toBe('p1');
    expect(profile.name).toBe('Ada Example');
    expect(JSON.parse(profile.parsedResume!)).toEqual({ skills: ['ts', 'sql'] });
  });

  it('turns every job into a context pack of kind "job" with content intact', () => {
    const packs = db.select().from(schema.contextPacks).all();
    expect(packs.map((p) => p.kind)).toEqual(['job', 'job', 'job']);
    const j1 = packs.find((p) => p.id === 'j1')!;
    expect(j1.title).toBe('Staff Engineer');
    expect(JSON.parse(j1.parsedCompany!).overview).toBe('Acme builds anvils');
    expect(j1.notes).toBe('client notes');
  });

  it('backfills sessions.mode from kind and keeps kind', () => {
    const rows = db.select().from(schema.sessions).all();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.se1).toMatchObject({ kind: 'live', mode: 'interview', packId: 'j1' });
    expect(byId.se2).toMatchObject({ kind: 'mock', mode: 'practice' });
    expect(byId.se3).toMatchObject({ kind: 'sparring', mode: 'practice' });
  });

  it('drops the dead profiles.answer_style column and nothing else', () => {
    const cols = sqlite
      .exec('PRAGMA table_info(profiles)')[0]
      .values.map((v) => String(v[1]));
    expect(cols).not.toContain('answer_style');
    for (const kept of ['id', 'name', 'target_role', 'interview_type', 'language', 'resume_text', 'parsed_resume']) {
      expect(cols).toContain(kept);
    }
  });

  it('keeps every relationship valid (FK check + pack links + cascades intact)', () => {
    expect(sqlite.exec('PRAGMA foreign_key_check')).toEqual([]); // no violations

    const c2 = db.select().from(schema.chunks).where(eq(schema.chunks.id, 'c2')).all()[0];
    expect(c2.packId).toBe('j1');
    // 0010: every pre-existing embedding is stamped with the reference provider.
    for (const e of db.select().from(schema.embeddings).all()) {
      expect(e.provider).toBe('openai');
    }
    const app = db.select().from(schema.applications).all()[0];
    expect(app.packId).toBe('j3');
    const an1 = db.select().from(schema.aiAnswers).all()[0];
    expect(an1.questionId).toBe('q1');
    expect(JSON.parse(an1.tokens!)).toEqual({ prompt: 100, completion: 50 });

    // Legacy speaker strings are untouched on disk (mapped at read from P3 on).
    const speakers = db.select().from(schema.transcriptChunks).all().map((t) => t.speaker);
    expect(speakers.sort()).toEqual(['candidate', 'interviewer']);
  });

  it('is idempotent for new databases (fresh create includes 0008 defaults)', async () => {
    const fresh = await createTestDb();
    fresh.db.insert(schema.profiles).values({ id: 'p9', name: 'New User' }).run();
    fresh.db.insert(schema.contextPacks).values({ id: 'k1', profileId: 'p9', title: 'Algebra' , kind: 'subject' }).run();
    fresh.db
      .insert(schema.sessions)
      .values({ id: 's9', profileId: 'p9', mode: 'interview', kind: 'live' })
      .run();
    expect(fresh.db.select().from(schema.contextPacks).all()[0].kind).toBe('subject');
    expect(fresh.db.select().from(schema.sessions).all()[0].mode).toBe('interview');
  });

  it('0011 adds the memories table (empty) and defaults packs to memory-enabled', () => {
    // The migrated v1.5 database has the table — with NOTHING in it: memory
    // never backfills itself from old data (no capture before consent).
    expect(db.select().from(schema.memories).all()).toHaveLength(0);
    const packs = db.select().from(schema.contextPacks).all();
    expect(packs.every((p) => p.memoryEnabled === 1)).toBe(true);
  });

  it('deleting a profile cascades through its memories (wipe path)', () => {
    db.insert(schema.memories)
      .values({
        id: 'wipe-m1',
        profileId: 'p1',
        category: 'fact',
        content: 'Cascade check',
        status: 'approved',
      })
      .run();
    db.delete(schema.profiles).where(eq(schema.profiles.id, 'p1')).run();
    expect(db.select().from(schema.memories).all().filter((m) => m.id === 'wipe-m1')).toHaveLength(0);
  });
});
