import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * M6: session history is served one bounded page at a time (it only grows),
 * scoped to one profile, searchable, with an exact total — and the detail a
 * saved session opens with carries its other cards, oldest first, and the
 * Space it is filed in. Real schema (sql.js + migrations).
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
  };
});

import * as schema from '../schema';
import { createTestDb } from '../../test/dbHarness';
import { sessionsRepo } from './sessions.repo';

beforeAll(async () => {
  h.db = (await createTestDb()).db;
  h.db.insert(schema.profiles).values([{ id: 'pA', name: 'A' }, { id: 'pB', name: 'B' }]).run();
  h.db
    .insert(schema.contextPacks)
    .values([
      { id: 'acme', profileId: 'pA', title: 'Backend Engineer', company: 'Acme', kind: 'job' },
      { id: 'standup', profileId: 'pA', title: 'Daily standup', kind: 'meeting' },
    ])
    .run();
  // 30 sessions for A (newest = highest n), 3 for B.
  for (let n = 1; n <= 30; n++) {
    h.db
      .insert(schema.sessions)
      .values({
        id: `a${n}`,
        profileId: 'pA',
        packId: n % 2 ? 'acme' : 'standup',
        activity: n % 2 ? 'job' : 'meeting',
        mode: n % 2 ? 'interview' : 'meeting',
        kind: 'live',
        status: 'stopped',
        createdAt: 1_000 + n,
        startedAt: 1_000 + n,
      })
      .run();
  }
  for (let n = 1; n <= 3; n++) {
    h.db.insert(schema.sessions).values({ id: `b${n}`, profileId: 'pB', mode: 'interview', kind: 'live', status: 'stopped', createdAt: 5_000 + n }).run();
  }
  h.db
    .insert(schema.detectedQuestions)
    .values([
      { id: 'q1', sessionId: 'a29', text: 'Why Acme?', type: 'behavioral', confidence: 1 },
      { id: 'q2', sessionId: 'a29', text: 'Tell me about Kafka.', type: 'technical_concept', confidence: 1 },
      { id: 'q3', sessionId: 'a1', text: 'Old one', type: 'behavioral', confidence: 1 },
    ])
    .run();
});

describe('sessionsRepo.page', () => {
  it('one bounded page, newest first, with the exact total — only this profile', () => {
    const p0 = sessionsRepo.page({ profileId: 'pA', limit: 12, offset: 0 });
    expect(p0.total).toBe(30);
    expect(p0.items.map((s) => s.id)).toEqual(Array.from({ length: 12 }, (_, i) => `a${30 - i}`));
    const p2 = sessionsRepo.page({ profileId: 'pA', limit: 12, offset: 24 });
    expect(p2.items.map((s) => s.id)).toEqual(['a6', 'a5', 'a4', 'a3', 'a2', 'a1']);
    expect(sessionsRepo.page({ profileId: 'pB', limit: 12, offset: 0 }).items.map((s) => s.id)).toEqual(['b3', 'b2', 'b1']);
  });

  it('question-type counts for the rows on the page', () => {
    const p0 = sessionsRepo.page({ profileId: 'pA', limit: 2, offset: 0 });
    expect(p0.items.find((s) => s.id === 'a29')?.typeCounts).toEqual({ behavioral: 1, technical_concept: 1 });
    const last = sessionsRepo.page({ profileId: 'pA', limit: 1, offset: 29 });
    expect(last.items[0]).toMatchObject({ id: 'a1', typeCounts: { behavioral: 1 }, jobCompany: 'Acme', jobTitle: 'Backend Engineer' });
  });

  it('search by Space title/company or activity, paged and counted server-side', () => {
    const acme = sessionsRepo.page({ profileId: 'pA', query: 'acme', limit: 5, offset: 0 });
    expect(acme.total).toBe(15);
    expect(acme.items.every((s) => s.jobCompany === 'Acme')).toBe(true);
    expect(sessionsRepo.page({ profileId: 'pA', query: 'standup', limit: 50, offset: 0 }).total).toBe(15);
    expect(sessionsRepo.page({ profileId: 'pA', query: 'meeting', limit: 50, offset: 0 }).total).toBe(15);
    expect(sessionsRepo.page({ profileId: 'pB', query: 'acme', limit: 50, offset: 0 }).total).toBe(0);
  });
});

describe('sessionsRepo.detail', () => {
  it("carries the session's other cards (oldest first, not its answers) and its Space", () => {
    h.db
      .insert(schema.contributions)
      .values([
        { id: 'c2', sessionId: 'a30', kind: 'action_item', status: 'completed', title: 'Send the deck', body: '', createdAt: 20 },
        { id: 'c1', sessionId: 'a30', kind: 'decision', status: 'completed', title: null, body: 'Ship Friday', createdAt: 10 },
        { id: 'c3', sessionId: 'a30', kind: 'answer', status: 'completed', title: 'Q', body: 'A', createdAt: 15 },
      ])
      .run();
    const d = sessionsRepo.detail('a30')!;
    expect(d.cards.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(d.spaceTitle).toBe('Daily standup');
    expect(sessionsRepo.detail('a29')!.spaceCompany).toBe('Acme');
  });
});
