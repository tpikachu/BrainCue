import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * PERF-01 OFFLINE BENCHMARK (M7.2b) — SIMULATED, never acceptance.
 *
 * Real: the engine and scheduler, the sql.js database with the real
 * migrations, indexing (chunker → chunks → embeddings), the vector store and
 * retriever, memory recall and its consent re-check, the conversation
 * context, Stop → Resume, the session archive, the interview mode and the
 * answer prompt, and the latency recorder. The transcriber's callbacks are
 * driven as the Realtime engine drives them (interim deltas, VAD
 * speech-stop, final). The Cue Card's paint report is a stand-in that uses
 * the REAL useful-text rule and returns the take main sent it.
 *
 * Simulated (fake timers, deterministic): the query embedding, the
 * classifier, and the answer provider's first token. The fixture data is
 * synthetic (perf01.fixtures.ts). Each question asserts the fact and source
 * its answer was grounded on as well as its timing, so a fast answer that
 * lost its grounding fails.
 *
 * Writes bench-results/perf01/simulated-{rows.jsonl,report.json,report.md}
 * (gitignored; outside test-results/, which Playwright clears) — the same report format a live run produces from
 * <userData>/metrics/latency.jsonl (metrics/report.ts).
 */

const MODEL = {
  EMBED: 700, // one query embedding
  STALL: 6000, // a stalled embedding (the stall variant)
  CLASSIFY: 900, // the classifier, for turns the rules leave ambiguous
  TTFT: 1000, // provider request → first token
  TOKEN_GAP: 40, // first token ("**") → the first word
  PAINT: 32, // two animation frames at 60 Hz
  LEAD: 1200, // the interim reads as the question this long before the final
  VAD_TO_FINAL: 600, // speech-stopped → final
  GAP: 20_000, // between questions
};

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../../test/dbHarness').TestDb,
  prompts: [] as string[],
  embedCalls: 0,
  embedDelay: 700,
  stt: null as null | { onDelta: (t: string) => void; onFinal: (t: string) => void; onSpeechStop?: () => void },
  onBroadcast: null as null | ((ch: string, p: Record<string, unknown>) => void),
  archiveSaid: '',
}));

vi.mock('../../../db', async () => {
  const schema = await vi.importActual<typeof import('../../../db/schema')>('../../../db/schema');
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
vi.mock('../../../ipc/broadcast', () => ({ broadcast: (ch: string, p: Record<string, unknown>) => h.onBroadcast?.(ch, p) }));
vi.mock('../../../windows/overlayWindow', () => ({ getOverlayWindow: () => null, showOverlay: vi.fn() }));
vi.mock('../../../windows/mainWindow', () => ({ getMainWindow: () => null }));
vi.mock('../../security/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../security/apiKey', () => ({ apiKeyStore: { isPresent: () => true, getDecrypted: () => null } }));
vi.mock('../../openai/client', () => ({
  normalizeOpenAIError: (e: unknown) => String(e),
  openai: () => {
    throw new Error('network disabled in the benchmark');
  },
}));
vi.mock('../../openai/followup', () => ({ predictFollowup: vi.fn(async () => null) }));
vi.mock('../../mock/sparringManager', () => ({ buildSparringReport: () => null }));
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
vi.mock('../../openai/questions', () => ({
  classifyQuestion: async (text: string, opts: { signal?: AbortSignal } = {}) => {
    await sleep(900, opts.signal);
    return { isQuestion: true, text, type: 'behavioral', confidence: 0.9, strategy: '' };
  },
}));
// The reference route: OpenAI, gpt-6-luna (its effort comes from the real catalog).
vi.mock('../../../providers/taskRoute', async (orig) => ({
  ...(await orig<typeof import('../../../providers/taskRoute')>()),
  taskRoute: (task: string) => (task === 'answer' ? { provider: 'openai', model: 'gpt-6-luna' } : null),
  retryRouteAfterModelError: () => null,
}));
vi.mock('../../../providers/registry', async () => {
  const { topicVector, TOPIC_WORDS } = await import('./perf01.fixtures');
  return {
    providerFor: (cap: string) => {
      if (cap === 'embedding')
        return {
          identity: () => ({ provider: 'fake', model: 'perf01-topic', dim: TOPIC_WORDS.length }),
          embed: async (texts: string[]) => texts.map(topicVector), // indexing: not on the live path
          embedOne: async (text: string, opts: { signal?: AbortSignal } = {}) => {
            h.embedCalls++;
            await sleep(h.embedDelay, opts.signal);
            return topicVector(text);
          },
        };
      if (cap === 'chat')
        return {
          async *stream(req: { user: string; signal?: AbortSignal }) {
            h.prompts.push(req.user);
            await sleep(1000, req.signal); // TTFT
            yield { type: 'delta', token: '**' };
            await sleep(40, req.signal); // TOKEN_GAP
            yield { type: 'delta', token: 'I would lead with the result' };
            yield { type: 'delta', token: '.**\n- one detail\n- another' };
            yield { type: 'usage', prompt: Math.round(req.user.length / 4), completion: 48 };
          },
          // The session archive's summary.
          json: async () => ({
            topic: 'Interview about the Atlas cut-over',
            summary: 'We discussed the Atlas cut-over and where the rollback plan was written.',
            participants: ['Northwind Mutual'],
            keyQuotes: [h.archiveSaid],
            sections: {},
          }),
        };
      if (cap === 'realtimeStt')
        return {
          open: (cb: typeof h.stt) => {
            h.stt = cb;
            return { appendAudio: () => {}, stop: () => {} };
          },
        };
      throw new Error(`unexpected capability: ${cap}`);
    },
  };
});

import { EVENTS } from '@shared/ipc';
import * as schema from '../../../db/schema';
import { createTestDb } from '../../../test/dbHarness';
import { SETTINGS_KEYS, settingsRepo } from '../../../db/repositories/settings.repo';
import { indexJob, reindexProfile } from '../../rag/indexProfile';
import { archiveSessionOutcome } from '../sessionArchive';
import { clearLiveEmbedCache } from '../../rag/liveEmbed';
import { engine } from '../engine';
import { latency, setLatencySink } from '../metrics/latencyStore';
import { buildReport, renderMarkdown, type Row } from '../metrics/report';
import { hasUsefulText } from '../../../../renderer/lib/usefulText';
import {
  GENERAL,
  MEMORIES,
  PERF01_VERSION,
  PROFILE,
  SCENARIOS,
  SPACE,
  TECHNICAL,
  knowledgeBaseSize,
  topicVector,
  TOPIC_WORDS,
  type Question,
  type Source,
} from './perf01.fixtures';

const rows: Row[] = [];
/** A measurement sample: one of the 30 General / 30 Technical fixture questions. */
const isSample = (r: Row) => /^[GT]\d\d$/.test(r.fixtureId ?? '');
let profileId = '';
let packId = '';

/** The Cue Card's paint report, as Overlay.tsx makes it: the first painted
 *  text holding a real word, two frames later, with the card's take. */
function installCueCard() {
  const text = new Map<string, string>();
  const take = new Map<string, number>();
  const gen = new Map<string, number>();
  const reported = new Set<string>();
  h.onBroadcast = (ch, p) => {
    if (!p || typeof p !== 'object') return;
    const id = p.contributionId as string;
    if (ch === EVENTS.contributionPatch && typeof p.latencyTake === 'number') take.set(id, p.latencyTake);
    if (ch === EVENTS.contributionReset) {
      gen.set(id, (gen.get(id) ?? 0) + 1);
      text.delete(id);
      take.delete(id);
      reported.delete(id);
    }
    if (ch === EVENTS.contributionDelta && !reported.has(id)) {
      const sofar = (text.get(id) ?? '') + (p.token as string);
      text.set(id, sofar);
      if (!hasUsefulText(sofar)) return;
      reported.add(id);
      const g = gen.get(id) ?? 0;
      const t = take.get(id);
      setTimeout(() => {
        if ((gen.get(id) ?? 0) === g) latency.mark(id, { firstUsefulAt: Date.now() }, t);
      }, MODEL.PAINT);
    }
  };
}

function seed() {
  profileId = 'perf01-profile';
  packId = 'perf01-space';
  h.db.insert(schema.profiles).values({ id: profileId, ...PROFILE }).run();
  h.db
    .insert(schema.contextPacks)
    .values({ id: packId, profileId, title: SPACE.title, company: SPACE.company, kind: 'job', jdText: SPACE.jdText, companyResearch: SPACE.companyResearch })
    .run();
  settingsRepo.set(SETTINGS_KEYS.memoryEnabled, '1');
  for (const m of MEMORIES) {
    const v = topicVector(m.content);
    h.db
      .insert(schema.memories)
      .values({
        id: m.id,
        profileId,
        packId: null,
        category: 'preference',
        content: m.content,
        status: 'approved',
        embedProvider: 'fake',
        embedModel: 'perf01-topic',
        embedDim: TOPIC_WORDS.length,
        embedVector: Buffer.from(v.buffer),
      })
      .run();
  }
}

const promptFor = (q: string) => {
  const p = [...h.prompts].reverse().find((x) => x.includes(`QUESTION: ${q}`));
  if (!p) throw new Error(`no prompt for: ${q}`);
  return p;
};
/** The section of the prompt a source's grounding appears in. */
function section(prompt: string, source: Source): string {
  const at = (s: string) => prompt.indexOf(s);
  const ctx = prompt.slice(at('CONTEXT:'), at('MEMORY (') >= 0 ? at('MEMORY (') : at('CONVERSATION SO FAR') >= 0 ? at('CONVERSATION SO FAR') : at('\nQUESTION: '));
  if (source === 'memory') return prompt.slice(at('MEMORY ('), at('CONVERSATION SO FAR') >= 0 ? at('CONVERSATION SO FAR') : at('\nQUESTION: '));
  if (source === 'conversation') return prompt.slice(at('CONVERSATION SO FAR'), at('\nQUESTION: '));
  return ctx;
}
const SOURCE_TAG: Partial<Record<Source, RegExp>> = {
  resume: /resume|résumé/i,
  jd: /\bjd\b|job description/i,
  company: /company/i,
  session: /session|earlier conversation|previous conversation/i,
};

/** Drive one interviewer question through the real transcriber callbacks
 *  and wait for its record (written after the simulated paint). */
async function ask(q: { id: string; text: string }, v: { interim: boolean; stall: boolean }): Promise<Row> {
  h.embedDelay = v.stall ? MODEL.STALL : MODEL.EMBED;
  clearLiveEmbedCache(); // each question pays its own embedding, as distinct live questions do
  const before = rows.length;
  if (v.interim) {
    h.stt!.onDelta(q.text); // the interim already reads as the question
    await vi.advanceTimersByTimeAsync(MODEL.LEAD - MODEL.VAD_TO_FINAL);
  } else {
    await vi.advanceTimersByTimeAsync(MODEL.LEAD - MODEL.VAD_TO_FINAL);
  }
  h.stt!.onSpeechStop?.();
  await vi.advanceTimersByTimeAsync(MODEL.VAD_TO_FINAL);
  h.stt!.onFinal(q.text);
  for (let t = 0; t < 60_000 && rows.length === before; t += 20) await vi.advanceTimersByTimeAsync(20);
  const r = rows.at(-1)!;
  expect(rows.length, `${q.id} wrote one record`).toBe(before + 1);
  r.fixtureId = q.id;
  return r;
}

/** Candidate speech (no transcriber of its own here: as the M4 acceptance does). */
async function say(sid: string, text: string) {
  void engine.processFinalTranscript(sid, text, 'candidate');
  await vi.advanceTimersByTimeAsync(1700);
}

const variantOf = (i: number) => ({ interim: i % 3 !== 2, stall: i % 10 === 9 });

/** The timing each variant must show on this model — the pipeline's own share. */
function expectTiming(r: Row, v: { interim: boolean; stall: boolean }, id: string) {
  expect(r.outcome, id).toBe('answered');
  expect(r.firstUsefulAt! - r.firstTokenAt!, `${id} first word painted`).toBe(MODEL.TOKEN_GAP + MODEL.PAINT);
  expect(r.firstTokenAt! - r.requestAt!, `${id} provider`).toBe(MODEL.TTFT);
  const contextWait = r.requestAt! - r.dispatchAt!;
  if (v.stall) {
    expect(contextWait, `${id} stalled embedding capped`).toBeLessThanOrEqual(2500);
    expect(r.lexical?.length, `${id} ranked lexically`).toBeGreaterThan(0);
  } else if (v.interim) {
    expect(r.prefetched, `${id} prefetched on the interim`).toBe(true);
    expect(contextWait, `${id} no wait for context`).toBe(0);
  } else {
    expect(r.prefetched, id).toBe(false);
    expect(contextWait, `${id} one embedding round trip`).toBe(MODEL.EMBED);
  }
  expect(r.speechEndSource, id).toBe('vad');
  expect(r.finalAt - r.speechEndAt!, id).toBe(MODEL.VAD_TO_FINAL);
  expect(r).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', effort: 'none' });
}

beforeAll(async () => {
  h.db = (await createTestDb()).db;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-18T09:00:00Z'));
  seed();
  await reindexProfile(profileId);
  await indexJob(packId);
  installCueCard();
  setLatencySink((t) => rows.push({ ...t }));
});

afterAll(() => {
  setLatencySink(null);
  const cur = (engine as unknown as { current: { sessionId: string } | null }).current;
  if (cur) engine.stop(cur.sessionId);
  vi.useRealTimers();
  // The export: same format as a live run's report.
  const dir = path.join(process.cwd(), 'bench-results', 'perf01');
  mkdirSync(dir, { recursive: true });
  // The acceptance tables: exactly the 30 General + 30 Technical fixture
  // questions. Scenario rows (follow-ups, the long session, resume, archive)
  // are listed on their own below — never mixed into the samples.
  const sample = rows.filter(isSample);
  const scenarios = rows.filter((r) => !isSample(r) && !/^L-f/.test(r.fixtureId ?? ''));
  const report = buildReport(sample, {
    simulated: true,
    title: `PERF-01 offline benchmark (${PERF01_VERSION}) — SIMULATED`,
    run: {
      simulated: true,
      fixtures: PERF01_VERSION,
      latencyModelMs: MODEL,
      variants: 'per category: interim on 2 of every 3 questions, a stalled embedding on every 10th',
      knowledgeBase: knowledgeBaseSize(),
      reference: { answer: 'openai/gpt-6-luna (simulated)', embedding: 'deterministic topic vectors (simulated)' },
      host: { cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, platform: `${os.platform()} ${os.release()}`, node: process.version },
      note: 'Cold starts are not modelled offline: every row after the first is warm.',
    },
    decisionsAllTurns: latency.summary().decisions,
  });
  writeFileSync(path.join(dir, 'simulated-rows.jsonl'), rows.map((r) => JSON.stringify({ ...r, simulated: true })).join('\n') + '\n');
  writeFileSync(path.join(dir, 'simulated-report.json'), JSON.stringify(report, null, 2));
  const scenarioTable = [
    '## Scenario questions (not in the samples above)',
    '',
    '| id | outcome | prefetched | lexical | final → first useful | context wait |',
    '| --- | --- | --- | --- | --- | --- |',
    ...scenarios.map(
      (r) =>
        `| ${r.fixtureId} | ${r.outcome} | ${r.prefetched ? 'yes' : 'no'} | ${r.lexical?.join(', ') || '—'} | ${r.firstUsefulAt! - r.finalAt} ms | ${r.requestAt! - r.dispatchAt!} ms |`,
    ),
    ``,
    `Plus ${rows.filter((r) => /^L-f/.test(r.fixtureId ?? '')).length} filler exchanges of the long session (all answered; not samples).`,
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'simulated-report.md'), renderMarkdown(report) + '\n' + scenarioTable);
});

describe('PERF-01 offline benchmark — SIMULATED (perf01-v1 fixtures)', () => {
  it('indexes the full synthetic knowledge base', () => {
    const kb = knowledgeBaseSize();
    expect(kb.resumeChars).toBeGreaterThan(6000);
    const chunks = h.db.select().from(schema.chunks).all();
    expect(chunks.filter((c) => c.sourceType === 'resume').length).toBeGreaterThanOrEqual(7);
    expect(chunks.filter((c) => c.sourceType === 'jd').length).toBeGreaterThanOrEqual(3);
    expect(chunks.filter((c) => c.sourceType === 'company').length).toBeGreaterThanOrEqual(1);
    expect(h.db.select().from(schema.embeddings).all().length).toBe(chunks.length); // every chunk embedded
  });

  for (const [label, set, format] of [
    ['General', GENERAL, 'general'],
    ['simple Technical', TECHNICAL, 'technical'],
  ] as const) {
    it(`${label}: 30 questions, each grounded on its fact and timed stage by stage`, async () => {
      const sid = engine.start(profileId, 'general', packId, format).id;
      // One unmeasured warm-up, as the live plan does: the measured 30 are
      // all warm (the process's first answer is the cold one).
      await ask({ id: `W-${format}`, text: 'Could you start by telling me a little about yourself?' }, { interim: true, stall: false });
      await vi.advanceTimersByTimeAsync(MODEL.GAP);
      for (const [i, q] of (set as Question[]).entries()) {
        const v = variantOf(i);
        const r = await ask(q, v);
        expect(r.category, q.id).toBe(format);
        expectTiming(r, v, q.id);
        const prompt = promptFor(q.text);
        expect(section(prompt, q.source), `${q.id} grounded on "${q.fact}" (${q.source})`).toContain(q.fact);
        if (SOURCE_TAG[q.source]) expect(section(prompt, q.source), q.id).toMatch(SOURCE_TAG[q.source]!);
        await vi.advanceTimersByTimeAsync(MODEL.GAP);
      }
      engine.stop(sid);
    }, 120_000);
  }

  it('follow-up keeps its subject, a topic change drops it — with no interim and with a stalled embedding', async () => {
    const sid = engine.start(profileId, 'general', packId, 'general').id;
    const [f1, f2, f3] = SCENARIOS.followup;
    const variants = [
      { interim: true, stall: false },
      { interim: false, stall: false },
      { interim: false, stall: true },
    ];
    for (const [i, q] of [f1, f2, f3].entries()) {
      const r = await ask(q, variants[i]);
      expectTiming(r, variants[i], q.id);
      expect(section(promptFor(q.text), q.source), q.id).toContain(q.fact);
      await say(sid, i === 0 ? 'I led the Atlas cut-over and wrote the runbook.' : 'Northwind fits how I like to work.');
      await vi.advanceTimersByTimeAsync(MODEL.GAP);
    }
    // The follow-up's prompt still carries the subject it refers to.
    expect(promptFor(f2.text)).toMatch(/Atlas/);
    engine.stop(sid);
  }, 60_000);

  it('30+ exchanges, Stop → Resume, and an archived session: the early fact is recalled every time', async () => {
    const L = SCENARIOS.longSession;
    const sid = engine.start(profileId, 'general', packId, 'general').id;
    await ask({ id: 'L00', text: L.early.q }, { interim: true, stall: false });
    await say(sid, L.early.said);
    for (let i = 1; i <= 31; i++) {
      const f = L.filler(i);
      await ask({ id: `L-f${i}`, text: f.q }, { interim: i % 2 === 0, stall: false });
      await say(sid, f.said);
    }
    const live = await ask(L.recall, { interim: false, stall: false });
    expectTiming(live, { interim: false, stall: false }, 'L01 live');
    expect(section(promptFor(L.recall.text), 'conversation'), 'L01 after 32 exchanges').toContain(L.recall.fact);
    expect(promptFor(L.recall.text).length).toBeLessThan(20_000); // bounded

    engine.stop(sid);
    engine.resume(sid);
    h.prompts.length = 0;
    await vi.advanceTimersByTimeAsync(MODEL.GAP);
    const resumed = await ask({ ...L.recall, id: 'L01-resumed' }, { interim: false, stall: true });
    expectTiming(resumed, { interim: false, stall: true }, 'L01 resumed');
    expect(section(promptFor(L.recall.text), 'conversation'), 'L01 after resume').toContain(L.recall.fact);
    engine.stop(sid);

    // Archive the session into its Space; a NEW session there recalls it.
    h.archiveSaid = L.early.said;
    expect((await archiveSessionOutcome(sid)).status).toBe('done');
    const next = engine.start(profileId, 'general', packId, 'general').id;
    const archived = await ask(L.archived, { interim: true, stall: false });
    expectTiming(archived, { interim: true, stall: false }, 'A01');
    expect(section(promptFor(L.archived.text), 'session'), 'A01 grounded on the archive').toContain(L.archived.fact);
    engine.stop(next);
  }, 180_000);

  it('the export has every sample, labelled simulated, with routes and context sizes', () => {
    const report = buildReport(rows.filter(isSample), { simulated: true, title: 't' });
    const g = report.summary.byCategory.general;
    const t = report.summary.byCategory.technical;
    expect(g.all.samples).toBe(30);
    expect(t.all.samples).toBe(30);
    expect(report.verdicts.general.usefulP95).toBe('simulated — not acceptance');
    expect(Object.keys(report.routes)).toEqual(['openai/gpt-6-luna · effort none']);
    expect(report.context.chunks.p50).toBeGreaterThanOrEqual(5);
    expect(report.unanswered).toEqual([]);
    expect(renderMarkdown(report)).toMatch(/^# t\n\n\*\*SIMULATED/);
  });
});
