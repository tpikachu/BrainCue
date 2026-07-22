import { FLAGS } from '@shared/flags';
import { EVENTS } from '@shared/ipc';
import { db, schema } from '../../db';
import { and, eq } from 'drizzle-orm';
import { broadcast } from '../../ipc/broadcast';
import {
  bridgeTap,
  emitGenericContext,
  emitGenericDelta,
  emitGenericDone,
  emitGenericOpen,
  type BridgeOpen,
} from '../../ipc/contributionBridge';
import { providerFor } from '../../providers/registry';
import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { contextPacksRepo } from '../../db/repositories/jobs.repo';
import { engine } from '../engine/engine';
import { enginePersistence } from '../engine/persistence/enginePersistence';
import { ground } from '../engine/grounding';
import { recallMemories } from '../memory/recall';
import { showOverlay } from '../../windows/overlayWindow';
import { log } from '../security/logger';
import { DialogueController, type VoiceFsmEvent } from './dialogueController';
import { SentenceStream } from './sentenceStream';
import { pcm16ToWav } from './wav';
import { streamQuickAnswer } from './quickAnswer';
import type { VoicePrefs, VoiceStateEvent } from '@shared/types';

/** Ignore a capture shorter than this (~0.25 s of PCM16 @ 24 kHz): the user
 *  tapped the key without saying anything. */
const MIN_AUDIO_BYTES = 12_000;
/** Hard capture ceiling (~120 s) — auto-commit rather than buffer forever. */
const MAX_AUDIO_BYTES = 24_000 * 2 * 120;
/** Give up on a summoned contribution that never opens (engine wedged). */
const OPEN_TIMEOUT_MS = 20_000;
/** Auto-clear the error state so the pill doesn't stick around. */
const ERROR_RESET_MS = 4_000;

const DEFAULT_PREFS: VoicePrefs = {
  voice: 'alloy',
  muted: false,
  outputDeviceId: null,
  saveQuickAsks: false,
  quickAskPackId: null,
};

/**
 * The voice/summon orchestrator: owns the dialogue controller (the explicit
 * state machine), the push-to-talk audio buffer, STT, and the sentence-chunked
 * TTS pipeline. Voice is an OUTPUT SURFACE: with a live session the summon is
 * a normal direct ask (the engine generates and persists exactly as if typed
 * into the Ask box) and this service only follows the stream via the bridge
 * tap; with no session it runs a quick ask over the default Space. All
 * synthesis/transcription happens in main — the API key and raw audio never
 * reach a renderer beyond the played segments. NOTHING here is ever spoken
 * unprompted: only summoned replies reach TTS (ambient cards are text-only by
 * construction), and the hard mute wins over everything.
 */
export class VoiceService {
  private controller = new DialogueController((t) => {
    // Every applied transition is published — the renderer mirrors this state
    // for the listening/thinking/speaking feedback and stale-audio dropping.
    this.publish(t.to);
  });
  /** Per-turn annotations merged into the published state events. */
  private extra: Pick<VoiceStateEvent, 'transcript' | 'contributionId' | 'textOnly' | 'error'> = {};
  /** PCM16 frames buffered while listening. Never logged, cleared eagerly. */
  private frames: Buffer[] = [];
  private framesBytes = 0;
  /** Cleanups for the CURRENT turn (tap listeners, timeouts, aborts). */
  private turnCleanups: (() => void)[] = [];
  private quickAbort: AbortController | null = null;

  get state() {
    return this.controller.current;
  }

  // --- prefs -----------------------------------------------------------------

  getPrefs(): VoicePrefs {
    return { ...DEFAULT_PREFS, ...settingsRepo.getJson<Partial<VoicePrefs>>(SETTINGS_KEYS.voicePrefs, {}) };
  }

  setPrefs(patch: Partial<VoicePrefs>): VoicePrefs {
    const next = { ...this.getPrefs(), ...patch };
    settingsRepo.setJson(SETTINGS_KEYS.voicePrefs, next);
    // Muting is also a control action: if BrainCue is mid-sentence, stop now.
    if (patch.muted === true && this.controller.current === 'speaking') this.cancel();
    return next;
  }

  // --- controls (hotkey / Cue Card buttons / IPC) ----------------------------

  /** The push-to-talk press. One key, state-dependent: start listening, send,
   *  or barge-in. Safe to call from anywhere at any time. */
  summon(): { state: string } {
    if (!FLAGS.voice) return { state: this.controller.current };
    switch (this.controller.current) {
      case 'speaking':
        this.interrupt();
        break;
      case 'listening':
        void this.commit();
        break;
      case 'thinking': {
        // Press during thinking = abandon that turn and listen again.
        this.abortTurn();
        this.apply('SUMMON');
        this.beginListening();
        break;
      }
      case 'paused':
        break; // hard pause wins — never start capture from a paused state
      default: {
        // idle / error / interrupted → a fresh turn
        this.apply('SUMMON');
        this.beginListening();
      }
    }
    return { state: this.controller.current };
  }

  /** Abandon the current turn at ANY stage. */
  cancel(): { state: string } {
    if (this.controller.current !== 'idle') {
      this.abortTurn();
      this.apply('CANCEL');
    }
    return { state: this.controller.current };
  }

  /** Barge-in: the user spoke (or pressed) while BrainCue was speaking —
   *  stop the audio and listen to them instead. */
  interrupt(): { state: string } {
    if (this.controller.current === 'speaking') {
      this.abortTurn();
      this.apply('INTERRUPT'); // speaking → interrupted (generation bump kills queued audio)
      this.apply('SUMMON'); // interrupted → listening
      this.beginListening();
    }
    return { state: this.controller.current };
  }

  /** PCM16 frames streamed from the renderer while listening. Anything outside
   *  the listening state is dropped (never buffered, never logged). */
  feedAudio(pcm: ArrayBuffer): void {
    if (this.controller.current !== 'listening') return;
    const buf = Buffer.from(pcm);
    this.frames.push(buf);
    this.framesBytes += buf.length;
    if (this.framesBytes >= MAX_AUDIO_BYTES) void this.commit();
  }

  /** End of capture (renderer silence-VAD, explicit send, or the buffer cap):
   *  transcribe and route the question. */
  async commit(): Promise<void> {
    if (this.controller.current !== 'listening') return;
    const frames = this.frames;
    const bytes = this.framesBytes;
    this.frames = [];
    this.framesBytes = 0;
    this.apply('COMMIT');
    const gen = this.controller.turn;

    if (bytes < MIN_AUDIO_BYTES) {
      this.fail("I didn't hear anything.");
      return;
    }

    let text = '';
    try {
      const wav = pcm16ToWav(frames);
      const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
      text = (await providerFor('batchStt').transcribe(ab, 'audio/wav')).trim();
    } catch (e) {
      if (this.stale(gen)) return;
      log.warn('voice: transcription failed', (e as Error)?.message ?? 'unknown');
      this.fail('Transcription failed.');
      return;
    }
    if (this.stale(gen)) return; // canceled/superseded while transcribing
    if (!text) {
      this.fail("I didn't catch that.");
      return;
    }

    this.extra.transcript = text;
    this.publish('thinking'); // same state, now with the heard transcript

    const live = engine.activeInfo();
    if (live) this.summonLive(text, gen);
    else void this.quickAsk(text, gen);
  }

  /** Renderer finished playing the reply's final segment. */
  playbackDone(generation: number): void {
    if (generation !== this.controller.turn) return;
    this.apply('PLAYBACK_DONE');
  }

  /** The engine session was hard-paused/resumed — voice follows (a paused
   *  copilot must not keep listening or talking). */
  syncSessionPaused(paused: boolean): void {
    if (paused) {
      if (this.controller.current !== 'idle' && this.controller.current !== 'paused') this.abortTurn();
      this.apply('PAUSE');
    } else if (this.controller.current === 'paused') {
      this.apply('RESUME');
    }
  }

  // --- turn internals --------------------------------------------------------

  private apply(ev: VoiceFsmEvent): void {
    this.controller.apply(ev);
  }

  private stale(gen: number): boolean {
    return gen !== this.controller.turn;
  }

  private publish(state: VoiceStateEvent['state']): void {
    broadcast(EVENTS.voiceState, {
      state,
      generation: this.controller.turn,
      ...this.extra,
    } satisfies VoiceStateEvent);
  }

  private fail(message: string): void {
    const prev = this.extra;
    this.extra = { error: message };
    if (!this.controller.apply('FAIL')) {
      // FAIL isn't valid from here (e.g. the turn already resolved to idle) —
      // don't leave a dangling error annotation.
      this.extra = prev;
      return;
    }
    const gen = this.controller.turn;
    // Clear the error pill automatically; a SUMMON meanwhile supersedes this.
    setTimeout(() => {
      if (!this.stale(gen) && this.controller.current === 'error') this.apply('RESET');
    }, ERROR_RESET_MS);
  }

  private beginListening(): void {
    this.extra = {};
    this.frames = [];
    this.framesBytes = 0;
    showOverlay(); // immediate visible feedback wherever the user summoned from
  }

  /** Cancel everything the current turn has in flight. The generation bump
   *  (applied by the CALLER's next transition) is what makes async stragglers
   *  drop themselves — this just releases resources eagerly. */
  private abortTurn(): void {
    for (const fn of this.turnCleanups.splice(0)) fn();
    this.quickAbort?.abort();
    this.quickAbort = null;
    this.frames = [];
    this.framesBytes = 0;
    this.extra = {};
  }

  /** In-session summon: route through the engine's normal direct-ask pipeline
   *  (identical persistence/broadcast semantics to the Ask box) and FOLLOW the
   *  resulting contribution via the bridge tap for speech. */
  private summonLive(text: string, gen: number): void {
    const pipeline = this.makeSpeechPipeline(gen);
    let contributionId: string | null = null;

    const onOpen = (p: BridgeOpen) => {
      // Correlate by title: the direct ask's contribution opens with the asked
      // text as its title. First match wins; ambient cards title differently.
      if (contributionId === null && p.title === text) {
        contributionId = p.contributionId;
        this.extra.contributionId = p.contributionId;
        clearTimeout(timer);
      }
    };
    const onDelta = (p: { contributionId: string; token: string }) => {
      if (p.contributionId === contributionId) pipeline.push(p.token);
    };
    const onDone = (p: { contributionId: string }) => {
      if (p.contributionId !== contributionId) return;
      cleanup();
      pipeline.finish();
    };
    const cleanup = () => {
      bridgeTap.off('open', onOpen);
      bridgeTap.off('delta', onDelta);
      bridgeTap.off('done', onDone);
      clearTimeout(timer);
    };
    bridgeTap.on('open', onOpen);
    bridgeTap.on('delta', onDelta);
    bridgeTap.on('done', onDone);
    const timer = setTimeout(() => {
      cleanup();
      if (!this.stale(gen)) this.fail('The answer never started.');
    }, OPEN_TIMEOUT_MS);
    this.turnCleanups.push(cleanup);

    void engine
      .askActive(text)
      .then((r) => {
        // The session died between routing and asking — nothing will open.
        if (!r.ok && contributionId === null && !this.stale(gen)) {
          cleanup();
          this.fail('No live session to ask.');
        }
      })
      .catch((e) => {
        cleanup();
        if (this.stale(gen)) return;
        log.warn('voice: summoned ask failed', (e as Error)?.message ?? 'unknown');
        this.fail('The answer failed.');
      });
  }

  /** No-session quick ask: grounded in the default Space (prefs), streamed as
   *  a GENERIC-ONLY contribution to the Cue Card, persisted only when the user
   *  opted in (prefs.saveQuickAsks → a per-profile 'companion' session). */
  private async quickAsk(text: string, gen: number): Promise<void> {
    const prefs = this.getPrefs();
    const pack = prefs.quickAskPackId ? contextPacksRepo.get(prefs.quickAskPackId) : null;
    const profileId = pack?.profileId ?? profilesRepo.list()[0]?.id ?? null;
    if (!profileId) {
      this.fail('Create a profile first — quick ask grounds in your documents.');
      return;
    }
    const packId = pack?.id ?? null;
    const contributionId = crypto.randomUUID();
    this.extra.contributionId = contributionId;
    const pipeline = this.makeSpeechPipeline(gen);
    const abort = new AbortController();
    this.quickAbort = abort;

    emitGenericOpen({ contributionId, kind: 'answer', title: text });
    let body = '';
    try {
      const chunks = await ground(profileId, text, packId);
      const memories = await recallMemories(profileId, text, packId);
      if (this.stale(gen)) {
        emitGenericDone(contributionId); // stop the card's streaming cursor
        return;
      }
      emitGenericContext(contributionId, {
        questionId: contributionId,
        question: text,
        chunks,
        ...(memories.length ? { memories } : {}),
      });
      for await (const ev of streamQuickAnswer({
        question: text,
        contextChunks: chunks,
        memories,
        signal: abort.signal,
      })) {
        if (this.stale(gen)) {
          emitGenericDone(contributionId);
          return;
        }
        if (ev.type === 'delta') {
          body += ev.token;
          emitGenericDelta(contributionId, ev.token);
          pipeline.push(ev.token);
        }
      }
      emitGenericDone(contributionId);
      pipeline.finish();
      // Persist ONLY per user settings — quick asks are ephemeral by default.
      if (prefs.saveQuickAsks && body) {
        enginePersistence.insertContribution({
          sessionId: this.quickAskSession(profileId, packId),
          kind: 'answer',
          title: text,
          body,
          meta: { source: 'voice_quick_ask' },
          sourceRefs: [
            ...chunks.map((c) => ({ type: 'chunk', id: c.id })),
            ...memories.map((m) => ({ type: 'memory', id: m.id })),
          ],
        });
      }
    } catch (e) {
      if (this.stale(gen) || abort.signal.aborted) {
        emitGenericDone(contributionId); // stop the card's streaming cursor
        return;
      }
      log.warn('voice: quick ask failed', (e as Error)?.message ?? 'unknown');
      emitGenericDone(contributionId);
      this.fail('The answer failed.');
    } finally {
      if (this.quickAbort === abort) this.quickAbort = null;
    }
  }

  /** The reused per-profile session row that saved quick asks land in (the
   *  contributions table needs a session FK; one 'companion' row per profile
   *  keeps Sessions tidy instead of one row per ask). */
  private quickAskSession(profileId: string, packId: string | null): string {
    const existing = db()
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.profileId, profileId), eq(schema.sessions.mode, 'companion')))
      .get();
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    db()
      .insert(schema.sessions)
      .values({
        id,
        profileId,
        packId,
        mode: 'companion',
        kind: 'live',
        interviewType: 'general',
        status: 'stopped',
        startedAt: Date.now(),
        endedAt: Date.now(),
      })
      .run();
    return id;
  }

  /** Sentence-chunked TTS over the one-shot speech capability: sentences are
   *  synthesized as the text streams and play in order, so speech starts on
   *  the first sentence. Every async hop re-checks the generation — a stale
   *  segment (barge-in/cancel happened meanwhile) is dropped, never played.
   *  Muted or no speech capability → the reply stays text-only (TEXT_DONE). */
  private makeSpeechPipeline(gen: number) {
    const prefs = this.getPrefs();
    const sentences = new SentenceStream();
    let chain: Promise<void> = Promise.resolve();
    let seq = 0;
    let sent = 0;
    let failed = false;
    const speech = (() => {
      if (prefs.muted) return null;
      try {
        return providerFor('speech');
      } catch {
        return null; // provider has no speech capability → text fallback
      }
    })();

    const synth = (sentence: string) => {
      chain = chain.then(async () => {
        if (this.stale(gen) || failed || !speech) return;
        try {
          const audio = await speech.speak(sentence, prefs.voice);
          if (this.stale(gen)) return; // superseded during synthesis — drop, never play
          if (sent === 0) {
            // First audible segment: thinking → speaking. If the machine moved
            // on (canceled), the transition is invalid and we drop the audio.
            if (!this.controller.apply('SPEAK')) return;
          }
          sent += 1;
          broadcast(
            EVENTS.voiceAudio,
            {
              generation: gen,
              seq: seq++,
              audioBase64: audio.toString('base64'),
              mime: 'audio/mpeg',
              last: false,
            },
            ['overlay'],
          );
        } catch (e) {
          failed = true; // one failure → stop synthesizing; the text is already on screen
          log.warn('voice: speech synthesis failed — reply stays text-only', (e as Error)?.message ?? 'unknown');
        }
      });
    };

    return {
      push: (token: string) => {
        for (const s of sentences.push(token)) synth(s);
      },
      finish: () => {
        const rest = sentences.flush();
        if (rest) synth(rest);
        chain = chain.then(() => {
          if (this.stale(gen)) return;
          if (sent > 0) {
            // Empty end-marker: tells the player which segment was last (it
            // reports playbackDone once the queue drains past it).
            broadcast(
              EVENTS.voiceAudio,
              { generation: gen, seq: seq++, audioBase64: '', mime: 'audio/mpeg', last: true },
              ['overlay'],
            );
          } else if (this.controller.current === 'thinking') {
            // Nothing was (or could be) spoken — the reply is text-only.
            this.extra.textOnly = true;
            this.apply('TEXT_DONE');
          }
        });
      },
    };
  }
}

export const voiceService = new VoiceService();
