import { floatTo16BitPCM, rms } from '../../lib/pcm';

/**
 * Push-to-talk microphone capture for the voice layer (module singleton, like
 * useLiveSession's). Frames are handed to the caller as PCM16 24 kHz mono —
 * what the STT expects — together with an RMS level for VAD/feedback. Echo
 * cancellation stays ON so BrainCue's own speech doesn't trip the barge-in
 * detector through the speakers.
 */

let ctx: AudioContext | null = null;
let node: ScriptProcessorNode | null = null;
let stream: MediaStream | null = null;

export function voiceCaptureActive(): boolean {
  return stream !== null;
}

export async function startVoiceCapture(
  onFrame: (pcm: ArrayBuffer, level: number) => void,
): Promise<void> {
  if (stream) return; // already capturing
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  ctx = new AudioContext({ sampleRate: 24000 });
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    onFrame(floatTo16BitPCM(input).buffer as ArrayBuffer, rms(input));
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
}

export function stopVoiceCapture(): void {
  if (node) node.onaudioprocess = null;
  node?.disconnect();
  node = null;
  void ctx?.close().catch(() => {});
  ctx = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}
