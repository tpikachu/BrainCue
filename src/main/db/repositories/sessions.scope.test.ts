import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sessions and Insights are views of the ACTIVE profile
 * (docs/19-ACTIVE-PROFILE.md). `list` and `practiceStats` used to read the
 * whole database, which was invisible while there was one profile and wrong the
 * moment there were two: you saw someone else's conversations, and the practice
 * averages on Insights described neither person.
 *
 * Also: filing a finished session into a Space, which is what makes "remember
 * it in ___" mean anything — the archive and its memory candidates are both
 * scoped off `sessions.job_id`.
 */

const h = vi.hoisted(() => ({ db: null as unknown as import('../../test/dbHarness').TestDb }));

vi.mock('../index', async () => {
  const schema = await vi.importActual<typeof import('../schema')>('../schema');
  return {
    schema,
    db: () => {
      if (!h.db) throw new Error('test db not initialized');
      return h.db;
    },
    initDb: () => h.db,
    rawDb: () => {
      throw new Error('rawDb not available in tests');
    },
  };
});

import * as schema from '../schema';
import { createTestDb } from '../../test/dbHarness';
import { sessionsRepo } from './sessions.repo';

let seq = 0;

function seedProfile(name: string): string {
  const id = `sp-p${++seq}`;
  h.db.insert(schema.profiles).values({ id, name }).run();
  return id;
}
function seedPack(profileId: string): string {
  const id = `sp-j${++seq}`;
  h.db.insert(schema.contextPacks).values({ id, profileId, title: `Pack ${id}` }).run();
  return id;
}
function seedSession(profileId: string, over: Partial<typeof schema.sessions.$inferInsert> = {}) {
  const id = `sp-s${++seq}`;
  h.db
    .insert(schema.sessions)
    .values({ id, profileId, mode: 'meeting', kind: 'live', status: 'stopped', ...over })
    .run();
  return id;
}
/** One sparring answer with a rating — the only input to practiceStats. */
function seedSparringScore(profileId: string, rating: number): void {
  const sessionId = seedSession(profileId, { kind: 'sparring', mode: 'practice' });
  const questionId = `sp-q${++seq}`;
  h.db
    .insert(schema.detectedQuestions)
    .values({ id: questionId, sessionId, text: 'Tell me about a time…', type: 'behavioral' })
    .run();
  h.db
    .insert(schema.answerFeedback)
    .values({
      id: `sp-f${++seq}`,
      sessionId,
      questionId,
      answerTranscript: 'an answer',
      rating,
      competency: 'communication',
    })
    .run();
}

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
beforeEach(() => {
  h.db.delete(schema.profiles).run(); // cascades to sessions/questions/feedback
});

describe('sessions are one profile’s, not the database’s', () => {
  it('lists only the given profile’s sessions', () => {
    const mine = seedProfile('Mine');
    const theirs = seedProfile('Theirs');
    seedSession(mine);
    seedSession(mine);
    seedSession(theirs);

    const rows = sessionsRepo.list(mine);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.profileId === mine)).toBe(true);
  });

  it('returns everything only when asked for everything', () => {
    // The data-stats caller genuinely means the whole database.
    seedSession(seedProfile('A'));
    seedSession(seedProfile('B'));
    expect(sessionsRepo.list()).toHaveLength(2);
  });

  it('never averages two people’s practice together', () => {
    const mine = seedProfile('Mine');
    const theirs = seedProfile('Theirs');
    seedSparringScore(mine, 5);
    seedSparringScore(theirs, 1);

    const stats = sessionsRepo.practiceStats(mine);
    expect(stats.answers).toBe(1);
    expect(stats.avgRating).toBe(5); // not 3, the average of both people
    expect(stats.byCompetency.find((c) => c.competency === 'communication')?.avgRating).toBe(5);
    expect(stats.recent.map((r) => r.avgRating)).toEqual([5]);
  });
});

describe('filing a finished session into a Space', () => {
  it('moves it, so its archive and memories scope to that Space', () => {
    const pid = seedProfile('Mine');
    const pack = seedPack(pid);
    const sid = seedSession(pid, { packId: null }); // started with no Space

    sessionsRepo.setPack(sid, pack);

    expect(sessionsRepo.list(pid).find((s) => s.id === sid)?.jobId).toBe(pack);
  });

  it('can file a session OUT of every Space', () => {
    const pid = seedProfile('Mine');
    const sid = seedSession(pid, { packId: seedPack(pid) });

    sessionsRepo.setPack(sid, null);

    expect(sessionsRepo.list(pid).find((s) => s.id === sid)?.jobId).toBeNull();
  });
});
