import { create } from 'zustand';
import { api } from '../lib/api';
import { floatTo16BitPCM, rms } from '../lib/pcm';
import { resolveCapture, type Attempt } from '../lib/captureStreams';
import type { AudioSource, Presence, RollbackResult, Session } from '@shared/types';
import type { SavePrompt } from '@shared/ipc';
import { rollbackMessage } from '../lib/rollbackCopy';

export type { AudioSource };

/** What a start/resume actually achieved. It succeeds only once the session
 *  exists AND its audio pipeline is attached; anything less is a failure the
 *  caller must show (the start modal stays open), never a normal return that
 *  looks like success. `stage` says where it failed. */
export type StartResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      stage: 'capture' | 'start' | 'audio';
      error: string;
      /** `audio` stage only: the rollback could not be confirmed — the session
       *  may still be live in main and stays in the store, so Stop retries it. */
      cleanup?: 'failed';
    };

export interface Line {
  id: number;
  speaker: string;
  text: string;
}

/**
 * The live session lives HERE, not in a page component, so it survives route
 * changes — navigating away from the session no longer drops it or stops the
 * audio. Audio capture (AudioContext/streams/processors) are module
 * singletons; transcript/question events are subscribed once.
 *
 * A session hears BOTH the call (system loopback) and the user's microphone
 * (shared/activities.ts `capturePlan`); each stream is pumped separately to
 * main tagged with its source, where each has its own transcriber. Solo
 * activities (`listensTo: 'mic'`) open the microphone alone.
 */
interface LiveSessionState {
  session: Session | null;
  paused: boolean;
  transcript: Line[];
  interim: string;
  /** In-flight partial per speaker (the call's and the user's own). */
  interims: Record<string, string>;
  speaking: boolean;
  /** Audio-capture failure (nothing could be captured → no session), or a
   *  non-fatal notice that ONE of the two streams is missing (session runs). */
  micError: string | null;
  clearMicError: () => void;
  sessionError: string | null; // backend session failure (transcription socket, OpenAI)
  clearSessionError: () => void;
  stream: MediaStream | null; // the primary stream, exposed for the waveform
  pendingSave: SavePrompt | null; // a just-stopped session awaiting save/discard
  clearPendingSave: () => void;

  startNew: (a: {
    profileId: string;
    /** Interview/practice only. Ambient modes leave it unset — there is no
     *  "interview type" in a standup, and passing one told the answer prompt
     *  to behave as if there were. The column keeps its 'general' default. */
    interviewType?: string;
    answerFormat: string;
    jobId: string | null;
    /** What the session hears (the activity's `listensTo`): `'system'` = the
     *  call AND the microphone, `'mic'` = the microphone alone. Default: a call. */
    listensTo?: 'system' | 'mic';
    micDeviceId?: string | null;
    /** What this call IS (shared/activities.ts) — the ONE thing the user picks.
     *  The engine derives the mode from it; the renderer never sends one. */
    activity?: string;
    /** Ambient presence for meeting sessions (default: the mode's own). */
    presence?: string;
    /** Companion posture (off/on_demand/assistive/proactive) — companion only. */
    companionPresence?: string;
    /** Hard session budget in cents — companion cost governance. */
    budgetCents?: number | null;
  }) => Promise<StartResult>;
  resumeExisting: (a: {
    sessionId: string;
    listensTo?: 'system' | 'mic';
    micDeviceId?: string | null;
    prior: Line[];
  }) => Promise<StartResult>;
  stop: () => Promise<void>;
  togglePause: () => void;
  ask: (question: string) => Promise<void>;
}

// Cap the in-memory transcript so a long session can't grow it without bound.
const MAX_TRANSCRIPT = 500;

// --- audio capture singletons (outside React) ---
interface Pump {
  source: AudioSource;
  stream: MediaStream;
  node: ScriptProcessorNode;
}
let ctx: AudioContext | null = null;
let pumps: Pump[] = [];
let lineId = 0;
/** A failed start whose rollback could not be confirmed. The session stays
 *  in the store (visibly live), and Stop retries the SAME rollback — stop,
 *  then delete when it was new — instead of a plain stop. Main holds the same
 *  rollback (engine.rollback), so the Cue Card's Stop follows it too; this is
 *  the dashboard's view of it, settled by main's broadcast. */
let pendingRollback: { sessionId: string; discard: boolean } | null = null;
/** Latest RMS per stream — `speaking` follows whichever is louder. */
const levels: Record<AudioSource, number> = { system: 0, mic: 0 };
const SPEAKING_RMS = 0.012;

async function getSystemStream(): Promise<MediaStream> {
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  display.getVideoTracks().forEach((t) => t.stop());
  if (display.getAudioTracks().length === 0) {
    display.getTracks().forEach((t) => t.stop());
    throw new Error('No system audio captured — check that audio is playing.');
  }
  return display;
}

/** The microphone also hears the speakers, so echo cancellation and noise
 *  suppression stay ON: the call's voices are the other stream's job. */
async function getMicStream(micDeviceId?: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(micDeviceId ? { deviceId: { exact: micDeviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
}

const attempt = async (p: Promise<MediaStream>): Promise<Attempt<MediaStream>> => {
  try {
    return { ok: true, stream: await p };
  } catch (e) {
    return { ok: false, error: (e as Error).message || String(e) };
  }
};

/** Acquire every stream the activity wants. A refused system-audio picker or
 *  a denied microphone degrades to the other stream (see lib/captureStreams);
 *  with neither this throws and no session is created. */
async function acquire(
  listensTo: 'system' | 'mic',
  micDeviceId?: string | null,
): Promise<ReturnType<typeof resolveCapture<MediaStream>>> {
  const attempts: Partial<Record<AudioSource, Attempt<MediaStream>>> = {};
  if (listensTo === 'system') {
    // The picker is modal — take it first, then the (silent) mic prompt.
    attempts.system = await attempt(getSystemStream());
  }
  attempts.mic = await attempt(getMicStream(micDeviceId));
  try {
    return resolveCapture(listensTo, attempts);
  } catch (e) {
    for (const a of Object.values(attempts)) if (a.ok) a.stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
}

export const useLiveSession = create<LiveSessionState>((set, get) => {
  // Subscribe ONCE (this initializer runs a single time for the app's lifetime).
  api.events.onTranscriptDelta((p) => {
    const d = p as { text: string; speaker: string; isFinal: boolean; clear?: boolean };
    const without = (m: Record<string, string>) => {
      const { [d.speaker]: _gone, ...rest } = m;
      return rest;
    };
    if (d.clear) {
      set((s) => ({ interims: without(s.interims), interim: '' }));
    } else if (d.isFinal) {
      set((s) => ({
        // Cap the backing array — a multi-hour interview would otherwise accumulate
        // thousands of line objects in memory (the UI only renders the last ~300).
        transcript: [...s.transcript, { id: lineId++, speaker: d.speaker, text: d.text }].slice(
          -MAX_TRANSCRIPT,
        ),
        interims: without(s.interims),
        interim: '',
      }));
    } else {
      set((s) => {
        const interims = { ...s.interims, [d.speaker]: (s.interims[d.speaker] ?? '') + d.text };
        // `interim` keeps the latest speaker's partial for existing readers.
        return { interims, interim: interims[d.speaker] };
      });
    }
  });
  api.events.onQuestionDetected((p) => {
    const d = p as { text: string };
    set((s) => ({
      transcript: [
        ...s.transcript,
        { id: lineId++, speaker: 'detected question', text: d.text },
      ].slice(-MAX_TRANSCRIPT),
    }));
  });
  // A failed start is never offered for saving — main does not prompt for a
  // rollback it holds. Should a prompt still arrive for a session this store
  // is rolling back (main never received the rollback, and something else
  // stopped it), it is not shown: the same rollback is completed instead.
  api.events.onSavePrompt((p) => {
    const sp = p as SavePrompt;
    if (pendingRollback?.sessionId === sp.sessionId) {
      const discard = pendingRollback.discard;
      void api.session
        .rollback(sp.sessionId, discard)
        .then((r) => settleRollback(r))
        .catch(() => {});
      return;
    }
    set({ pendingSave: sp });
  });
  // Whichever window pressed Stop on a failed start (the dashboard, or the
  // Cue Card via stopActive), main settles the SAME rollback and says so here.
  api.events.onSessionRollback?.((r) => {
    if (pendingRollback?.sessionId !== r.sessionId) return;
    settleRollback(r);
  });
  // Surface backend session failures (transcription socket dropped, OpenAI auth,
  // etc.) — otherwise the UI shows a happy "listening" state forever.
  api.events.onSessionError((p) =>
    set({ sessionError: (p as { message?: string }).message || 'Session error.' }),
  );
  api.events.onSessionState((p) => {
    const s = p as { status?: string; paused: boolean };
    // The session can be stopped from the Cue Card (stopActive), which bypasses
    // this store's stop(). React to the broadcast so the dashboard + mic tear
    // down too. stopCapture() is idempotent, so our own stop() calling both is fine.
    if (s.status === 'stopped') {
      stopCapture();
      set({ session: null, paused: false, interim: '', interims: {} });
    } else {
      set({ paused: s.paused });
    }
  });

  // Wire already-acquired streams into the PCM pipeline: one AudioContext, one
  // source → ScriptProcessor pump per stream, each frame sent to main tagged
  // with the stream it came from. The streams are acquired by the caller FIRST
  // (see startNew/resumeExisting) so a refused picker or a denied mic never
  // leaves a phantom "live" session with no audio.
  async function attachCapture(
    sessionId: string,
    capture: ReturnType<typeof resolveCapture<MediaStream>>,
    wantsSystem: boolean,
  ): Promise<void> {
    // THROWS on failure — begin() then releases the streams and stops the
    // session. (It used to swallow the error into a notice, leaving a session
    // marked live with no audio pipeline.) Capture status is reported only
    // once the pipeline is attached: a status sent before that claimed audio
    // that never flowed.
    const primary = capture.streams[capture.order[0]] ?? null;
    set({ stream: primary, micError: capture.notice });
    levels.system = 0;
    levels.mic = 0;

    ctx = new AudioContext({ sampleRate: 24000 });
    await ctx.resume();
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    for (const source of capture.order) {
      const stream = capture.streams[source]!;
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        levels[source] = rms(input);
        set({ speaking: Math.max(levels.system, levels.mic) > SPEAKING_RMS });
        api.session.sendRealtimeAudio(sessionId, floatTo16BitPCM(input).buffer as ArrayBuffer, source);
      };
      src.connect(node);
      node.connect(mute);
      pumps.push({ source, stream, node });
    }

    // Tell the Cue Card what is ACTUALLY flowing — and again if a track ends
    // mid-session (screen share stopped, mic unplugged). A track that already
    // ended during setup is not flowing.
    const flowing = (source: AudioSource) =>
      !!capture.streams[source]?.getAudioTracks().some((t) => t.readyState !== 'ended');
    const live = { system: flowing('system'), mic: flowing('mic') };
    if (!live.system && !live.mic) throw new Error('the audio stopped before the session could start');
    const report = () => void api.session.reportCapture({ ...live, wantsSystem }).catch(() => {});
    report();
    for (const source of capture.order) {
      for (const track of capture.streams[source]!.getAudioTracks()) {
        track.addEventListener('ended', () => {
          if (!pumps.length) return; // stopped on purpose
          live[source] = false;
          set({
            micError:
              source === 'system'
                ? 'The call audio stopped (screen share ended?) — questions can no longer be heard. Stop and start again to recapture.'
                : 'Your microphone stopped — your own answers are no longer transcribed.',
          });
          report();
        });
      }
    }
  }

  /** Release every acquired stream — also ones no pump was created for. */
  function releaseStreams(capture: ReturnType<typeof resolveCapture<MediaStream>>): void {
    for (const s of Object.values(capture.streams)) s?.getTracks().forEach((t) => t.stop());
  }

  /**
   * Open the session, then attach its audio — and undo BOTH on failure, so a
   * start never leaves a session marked live with nothing flowing, nor the
   * screen share / microphone held open. A brand-new session that never
   * heard anything is deleted (`discardOnFailure`); a resumed one keeps its
   * earlier content.
   */
  async function begin(
    capture: ReturnType<typeof resolveCapture<MediaStream>>,
    open: () => Promise<Session>,
    prior: Line[],
    wantsSystem: boolean,
    discardOnFailure: boolean,
  ): Promise<StartResult> {
    let s: Session;
    try {
      s = await open();
    } catch (e) {
      releaseStreams(capture);
      const error = (e as Error).message || String(e);
      // The pages that start sessions inline (Interview, Tailor) show this.
      set({ micError: null, sessionError: error });
      return { ok: false, stage: 'start', error };
    }
    lineId = prior.length;
    set({ session: s, transcript: prior, interim: '', interims: {}, paused: false, micError: null, sessionError: null });
    try {
      await attachCapture(s.id, capture, wantsSystem);
      if (pendingRollback?.sessionId === s.id) pendingRollback = null;
      return { ok: true, sessionId: s.id };
    } catch (e) {
      stopCapture();
      releaseStreams(capture);
      const reason = `Audio capture couldn't start (${(e as Error).message || String(e)}).`;
      const r = await rollback(s.id, discardOnFailure);
      const error = `${reason} ${r.message}`;
      if (!r.stopped) {
        // NOT confirmed: say so, keep the session in the store (it may still
        // be live in main), and let Stop retry this same rollback.
        set({ micError: error });
        return { ok: false, stage: 'audio', error, cleanup: 'failed' };
      }
      set({ session: null, transcript: [], micError: error });
      return { ok: false, stage: 'audio', error, ...(r.removed === false ? { cleanup: 'failed' as const } : {}) };
    }
  }

  /** Apply a settled rollback (this store's own call, or main's broadcast
   *  after the Cue Card's Stop): once stopped is confirmed nothing is pending,
   *  the live state clears, and the notice says exactly what was confirmed. */
  function settleRollback(r: RollbackResult): { stopped: boolean; removed?: boolean; message: string } {
    const message = rollbackMessage(r);
    if (r.stopped) {
      if (pendingRollback?.sessionId === r.sessionId) pendingRollback = null;
      if (get().session?.id === r.sessionId) {
        stopCapture();
        set({ session: null, transcript: [], interim: '', interims: {} });
      }
      set({ micError: message });
    }
    return { stopped: r.stopped, removed: r.removed, message };
  }

  /**
   * Undo a session created by a start whose audio never attached: stop it,
   * then (a new one) delete it — in main (engine.rollback), which holds the
   * rollback until it is confirmed, so the Cue Card's Stop follows the same
   * policy. Claims only what was CONFIRMED: a failed stop or delete is
   * reported, and the rollback stays pending so Stop can retry it.
   */
  async function rollback(
    sessionId: string,
    discard: boolean,
  ): Promise<{ stopped: boolean; removed?: boolean; message: string }> {
    pendingRollback = { sessionId, discard };
    let r: RollbackResult;
    try {
      r = await api.session.rollback(sessionId, discard);
    } catch (e) {
      r = { sessionId, stopped: false, error: (e as Error).message || String(e) };
    }
    if (!r.stopped) return { stopped: false, message: rollbackMessage(r) };
    return settleRollback(r);
  }

  function stopCapture(): void {
    for (const p of pumps) {
      p.node.onaudioprocess = null;
      p.node.disconnect();
      p.stream.getTracks().forEach((t) => t.stop());
    }
    pumps = [];
    void ctx?.close().catch(() => {});
    ctx = null;
    set({ stream: null, speaking: false });
  }

  return {
    session: null,
    paused: false,
    transcript: [],
    interim: '', interims: {},
    speaking: false,
    micError: null,
    clearMicError: () => set({ micError: null }),
    sessionError: null,
    clearSessionError: () => set({ sessionError: null }),
    stream: null,
    pendingSave: null,
    clearPendingSave: () => set({ pendingSave: null }),

    startNew: async ({
      profileId,
      interviewType,
      answerFormat,
      jobId,
      listensTo = 'system',
      micDeviceId,
      activity,
      presence,
      companionPresence,
      budgetCents,
    }) => {
      // Acquire audio FIRST: with nothing captured we never create a session
      // that displays "live" with nothing flowing. One missing stream is a
      // notice, not a failure.
      let capture: ReturnType<typeof resolveCapture<MediaStream>>;
      try {
        capture = await acquire(listensTo, micDeviceId);
      } catch (e) {
        const error = (e as Error).message || String(e);
        set({ micError: error, sessionError: null });
        return { ok: false, stage: 'capture', error };
      }
      return begin(
        capture,
        async () =>
          (await api.session.start(
            profileId,
            interviewType,
            jobId,
            answerFormat,
            activity,
            presence as Presence | undefined,
            budgetCents,
            companionPresence,
          )) as Session,
        [],
        listensTo === 'system',
        true,
      );
    },

    resumeExisting: async ({ sessionId, listensTo = 'system', micDeviceId, prior }) => {
      let capture: ReturnType<typeof resolveCapture<MediaStream>>;
      try {
        capture = await acquire(listensTo, micDeviceId);
      } catch (e) {
        const error = (e as Error).message || String(e);
        set({ micError: error, sessionError: null });
        return { ok: false, stage: 'capture', error };
      }
      return begin(capture, async () => (await api.session.resume(sessionId)) as Session, prior, listensTo === 'system', false);
    },

    stop: async () => {
      const s = get().session;
      if (!s) return;
      stopCapture();
      // A failed start whose rollback was not confirmed: Stop retries THAT
      // rollback (no save prompt for the failed attempt; a new session is
      // also removed), and says what it confirmed.
      if (pendingRollback?.sessionId === s.id) {
        const r = await rollback(s.id, pendingRollback.discard);
        if (!r.stopped) {
          set({ micError: r.message });
          throw new Error(r.message);
        }
        set({ session: null, transcript: [], interim: '', interims: {}, micError: r.removed === false ? r.message : null });
        return;
      }
      await api.session.stop(s.id);
      set({ session: null, interim: '', interims: {} });
    },

    togglePause: () => {
      const s = get().session;
      if (s) void api.session.togglePause(s.id);
    },

    ask: async (question) => {
      const s = get().session;
      if (!s || !question) return;
      // Show the asked question immediately + keep it even if the answer fails (the
      // failure surfaces via sessionError). Swallow the rejection so a failed ask
      // doesn't become an unhandled promise rejection.
      set((st) => ({
        transcript: [
          ...st.transcript,
          { id: lineId++, speaker: 'you (manual)', text: question },
        ].slice(-MAX_TRANSCRIPT),
      }));
      await api.session.ask(s.id, question).catch(() => {});
    },
  };
});
