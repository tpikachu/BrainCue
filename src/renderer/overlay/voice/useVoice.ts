import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { VoicePrefs, VoiceStateEvent } from '@shared/types';
import { startVoiceCapture, stopVoiceCapture } from './voiceCapture';
import { VoicePlayer } from './voicePlayer';

// VAD thresholds (RMS). One frame ≈ 171 ms (4096 samples @ 24 kHz).
const SPEECH_ON = 0.02; // "the user is saying something" while listening
const SILENCE_COMMIT_MS = 1400; // pause after speech → auto-send
const BARGE_ON = 0.045; // louder bar while BrainCue speaks (its own audio is echo-cancelled, not gone)
const BARGE_FRAMES = 3; // ~0.5 s of sustained speech → barge-in

/**
 * The overlay's voice runtime: mirrors the main-process dialogue state, runs
 * the mic capture while a turn is active (frames stream to main ONLY in
 * `listening`), does the renderer-side VAD (silence auto-commit + barge-in),
 * and plays synthesized segments in order. All decisions of consequence live
 * in main — this hook is feedback and plumbing.
 */
export function useVoice(enabled: boolean) {
  const [voice, setVoice] = useState<VoiceStateEvent>({ state: 'idle', generation: 0 });
  const [prefs, setPrefs] = useState<VoicePrefs | null>(null);
  const [level, setLevel] = useState(0);

  const stateRef = useRef(voice);
  const player = useRef<VoicePlayer | null>(null);
  // Per-turn VAD trackers (reset on every listening entry).
  const heardSpeech = useRef(false);
  const lastVoiceAt = useRef(0);
  const committed = useRef(false);
  const bargeFrames = useRef(0);
  const barged = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    player.current = new VoicePlayer();
    void api.voice.getPrefs().then((p) => {
      setPrefs(p);
      void player.current?.setOutputDevice(p.outputDeviceId);
    });

    const offState = api.events.onVoiceState((p) => {
      const prev = stateRef.current;
      stateRef.current = p;
      setVoice(p);
      // Stale audio: any state change away from speaking (or a new generation)
      // silences whatever is queued or playing.
      if (p.state !== 'speaking' || p.generation !== prev.generation) player.current?.stop();
      if (p.state === 'listening') {
        heardSpeech.current = false;
        committed.current = false;
        lastVoiceAt.current = Date.now();
        void startVoiceCapture(onFrame).catch(() => {
          // Mic denied/unavailable — tell main so the turn fails visibly
          // instead of listening to nothing forever.
          void api.voice.cancel();
        });
      }
      if (p.state === 'speaking') {
        bargeFrames.current = 0;
        barged.current = false;
      }
      // The turn is over — release the microphone.
      if (p.state === 'idle' || p.state === 'error' || p.state === 'paused') {
        stopVoiceCapture();
        setLevel(0);
      }
    });
    const offAudio = api.events.onVoiceAudio((p) => player.current?.enqueue(p));

    const onFrame = (pcm: ArrayBuffer, frameLevel: number) => {
      const s = stateRef.current.state;
      setLevel(frameLevel);
      if (s === 'listening') {
        api.voice.sendAudio(pcm);
        if (frameLevel > SPEECH_ON) {
          heardSpeech.current = true;
          lastVoiceAt.current = Date.now();
        } else if (
          heardSpeech.current &&
          !committed.current &&
          Date.now() - lastVoiceAt.current > SILENCE_COMMIT_MS
        ) {
          committed.current = true;
          void api.voice.commit();
        }
      } else if (s === 'speaking' && !barged.current) {
        // Barge-in: sustained user speech interrupts BrainCue mid-sentence.
        bargeFrames.current = frameLevel > BARGE_ON ? bargeFrames.current + 1 : 0;
        if (bargeFrames.current >= BARGE_FRAMES) {
          barged.current = true;
          void api.voice.interrupt();
        }
      }
    };

    return () => {
      offState();
      offAudio();
      stopVoiceCapture();
      player.current?.stop();
      player.current = null;
    };
  }, [enabled]);

  const toggleMute = async () => {
    if (!prefs) return;
    const next = await api.voice.setPrefs({ muted: !prefs.muted });
    setPrefs(next);
  };

  const savePrefs = async (patch: Partial<VoicePrefs>) => {
    const next = await api.voice.setPrefs(patch);
    setPrefs(next);
    if (patch.outputDeviceId !== undefined) void player.current?.setOutputDevice(next.outputDeviceId);
  };

  return { voice, prefs, level, toggleMute, savePrefs };
}
