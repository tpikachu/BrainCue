import { eq } from 'drizzle-orm';
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
import { enginePersistence } from '../../services/engine/persistence/enginePersistence';
import { sessionTimeline } from '../../../renderer/dashboard/sessionTimeline';

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
  it("carries the session's other cards, oldest first — leaving out only an answer already shown with its question — and its Space", () => {
    h.db.insert(schema.detectedQuestions).values({ id: 'q30', sessionId: 'a30', text: 'Why now?', type: 'behavioral', confidence: 1 }).run();
    h.db.insert(schema.aiAnswers).values({ id: 'aa30', questionId: 'q30', directAnswer: 'Because the team is ready.' }).run();
    h.db
      .insert(schema.contributions)
      .values([
        { id: 'c2', sessionId: 'a30', kind: 'action_item', status: 'completed', title: 'Send the deck', body: '', createdAt: 20 },
        { id: 'c1', sessionId: 'a30', kind: 'decision', status: 'completed', title: null, body: 'Ship Friday', createdAt: 10 },
        // A standalone answer (no detected question): its only record.
        { id: 'c3', sessionId: 'a30', kind: 'answer', status: 'completed', title: 'Q', body: 'A', createdAt: 15 },
        // The engine's dual-write of q30's answer: already shown with q30.
        {
          id: 'c4', sessionId: 'a30', kind: 'answer', status: 'completed', title: 'Why now?', body: 'Because the team is ready.', createdAt: 16,
          meta: JSON.stringify({ questionId: 'q30' }), sourceRefs: JSON.stringify([{ type: 'question', id: 'q30' }]),
        },
      ])
      .run();
    const d = sessionsRepo.detail('a30')!;
    expect(d.questions.map((q) => q.id)).toEqual(['q30']);
    expect(d.cards.map((c) => c.id)).toEqual(['c1', 'c3', 'c2']);
    expect(d.spaceTitle).toBe('Daily standup');
    expect(sessionsRepo.detail('a29')!.spaceCompany).toBe('Acme');
  });
});

describe('a saved voice quick Ask opens offline (M6 review)', () => {
  it('the answer the writer persisted — no detected question, no transcript — is in the detail', () => {
    h.db.insert(schema.sessions).values({ id: 'qa1', profileId: 'pA', mode: 'companion', kind: 'live', status: 'stopped', createdAt: 9_000 }).run();
    // Exactly what voiceService.quickAsk writes when quick Asks are saved.
    enginePersistence.insertContribution({
      sessionId: 'qa1',
      kind: 'answer',
      title: 'What is a write-ahead log?',
      body: 'A log of changes written before they are applied, so a crash can replay them.',
      meta: { source: 'voice_quick_ask' },
      sourceRefs: [{ type: 'chunk', id: 'k1' }],
    });
    const d = sessionsRepo.detail('qa1')!;
    expect(d.transcript).toEqual([]);
    expect(d.questions).toEqual([]);
    expect(d.cards).toHaveLength(1);
    expect(d.cards[0]).toMatchObject({
      kind: 'answer',
      title: 'What is a write-ahead log?',
      body: 'A log of changes written before they are applied, so a crash can replay them.',
      meta: { source: 'voice_quick_ask' },
    });
  });
});

describe('a paused correction stays cleared in history (M6 review 2)', () => {
  /** What EngineSession.answerQuestion persists for a completed answer. */
  const answered = (sessionId: string, text: string, answer: string) => {
    const questionId = enginePersistence.insertQuestion({ sessionId, text, type: 'behavioral', confidence: 1, strategy: '', transcriptChunkId: null });
    enginePersistence.replaceAnswer({ questionId, directAnswer: answer, riskWarning: null, tokens: null });
    enginePersistence.insertContribution({
      sessionId,
      kind: 'answer',
      title: text,
      body: answer,
      meta: { questionId, riskWarning: null, tokens: null },
      sourceRefs: [{ type: 'question', id: questionId }],
    });
    return questionId;
  };
  const PAUSED = 'Asked while paused — not answered. Press ↻ to answer it.';

  it('the old answer never reappears under the corrected wording', () => {
    h.db.insert(schema.sessions).values({ id: 'pc1', profileId: 'pA', mode: 'interview', kind: 'live', status: 'stopped', createdAt: 9_100 }).run();
    const q = answered('pc1', 'Tell me about the first project', 'The first project migrated billing.');
    // EngineSession.surfaceMissed for a revision that waited, then Pause:
    enginePersistence.updateQuestionText(q, 'Tell me about the first project. Sorry, I meant the second project', null);
    enginePersistence.replaceAnswer({ questionId: q, directAnswer: '', riskWarning: PAUSED, tokens: null });

    const d = sessionsRepo.detail('pc1')!;
    expect(d.cards).toEqual([]); // the stale copy is not offered to the view
    const tl = sessionTimeline(d);
    expect(tl).toEqual([
      { kind: 'suggestion', id: q, question: 'Tell me about the first project. Sorry, I meant the second project', answer: null, note: PAUSED },
    ]);
    expect(JSON.stringify(tl)).not.toContain('migrated billing');
  });

  it('controls: a normal linked answer shows once; a question with NO answer row recovers it from its card', () => {
    h.db.insert(schema.sessions).values({ id: 'pc2', profileId: 'pA', mode: 'interview', kind: 'live', status: 'stopped', createdAt: 9_200 }).run();
    const ok = answered('pc2', 'Why Acme?', 'Their scale.');
    const lost = answered('pc2', 'Why now?', 'The team is ready.');
    h.db.delete(schema.aiAnswers).where(eq(schema.aiAnswers.questionId, lost)).run(); // the answer row is missing
    const tl = sessionTimeline(sessionsRepo.detail('pc2')!);
    expect(tl.map((i) => (i.kind === 'suggestion' ? [i.id, i.answer] : i.kind))).toEqual([
      [ok, 'Their scale.'],
      [lost, 'The team is ready.'],
    ]);
  });
});
