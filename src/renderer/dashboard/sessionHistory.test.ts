import { describe, expect, it } from 'vitest';
import type { KeepStepStatus, RememberResult, SessionDetail } from '@shared/types';
import { sessionTimeline } from './sessionTimeline';
import { failedHalves, keepPreview, keepResult, mergeRetry } from './keepCopy';

/** M6: a saved session reads as a timeline built only from what was
 *  persisted, and the save prompt says what Keep will do and did. */

const turn = (id: string, speaker: string, text: string, createdAt: number) => ({
  id,
  sessionId: 's',
  speaker: speaker as SessionDetail['transcript'][number]['speaker'],
  text,
  isFinal: true,
  tStart: null,
  tEnd: null,
  createdAt,
});
const question = (id: string, text: string, chunk: string | null, createdAt: number, answer: string | null, riskWarning: string | null = null) => ({
  id,
  sessionId: 's',
  text,
  type: 'behavioral' as const,
  confidence: 1,
  strategy: '',
  createdAt,
  transcriptChunkId: chunk,
  answer: answer === null && !riskWarning ? null : { id: `a-${id}`, questionId: id, directAnswer: answer ?? '', riskWarning, followupQuestion: null, model: 'm', tokens: null, createdAt },
});

describe('sessionTimeline', () => {
  it('keeps CAPTURE order (not the clock) and places each suggestion after the turn it was detected on', () => {
    // M4: capture order can disagree with createdAt (a late final). The
    // detail returns capture order; the timeline must not re-sort it.
    const d = {
      mode: 'interview' as const,
      transcript: [
        turn('t1', 'interviewer', 'Tell me about a migration you led?', 30),
        turn('t2', 'candidate', 'Sure — the Postgres one.', 20),
        turn('t3', 'interviewer', 'How did you roll it back?', 40),
      ],
      questions: [
        question('q2', 'How did you roll it back?', 't3', 41, 'Feature flags and a dual-write window.'),
        question('q1', 'Tell me about a migration you led?', 't1', 31, 'Lead with the Postgres cut-over.'),
      ],
      cards: [],
    };
    const tl = sessionTimeline(d);
    expect(tl.map((i) => `${i.kind}:${i.id}`)).toEqual(['turn:t1', 'suggestion:q1', 'turn:t2', 'turn:t3', 'suggestion:q2']);
    // Said vs generated are different kinds, with the speaker in plain words.
    expect(tl[0]).toMatchObject({ kind: 'turn', who: 'them', label: 'Interviewer' });
    expect(tl[2]).toMatchObject({ kind: 'turn', who: 'you', label: 'You' });
    expect(tl[1]).toMatchObject({ kind: 'suggestion', answer: 'Lead with the Postgres cut-over.' });
  });

  it('a missed question shows as not answered, with why; a typed Ask (no turn) sits by time', () => {
    const tl = sessionTimeline({
      mode: 'interview',
      transcript: [turn('t1', 'interviewer', 'First?', 10), turn('t2', 'interviewer', 'Second?', 20)],
      questions: [
        question('q1', 'First?', 't1', 11, null, 'Asked while paused — not answered. Press ↻ to answer it.'),
        question('typed', 'What is the salary band?', null, 15, 'Ask about the range.'),
      ],
      cards: [],
    });
    expect(tl.map((i) => `${i.kind}:${i.id}`)).toEqual(['turn:t1', 'suggestion:q1', 'suggestion:typed', 'turn:t2']);
    expect(tl[1]).toMatchObject({ answer: null, note: expect.stringMatching(/paused/) });
  });

  it("a meeting's cards are placed by time; its speakers are You / Them", () => {
    const tl = sessionTimeline({
      mode: 'meeting',
      transcript: [turn('t1', 'them', 'Can we ship Friday?', 10), turn('t2', 'you', 'Yes.', 20)],
      questions: [],
      cards: [
        { id: 'c1', sessionId: 's', kind: 'decision', status: 'completed', title: null, body: 'Ship Friday', meta: null, sourceRefs: null, createdAt: 25, updatedAt: 25 },
      ],
    });
    expect(tl.map((i) => `${i.kind}:${i.id}`)).toEqual(['turn:t1', 'turn:t2', 'card:c1']);
    expect(tl[0]).toMatchObject({ label: 'Them' });
  });

  it('an empty session is an empty timeline', () => {
    expect(sessionTimeline({ mode: 'interview', transcript: [], questions: [], cards: [] })).toEqual([]);
  });

  const answerCard = (id: string, title: string, body: string, createdAt: number, meta: Record<string, unknown> | null) => ({
    id, sessionId: 's', kind: 'answer' as const, status: 'completed' as const, title, body, meta, sourceRefs: null, createdAt, updatedAt: createdAt,
  });

  it('a saved voice quick Ask (no transcript, no detected question) reads as generated: what was asked, and the answer', () => {
    const tl = sessionTimeline({
      mode: 'companion',
      transcript: [],
      questions: [],
      cards: [answerCard('qa', 'What is a write-ahead log?', 'A log written before changes are applied.', 5, { source: 'voice_quick_ask' })],
    });
    expect(tl).toEqual([
      { kind: 'suggestion', id: 'qa', question: 'What is a write-ahead log?', answer: 'A log written before changes are applied.', note: null, asked: true },
    ]);
  });

  it("an answer card written for a detected question is never shown twice — it only fills that question's missing answer", () => {
    const tl = sessionTimeline({
      mode: 'interview',
      transcript: [turn('t1', 'interviewer', 'Why Acme?', 10), turn('t2', 'interviewer', 'Why now?', 20)],
      questions: [question('q1', 'Why Acme?', 't1', 11, 'Their scale.'), question('q2', 'Why now?', 't2', 21, null)],
      cards: [
        answerCard('c1', 'Why Acme?', 'Their scale.', 12, { questionId: 'q1' }),
        answerCard('c2', 'Why now?', 'The team is ready.', 22, { questionId: 'q2' }),
      ],
    });
    expect(tl.map((i) => `${i.kind}:${i.id}`)).toEqual(['turn:t1', 'suggestion:q1', 'turn:t2', 'suggestion:q2']);
    expect(tl[3]).toMatchObject({ answer: 'The team is ready.' });
  });

  it('an answer cleared on purpose (a paused correction: empty row + note) never takes an older card\'s answer', () => {
    const note = 'Asked while paused — not answered. Press ↻ to answer it.';
    const tl = sessionTimeline({
      mode: 'interview',
      transcript: [turn('t1', 'interviewer', 'Tell me about the first project. Sorry, I meant the second project', 10)],
      questions: [question('q1', 'Tell me about the first project. Sorry, I meant the second project', 't1', 11, '', note)],
      cards: [answerCard('c1', 'Tell me about the first project', 'The first project migrated billing.', 12, { questionId: 'q1' })],
    });
    expect(tl.map((i) => `${i.kind}:${i.id}`)).toEqual(['turn:t1', 'suggestion:q1']);
    expect(tl[1]).toMatchObject({ answer: null, note });
  });
});

describe('keepPreview — what Keep will do, before it is pressed', () => {
  const base = { archiveOn: true, memoryOn: false, practice: false, provider: 'Anthropic' };
  it('names the provider the transcript goes to, and what it makes', () => {
    const l = keepPreview({ ...base, space: { title: 'Backend Engineer', remembers: true } }).map((x) => x.text);
    expect(l[0]).toMatch(/stays on this machine/);
    expect(l[1]).toBe('The transcript is sent to Anthropic to make a short summary, filed into “Backend Engineer”.');
    expect(l[2]).toMatch(/Memory suggestions are off/);
  });
  it('no Space, or a Space that opted out, sends nothing — and says so', () => {
    expect(keepPreview({ ...base, space: null }).map((x) => x.text).join(' ')).toMatch(/nothing is sent anywhere/);
    expect(keepPreview({ ...base, space: { title: 'X', remembers: false } }).map((x) => x.text).join(' ')).toMatch(/remembering turned off: nothing is summarised or sent/);
    expect(keepPreview({ ...base, archiveOn: false, space: { title: 'X', remembers: true } }).map((x) => x.text).join(' ')).toMatch(/both off in Settings — nothing is sent/);
  });
  it('never promises that everything stays on the machine when it will not', () => {
    for (const memoryOn of [true, false]) {
      const all = keepPreview({ ...base, memoryOn, space: { title: 'X', remembers: true } }).map((x) => x.text).join(' ');
      expect(all).not.toMatch(/Everything stays on this machine/);
      expect(all).toMatch(/sent to Anthropic/);
    }
  });
});

describe('keepResult — what Keep did, never inferred from a zero count', () => {
  const result = (summary: KeepStepStatus, memory: KeepStepStatus, extra: Partial<RememberResult> = {}): RememberResult => ({
    kept: true,
    packId: 'j',
    summary: { status: summary, count: summary === 'done' ? 3 : 0, ...(summary === 'failed' ? { error: 'No Anthropic API key' } : {}) },
    memory: { status: memory, count: memory === 'done' ? 2 : 0, ...(memory === 'failed' ? { error: 'timeout' } : {}) },
    provider: 'anthropic',
    archived: 0,
    memories: 0,
    ...extra,
  });
  const ctx = { space: 'Backend Engineer', provider: 'Anthropic' };
  const text = (r: RememberResult) => keepResult(r, ctx).lines.map((l) => `${l.tone}:${l.text}`);

  it('success, each half as itself', () => {
    expect(text(result('done', 'done'))).toEqual([
      'ok:Kept — the transcript is on this machine, readable in Sessions.',
      'ok:Summary saved to “Backend Engineer” (made by Anthropic) — the next conversation there starts from it.',
      'ok:2 memory suggestions waiting for your review in Memory — nothing is remembered until you approve it.',
    ]);
    expect(keepResult(result('done', 'off'), ctx).failed).toBe(false);
  });

  it('switched off, opted out, no Space, too short — each says why, and that nothing was sent', () => {
    expect(text(result('off', 'off')).join(' ')).toMatch(/off in Settings — nothing was sent/);
    expect(text(result('space-off', 'space-off')).join(' ')).toMatch(/remembering turned off — nothing was sent/);
    expect(text(result('no-space', 'no-space'))).toEqual([
      'ok:Kept — the transcript is on this machine, readable in Sessions.',
      'muted:No Space, so nothing was summarised or sent.',
    ]);
    expect(text(result('too-short', 'too-short')).join(' ')).toMatch(/Too little was said/);
    expect(text(result('done', 'nothing-new')).join(' ')).toMatch(/No new memory suggestions/);
  });

  it('a retry runs only the failed half; the confirmed half keeps its outcome', () => {
    const first = result('failed', 'done', { archived: 0, memories: 2 });
    expect(failedHalves(first)).toEqual(['summary']);
    expect(failedHalves(result('failed', 'failed'))).toEqual(['summary', 'memory']);
    expect(failedHalves(result('done', 'off'))).toEqual([]);
    // The retry's memory half did not run — the 2 waiting suggestions stand.
    const merged = mergeRetry(first, result('done', 'not-run'));
    expect(merged.summary.status).toBe('done');
    expect(merged.memory).toEqual({ status: 'done', count: 2 });
    expect([merged.archived, merged.memories]).toEqual([3, 2]);
    expect(keepResult(merged, ctx).failed).toBe(false);
    expect(text(merged)).toContain('ok:2 memory suggestions waiting for your review in Memory — nothing is remembered until you approve it.');
    // A retry that fails again replaces only its own half.
    const again = mergeRetry(first, result('failed', 'not-run'));
    expect([again.summary.status, again.memory.status]).toEqual(['failed', 'done']);
  });

  it('a failure names the reason, keeps the transcript and offers a retry', () => {
    const r = keepResult(result('failed', 'off'), ctx);
    expect(r.failed).toBe(true);
    expect(r.lines.map((l) => l.text)).toContain('The summary failed (No Anthropic API key).');
    expect(r.lines.at(-1)?.text).toMatch(/transcript is kept either way/);
    expect(keepResult(result('done', 'failed'), ctx).lines.map((l) => l.text)).toContain('Memory suggestions failed (timeout).');
    // A provider message's own full stop is not doubled.
    const dotted = { ...result('failed', 'off'), summary: { status: 'failed' as const, count: 0, error: 'Connection error.' } };
    expect(keepResult(dotted, ctx).lines.map((l) => l.text)).toContain('The summary failed (Connection error).');
  });
});
