import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '@shared/ipc';
import type { VoiceAudioEvent, VoiceStateEvent } from '@shared/types';

/**
 * Voice orchestrator acceptance (Prompt 9): the REAL VoiceService over the
 * sql.js db and real bridge/persistence, with the provider surface scripted.
 * Pins the contract:
 *  - no-session summon = quick ask over the default Space, GENERIC-only events
 *  - quick asks are ephemeral unless saveQuickAsks is on (then one reused
 *    'companion' session per profile)
 *  - in-session summon routes through the ENGINE's direct-ask pipeline
 *  - barge-in bumps the generation and stale synthesized audio is never sent
 *  - muted / missing speech capability → text-only fallback, never a crash
 *  - unsummoned contributions are never spoken
 *  - raw audio / synthesized base64 never reaches the logs
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  events: [] as { ch: string; payload: unknown }[],
  sttCalls: [] as { bytes: number; mime: string; riff: string }[],
  sttResult: 'what is our pricing',
  sttFail: false,
  chatTokens: ['The plan is 99 dollars per seat. ', 'It includes SSO for everyone.'],
  speakCalls: [] as { text: string; voice: string }[],
  speakFail: false,
  speakGated: false,
  speakGates: [] as (() => void)[],
  logCalls: [] as unknown[][],
}));

vi.mock('../../db', async () => {
  const schema = await vi.importActual<typeof import('../../db/schema')>('../../db/schema');
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
vi.mock('../../ipc/broadcast', () => ({
  broadcast: (ch: string, payload: unknown) => h.events.push({ ch, payload }),
}));
vi.mock('../../windows/overlayWindow', () => ({
  getOverlayWindow: () => null,
  showOverlay: vi.fn(),
}));
vi.mock('../../windows/mainWindow', () => ({ getMainWindow: () => null }));
vi.mock('../security/logger', () => ({
  log: {
    info: (...a: unknown[]) => h.logCalls.push(a),
    warn: (...a: unknown[]) => h.logCalls.push(a),
    error: (...a: unknown[]) => h.logCalls.push(a),
  },
}));
vi.mock('../openai/client', () => ({
  normalizeOpenAIError: (e: unknown) => String(e),
  openai: () => {
    throw new Error('network disabled in tests');
  },
}));
vi.mock('../openai/followup', () => ({ predictFollowup: vi.fn(async () => null) }));
vi.mock('../openai/questions', () => ({ classifyQuestion: vi.fn() }));
vi.mock('../rag/retriever', () => ({
  retrieve: async () => [
    { id: 'cx1', sourceType: 'company', content: 'Enterprise: $99/seat with SSO.', score: 0.8 },
  ],
}));
// The whole provider surface, scripted — no OpenAI module chain ever loads.
vi.mock('../../providers/registry', () => ({
  providerFor: (cap: string) => {
    if (cap === 'batchStt') {
      return {
        transcribe: async (audio: ArrayBuffer, mime: string) => {
          h.sttCalls.push({
            bytes: audio.byteLength,
            mime,
            riff: Buffer.from(audio.slice(0, 4)).toString('ascii'),
          });
          if (h.sttFail) throw new Error('stt down');
          return h.sttResult;
        },
      };
    }
    if (cap === 'speech') {
      return {
        speak: async (text: string, voice: string) => {
          h.speakCalls.push({ text, voice });
          if (h.speakFail) throw new Error('tts down');
          if (h.speakGated) await new Promise<void>((r) => h.speakGates.push(r));
          return Buffer.from(`mp3:${text}`);
        },
      };
    }
    if (cap === 'chat') {
      return {
        json: async () => ({}),
        stream: async function* () {
          for (const t of h.chatTokens) yield { type: 'delta', token: t };
          yield { type: 'usage', prompt: 10, completion: 5 };
        },
      };
    }
    if (cap === 'realtimeStt') {
      return { open: () => ({ appendAudio: vi.fn(), stop: vi.fn() }) };
    }
    throw new Error(`unexpected capability: ${cap}`);
  },
}));

import * as schema from '../../db/schema';
import { createTestDb } from '../../test/dbHarness';
import { VoiceService } from './voiceService';
import { engine } from './../engine/engine';
import { emitGenericDelta } from '../../ipc/contributionBridge';

const evts = (ch: string) => h.events.filter((e) => e.ch === ch);
const states = () => evts(EVENTS.voiceState).map((e) => e.payload as VoiceStateEvent);
const lastState = () => states()[states().length - 1];
const audioEvts = () => evts(EVENTS.voiceAudio).map((e) => e.payload as VoiceAudioEvent);

/** Drain queued microtasks + zero-timers so fire-and-forget flows settle. */
const flush = async (n = 25) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Enough PCM to clear the too-short capture gate. */
function feedSpeech(svc: VoiceService, bytes = 16_384): void {
  svc.feedAudio(new ArrayBuffer(bytes / 2));
  svc.feedAudio(new ArrayBuffer(bytes / 2));
}

async function runQuickAsk(svc: VoiceService): Promise<void> {
  svc.summon();
  feedSpeech(svc);
  await svc.commit();
  await flush();
}

let seq = 0;
function addProfile(): string {
  const id = `vp${++seq}`;
  h.db
    .insert(schema.profiles)
    .values({ id, name: 'Test User', targetRole: 'PM', parsedResume: '{"skills":[]}' })
    .run();
  return id;
}

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});

beforeEach(() => {
  h.events.length = 0;
  h.sttCalls.length = 0;
  h.speakCalls.length = 0;
  h.logCalls.length = 0;
  h.speakGates.length = 0;
  h.sttResult = 'what is our pricing';
  h.sttFail = false;
  h.speakFail = false;
  h.speakGated = false;
  h.chatTokens = ['The plan is 99 dollars per seat. ', 'It includes SSO for everyone.'];
  // Reset persisted prefs between tests (muted/saveQuickAsks leak otherwise).
  h.db.delete(schema.settings).run();
});

afterEach(() => {
  // Never leave a live engine session behind for the next test.
  const live = engine.activeInfo();
  if (live) engine.stop(live.sessionId);
});

describe('quick ask (no session)', () => {
  it('fails visibly when no profile exists to ground in', async () => {
    // Runs against an empty profiles table (first test in the file).
    expect(h.db.select().from(schema.profiles).all()).toHaveLength(0);
    const svc = new VoiceService();
    await runQuickAsk(svc);
    expect(svc.state).toBe('error');
    expect(lastState().error).toMatch(/profile/i);
  });

  it('streams a generic-only contribution and speaks it, ending idle', async () => {
    addProfile();
    const svc = new VoiceService();

    svc.summon();
    expect(svc.state).toBe('listening');
    expect(lastState().state).toBe('listening');

    feedSpeech(svc);
    await svc.commit();
    await flush();

    // STT received a WAV file of the buffered capture.
    expect(h.sttCalls).toHaveLength(1);
    expect(h.sttCalls[0].riff).toBe('RIFF');
    expect(h.sttCalls[0].mime).toBe('audio/wav');
    // The thinking state carries what was heard.
    expect(states().some((s) => s.state === 'thinking' && s.transcript === h.sttResult)).toBe(true);

    // GENERIC-only contribution events — never the legacy question/answer twins.
    expect(evts('contribution:open')).toHaveLength(1);
    expect(evts('session:question-detected')).toHaveLength(0);
    expect(evts('session:answer-delta')).toHaveLength(0);
    const body = evts('contribution:delta')
      .map((e) => (e.payload as { token: string }).token)
      .join('');
    expect(body).toBe(h.chatTokens.join(''));
    expect(evts('contribution:done')).toHaveLength(1);

    // Speech: one segment per sentence + the end marker, then playback → idle.
    expect(h.speakCalls.map((c) => c.text)).toEqual([
      'The plan is 99 dollars per seat.',
      'It includes SSO for everyone.',
    ]);
    const audio = audioEvts();
    expect(audio).toHaveLength(3);
    expect(audio[0].seq).toBe(0);
    expect(audio[2].last).toBe(true);
    expect(audio[2].audioBase64).toBe('');
    expect(svc.state).toBe('speaking');

    svc.playbackDone(audio[0].generation);
    expect(svc.state).toBe('idle');
    // Ephemeral by default: nothing persisted.
    expect(h.db.select().from(schema.contributions).all()).toHaveLength(0);
  });

  it('persists into ONE reused companion session when saveQuickAsks is on', async () => {
    addProfile();
    const svc = new VoiceService();
    svc.setPrefs({ saveQuickAsks: true });

    await runQuickAsk(svc);
    svc.playbackDone(audioEvts()[0].generation);
    await runQuickAsk(svc);

    const rows = h.db.select().from(schema.contributions).all();
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe(h.sttResult);
    expect(rows[0].kind).toBe('answer');
    const sessions = h.db.select().from(schema.sessions).all();
    expect(sessions.filter((s) => s.mode === 'companion')).toHaveLength(1);
    expect(rows[0].sessionId).toBe(rows[1].sessionId);
  });

  it('grounds in the configured quick-ask Space', async () => {
    const profileId = addProfile();
    h.db
      .insert(schema.contextPacks)
      .values({ id: 'pack-vx', profileId, kind: 'job', title: 'Acme' })
      .run();
    const svc = new VoiceService();
    svc.setPrefs({ quickAskPackId: 'pack-vx' });
    await runQuickAsk(svc);
    // The context patch surfaces the retrieved grounding on the card.
    const patches = evts('contribution:patch').map((e) => e.payload as { context?: { chunks: unknown[] } });
    expect(patches.some((p) => p.context && p.context.chunks.length > 0)).toBe(true);
    expect(svc.state).toBe('speaking');
  });
});

describe('speech fallbacks (never speak when it should not / cannot)', () => {
  it('muted → no synthesis at all, reply resolves text-only', async () => {
    addProfile();
    const svc = new VoiceService();
    svc.setPrefs({ muted: true });
    await runQuickAsk(svc);
    expect(h.speakCalls).toHaveLength(0);
    expect(audioEvts()).toHaveLength(0);
    expect(svc.state).toBe('idle');
    expect(states().some((s) => s.textOnly)).toBe(true);
    // The text still streamed to the Cue Card.
    expect(evts('contribution:done')).toHaveLength(1);
  });

  it('synthesis failure → text-only fallback, no crash, no audio', async () => {
    addProfile();
    h.speakFail = true;
    const svc = new VoiceService();
    await runQuickAsk(svc);
    expect(audioEvts()).toHaveLength(0);
    expect(svc.state).toBe('idle');
    expect(states().some((s) => s.textOnly)).toBe(true);
  });

  it('never speaks an unsummoned contribution', async () => {
    addProfile();
    const svc = new VoiceService();
    expect(svc.state).toBe('idle');
    // An ambient-style delta flows through the bridge while voice is idle.
    emitGenericDelta('ambient-card-1', 'A meeting card body. Definitely a sentence.');
    await flush(5);
    expect(h.speakCalls).toHaveLength(0);
    expect(audioEvts()).toHaveLength(0);
    expect(svc.state).toBe('idle');
  });
});

describe('barge-in and stale audio', () => {
  it('interrupt while speaking bumps the generation and drops late synthesis', async () => {
    addProfile();
    h.speakGated = true;
    const svc = new VoiceService();

    svc.summon();
    feedSpeech(svc);
    await svc.commit();
    await flush();

    // First sentence is mid-synthesis (gated). Release it → speaking + segment.
    expect(h.speakGates.length).toBeGreaterThan(0);
    h.speakGates.shift()!();
    await flush();
    expect(svc.state).toBe('speaking');
    const g1 = audioEvts()[0].generation;
    expect(audioEvts()).toHaveLength(1);

    // BARGE-IN: the user talks over BrainCue.
    svc.interrupt();
    expect(svc.state).toBe('listening');
    expect(lastState().generation).toBeGreaterThan(g1);

    // The second sentence's synthesis finishes AFTER the interrupt — stale:
    // it must never be broadcast.
    while (h.speakGates.length) h.speakGates.shift()!();
    await flush();
    expect(audioEvts()).toHaveLength(1); // still only the pre-interrupt segment
    expect(svc.state).toBe('listening');
  });

  it('cancel works from every stage and stops the turn', async () => {
    addProfile();
    const svc = new VoiceService();
    svc.summon();
    expect(svc.state).toBe('listening');
    svc.cancel();
    expect(svc.state).toBe('idle');

    // From thinking (transcription in flight).
    svc.summon();
    feedSpeech(svc);
    const commit = svc.commit();
    svc.cancel();
    await commit;
    await flush();
    expect(svc.state).toBe('idle');
    // The stale transcription result must not have routed anywhere.
    expect(evts('contribution:open')).toHaveLength(0);
  });
});

describe('capture edge cases', () => {
  it('a tap with no speech fails soft ("did not hear")', async () => {
    addProfile();
    const svc = new VoiceService();
    svc.summon();
    await svc.commit(); // nothing buffered
    expect(svc.state).toBe('error');
    expect(h.sttCalls).toHaveLength(0);
  });

  it('empty transcription fails soft without routing', async () => {
    addProfile();
    h.sttResult = '';
    const svc = new VoiceService();
    await runQuickAsk(svc);
    expect(svc.state).toBe('error');
    expect(evts('contribution:open')).toHaveLength(0);
  });

  it('audio outside the listening state is dropped, and pause silences voice', async () => {
    addProfile();
    const svc = new VoiceService();
    svc.feedAudio(new ArrayBuffer(8192)); // idle: dropped
    svc.summon();
    svc.syncSessionPaused(true);
    expect(svc.state).toBe('paused');
    svc.feedAudio(new ArrayBuffer(8192)); // paused: dropped
    await svc.commit(); // paused: no-op
    expect(h.sttCalls).toHaveLength(0);
    svc.syncSessionPaused(false);
    expect(svc.state).toBe('idle');
  });
});

describe('in-session summon', () => {
  it('routes through the engine direct-ask pipeline and speaks the answer', async () => {
    const profileId = addProfile();
    const session = engine.start(profileId, 'general');
    const svc = new VoiceService();

    await runQuickAsk(svc); // with a live session this is a summon, not a quick ask

    // The ENGINE answered: a real detected-question row exists (v1 semantics)…
    const questions = h.db.select().from(schema.detectedQuestions).all();
    expect(questions.filter((q) => q.sessionId === session.id)).toHaveLength(1);
    expect(questions[0].text).toBe(h.sttResult);
    // …and the events are the DUAL-emitted pipeline events, not generic-only.
    expect(evts('session:question-detected')).toHaveLength(1);

    // The summoned reply was followed via the bridge tap and spoken.
    expect(h.speakCalls.length).toBeGreaterThan(0);
    expect(svc.state).toBe('speaking');
    svc.playbackDone(audioEvts()[0].generation);
    expect(svc.state).toBe('idle');
  });
});

describe('hygiene', () => {
  it('raw audio and synthesized base64 never reach the logs', async () => {
    addProfile();
    const svc = new VoiceService();
    await runQuickAsk(svc);
    const spoken = audioEvts()
      .map((a) => a.audioBase64)
      .filter(Boolean);
    expect(spoken.length).toBeGreaterThan(0);
    const logDump = JSON.stringify(h.logCalls);
    for (const b64 of spoken) expect(logDump).not.toContain(b64);
    expect(logDump).not.toContain('RIFF');
  });
});
