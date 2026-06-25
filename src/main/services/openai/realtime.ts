import WebSocket from 'ws';
import { apiKeyStore } from '../security/apiKey';
import { model } from './models';
import { parseRealtimeEvent } from './realtimeEvents';
import { log } from '../security/logger';

export interface RealtimeCallbacks {
  onDelta: (text: string) => void; // partial transcript for the current turn
  onFinal: (text: string) => void; // finalized transcript for a turn
  onSpeechStart?: () => void;
  onSpeechStop?: () => void;
  onError?: (message: string) => void;
  onOpen?: () => void;
}

/**
 * Streaming speech-to-text via the OpenAI Realtime API (transcription intent).
 * The WebSocket is opened from the MAIN process with the API key (never the
 * renderer). Server-side VAD segments turns; we emit partial deltas live and a
 * precise finalized transcript per turn — much better latency/accuracy than
 * uploading audio chunks.
 */
export class RealtimeTranscriber {
  private ws: WebSocket | null = null;
  private ready = false;
  private closing = false;
  private errored = false; // a specific error was already surfaced this connection

  constructor(
    private cb: RealtimeCallbacks,
    private language = 'en',
  ) {}

  start(): void {
    const key = apiKeyStore.getDecrypted();
    if (!key) {
      this.cb.onError?.('No OpenAI API key configured.');
      return;
    }
    this.closing = false;
    this.errored = false;
    // GA Realtime API: the beta shape was retired (the `OpenAI-Beta: realtime=v1`
    // header + `transcription_session.update` event), which is why the server now
    // rejects beta connections with `beta_api_shape_disabled`.
    this.ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });

    this.ws.on('open', () => {
      // GA transcription-session config: nested under session.audio.input. The
      // server response event names (…input_audio_transcription.delta/.completed)
      // are unchanged, so the parser in realtimeEvents.ts still applies.
      this.send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: {
                model: model('transcription'),
                language: this.language,
              },
              // Server VAD finds turn boundaries; tuned for conversational speech.
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 600,
              },
              noise_reduction: { type: 'near_field' },
            },
          },
        },
      });
      this.ready = true;
      this.cb.onOpen?.();
      log.info('realtime: transcription session opened');
    });

    this.ws.on('message', (data) => this.handle(data.toString()));
    this.ws.on('error', (err) => {
      log.error('realtime: ws error', err.message);
      if (!this.closing) {
        this.errored = true;
        this.cb.onError?.(`Realtime transcription error: ${err.message}`);
      }
    });
    this.ws.on('close', (code, reason) => {
      this.ready = false;
      // An UNEXPECTED close would otherwise go unreported while the mic keeps streaming
      // into a dead socket — the interview silently goes deaf. But 'ws' fires 'error'
      // THEN 'close' for the same failure, so skip the generic message when a specific
      // error was already surfaced (don't clobber "expired key" with "disconnected").
      if (!this.closing) {
        log.warn(`realtime: ws closed (${code}) ${reason.toString()}`);
        if (!this.errored) {
          this.cb.onError?.('Transcription disconnected — stop and resume the interview to reconnect.');
        }
      }
    });
  }

  /** Append base64-encoded PCM16 (24kHz mono) audio. */
  appendAudio(base64Pcm: string): void {
    if (!this.ready) return;
    this.send({ type: 'input_audio_buffer.append', audio: base64Pcm });
  }

  stop(): void {
    this.closing = true;
    this.ready = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private handle(raw: string): void {
    const action = parseRealtimeEvent(raw);
    if (!action) return;
    switch (action.type) {
      case 'delta':
        this.cb.onDelta(action.text);
        break;
      case 'final':
        this.cb.onFinal(action.text);
        break;
      case 'speech-start':
        this.cb.onSpeechStart?.();
        break;
      case 'speech-stop':
        this.cb.onSpeechStop?.();
        break;
      case 'error':
        this.cb.onError?.(action.message);
        break;
    }
  }
}
