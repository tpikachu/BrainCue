import { create } from 'zustand';
import { api } from '../lib/api';
import { floatTo16BitPCM, rms } from '../lib/pcm';
import type { Session } from '@shared/types';
import type { SavePrompt } from '@shared/ipc';

export type AudioSource = 'mic' | 'system';

export interface Line {
  id: number;
  speaker: string;
  text: string;
}

/**
 * The live interview session lives HERE, not in the SessionPage component, so it
 * survives route changes — navigating away from Live Session no longer drops the
 * session or stops the microphone. Audio capture (AudioContext/stream/processor)
 * are module singletons; transcript/question events are subscribed once.
 */
interface LiveSessionState {
  session: Session | null;
  paused: boolean;
  transcript: Line[];
  interim: string;
  speaking: boolean;
  micError: string | null; // audio-capture failure (denied mic / no system audio)
  clearMicError: () => void;
  sessionError: string | null; // backend session failure (transcription socket, OpenAI)
  clearSessionError: () => void;
  stream: MediaStream | null; // exposed for the waveform
  pendingSave: SavePrompt | null; // a just-stopped session awaiting save/discard
  clearPendingSave: () => void;

  startNew: (a: {
    profileId: string;
    interviewType: string;
    answerFormat: string;
    jobId: string | null;
    source: AudioSource;
    micDeviceId?: string | null;
  }) => Promise<void>;
  resumeExisting: (a: {
    sessionId: string;
    source: AudioSource;
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
let ctx: AudioContext | null = null;
let node: ScriptProcessorNode | null = null;
let mediaStream: MediaStream | null = null;
let lineId = 0;

async function getStream(source: AudioSource, micDeviceId?: string | null): Promise<MediaStream> {
  if (source === 'system') {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    display.getVideoTracks().forEach((t) => t.stop());
    if (display.getAudioTracks().length === 0) {
      throw new Error('No system audio captured. Use Microphone, or check audio is playing.');
    }
    return display;
  }
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

export const useLiveSession = create<LiveSessionState>((set, get) => {
  // Subscribe ONCE (this initializer runs a single time for the app's lifetime).
  api.events.onTranscriptDelta((p) => {
    const d = p as { text: string; speaker: string; isFinal: boolean };
    if (d.isFinal) {
      set((s) => ({
        // Cap the backing array — a multi-hour interview would otherwise accumulate
        // thousands of line objects in memory (the UI only renders the last ~300).
        transcript: [...s.transcript, { id: lineId++, speaker: d.speaker, text: d.text }].slice(
          -MAX_TRANSCRIPT,
        ),
        interim: '',
      }));
    } else {
      set((s) => ({ interim: s.interim + d.text }));
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
      set({ session: null, paused: false, interim: '' });
    } else {
      set({ paused: s.paused });
    }
  });

  // Wire an already-acquired stream into the PCM pipeline. The stream is acquired
  // by the caller FIRST (see startNew/resumeExisting) so a denied mic or cancelled
  // system-audio picker never leaves a phantom "live" session with no audio.
  async function attachCapture(sessionId: string, stream: MediaStream): Promise<void> {
    try {
      mediaStream = stream;
      set({ stream, micError: null });

      ctx = new AudioContext({ sampleRate: 24000 });
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        set({ speaking: rms(input) > 0.012 });
        api.session.sendRealtimeAudio(sessionId, floatTo16BitPCM(input).buffer as ArrayBuffer);
      };
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
    } catch (e) {
      set({ micError: (e as Error).message });
    }
  }

  function stopCapture(): void {
    if (node) node.onaudioprocess = null;
    node?.disconnect();
    node = null;
    void ctx?.close().catch(() => {});
    ctx = null;
    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    set({ stream: null, speaking: false });
  }

  return {
    session: null,
    paused: false,
    transcript: [],
    interim: '',
    speaking: false,
    micError: null,
    clearMicError: () => set({ micError: null }),
    sessionError: null,
    clearSessionError: () => set({ sessionError: null }),
    stream: null,
    pendingSave: null,
    clearPendingSave: () => set({ pendingSave: null }),

    startNew: async ({ profileId, interviewType, answerFormat, jobId, source, micDeviceId }) => {
      // Acquire audio FIRST: if the user denies the mic or cancels the system-audio
      // picker, we never create a session that displays "live" with nothing flowing.
      let stream: MediaStream;
      try {
        stream = await getStream(source, micDeviceId);
      } catch (e) {
        set({ micError: (e as Error).message, sessionError: null });
        return;
      }
      const s = (await api.session.start(
        profileId,
        interviewType,
        jobId,
        answerFormat,
      )) as Session;
      lineId = 0;
      set({ session: s, transcript: [], interim: '', paused: false, micError: null, sessionError: null });
      await attachCapture(s.id, stream);
    },

    resumeExisting: async ({ sessionId, source, micDeviceId, prior }) => {
      let stream: MediaStream;
      try {
        stream = await getStream(source, micDeviceId);
      } catch (e) {
        set({ micError: (e as Error).message, sessionError: null });
        return;
      }
      const s = (await api.session.resume(sessionId)) as Session;
      lineId = prior.length;
      set({ session: s, transcript: prior, interim: '', paused: false, micError: null, sessionError: null });
      await attachCapture(s.id, stream);
    },

    stop: async () => {
      const s = get().session;
      if (!s) return;
      stopCapture();
      await api.session.stop(s.id);
      set({ session: null, interim: '' });
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
