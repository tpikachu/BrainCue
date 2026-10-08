import { create } from 'zustand';
import { api } from '../lib/api';
import { floatTo16BitPCM, rms } from '../lib/pcm';
import { resolveCapture, type Attempt } from '../lib/captureStreams';
import type { AudioSource, Presence, Session } from '@shared/types';
import type { SavePrompt } from '@shared/ipc';

export type { AudioSource };

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
  }) => Promise<void>;
  resumeExisting: (a: {
    sessionId: string;
    listensTo?: 'system' | 'mic';
    micDeviceId?: string | null;
    prior: Line[];
  }) => Promise<void>;
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
  api.events.onSavePrompt((p) => set({ pendingSave: p }));
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
  ): Promise<void> {
    try {
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
    } catch (e) {
      set({ micError: (e as Error).message });
    }
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
        set({ micError: (e as Error).message, sessionError: null });
        return;
      }
      const s = (await api.session.start(
        profileId,
        interviewType,
        jobId,
        answerFormat,
        activity,
        presence as Presence | undefined,
        budgetCents,
        companionPresence,
      )) as Session;
      lineId = 0;
      set({ session: s, transcript: [], interim: '', interims: {}, paused: false, micError: null, sessionError: null });
      await attachCapture(s.id, capture);
    },

    resumeExisting: async ({ sessionId, listensTo = 'system', micDeviceId, prior }) => {
      let capture: ReturnType<typeof resolveCapture<MediaStream>>;
      try {
        capture = await acquire(listensTo, micDeviceId);
      } catch (e) {
        set({ micError: (e as Error).message, sessionError: null });
        return;
      }
      const s = (await api.session.resume(sessionId)) as Session;
      lineId = prior.length;
      set({ session: s, transcript: prior, interim: '', interims: {}, paused: false, micError: null, sessionError: null });
      await attachCapture(s.id, capture);
    },

    stop: async () => {
      const s = get().session;
      if (!s) return;
      stopCapture();
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
