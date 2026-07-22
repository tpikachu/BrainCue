import { api } from '../../lib/api';
import { noDrag } from '../lib/style';
import type { VoicePrefs, VoiceStateEvent } from '@shared/types';

/** One-line status + action per dialogue state. */
function statusFor(v: VoiceStateEvent): { text: string; tone: string } {
  switch (v.state) {
    case 'listening':
      return { text: 'Listening… tap to send', tone: 'text-red-300' };
    case 'thinking':
      return {
        text: v.transcript ? `Heard: “${v.transcript}”` : 'Thinking…',
        tone: 'text-indigo-300',
      };
    case 'speaking':
      return { text: 'Speaking — talk or tap to interrupt', tone: 'text-green-300' };
    case 'interrupted':
      return { text: 'Interrupted', tone: 'text-amber-300' };
    case 'paused':
      return { text: 'Voice paused with the session', tone: 'text-neutral-500' };
    case 'error':
      return { text: v.error ?? 'Voice error', tone: 'text-amber-300' };
    default:
      return { text: '', tone: 'text-neutral-500' };
  }
}

/**
 * The Cue Card's voice controls: push-to-talk button (same semantics as the
 * global shortcut — listen / send / interrupt), cancel at every stage, and the
 * hard mute. Rendered whenever the voice layer is enabled — with no session
 * live, a summon becomes a quick ask over the default Space.
 */
export function VoiceBar(props: {
  voice: VoiceStateEvent;
  prefs: VoicePrefs | null;
  level: number;
  onToggleMute: () => void;
}) {
  const { voice, prefs } = props;
  const busy = voice.state !== 'idle' && voice.state !== 'paused';
  const status = statusFor(voice);
  const muted = prefs?.muted ?? false;

  return (
    <div
      data-ct-interactive
      className="mt-2 flex shrink-0 items-center gap-1.5 text-[11px]"
      style={noDrag}
      aria-label="Voice controls"
    >
      <button
        onClick={() => void api.voice.summon()}
        disabled={voice.state === 'paused'}
        title="Talk to BrainCue (push-to-talk)"
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors ${
          voice.state === 'listening'
            ? 'bg-red-600 text-white hover:bg-red-500'
            : voice.state === 'speaking'
              ? 'bg-green-700 text-white hover:bg-green-600'
              : 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40'
        }`}
      >
        {voice.state === 'listening' && (
          <span
            className="inline-block h-2 w-2 rounded-full bg-white"
            style={{ opacity: 0.4 + Math.min(0.6, props.level * 8) }}
          />
        )}
        {voice.state === 'listening' ? 'Send' : voice.state === 'speaking' ? 'Interrupt' : '🎙 Talk'}
      </button>

      <span className={`min-w-0 flex-1 truncate ${status.tone}`}>
        {status.text ||
          (voice.textOnly ? 'Voice unavailable — showed text only.' : 'Ask by voice, from anywhere.')}
      </span>

      {busy && (
        <button
          onClick={() => void api.voice.cancel()}
          title="Cancel"
          className="rounded-md bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700"
        >
          ✕
        </button>
      )}
      <button
        onClick={props.onToggleMute}
        title={muted ? 'Unmute BrainCue’s voice' : 'Mute BrainCue’s voice (replies stay text)'}
        className={`rounded-md px-2 py-1 transition-colors ${
          muted ? 'bg-amber-900/50 text-amber-300' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
        }`}
      >
        {muted ? '🔇' : '🔊'}
      </button>
    </div>
  );
}
