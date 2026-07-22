import { api } from '../../lib/api';
import type { VoiceAudioEvent } from '@shared/types';

/**
 * Sequential playback of synthesized speech segments (one sentence each).
 * Segments arrive tagged with the turn generation: anything from a superseded
 * generation resets the queue (stale-audio cancellation), and once the final
 * marker's queue drains we report playbackDone so main can leave `speaking`.
 * Output-device selection goes through setSinkId where the platform supports
 * it (feature-detected; silently falls back to the default device).
 */
export class VoicePlayer {
  private audio = new Audio();
  private queue: string[] = []; // blob URLs in seq order (broadcast order)
  private generation = -1;
  private sawLast = false;
  private playing = false;

  async setOutputDevice(deviceId: string | null): Promise<void> {
    const el = this.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== 'function') return; // unsupported platform → default device
    try {
      await el.setSinkId(deviceId ?? '');
    } catch {
      /* device gone/denied → keep default */
    }
  }

  enqueue(ev: VoiceAudioEvent): void {
    if (ev.generation !== this.generation) {
      this.stop();
      this.generation = ev.generation;
    }
    if (ev.last) this.sawLast = true;
    if (ev.audioBase64) {
      const bytes = Uint8Array.from(atob(ev.audioBase64), (c) => c.charCodeAt(0));
      this.queue.push(URL.createObjectURL(new Blob([bytes], { type: ev.mime })));
      this.pump();
    } else {
      this.maybeDone(); // pure end-marker
    }
  }

  /** Hard stop: generation superseded or the turn ended — drop everything. */
  stop(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.queue.forEach((u) => URL.revokeObjectURL(u));
    this.queue = [];
    this.sawLast = false;
    this.playing = false;
  }

  private pump(): void {
    if (this.playing) return;
    const url = this.queue.shift();
    if (!url) {
      this.maybeDone();
      return;
    }
    this.playing = true;
    this.audio.src = url;
    const release = () => {
      URL.revokeObjectURL(url);
      this.playing = false;
      this.pump();
    };
    this.audio.onended = release;
    this.audio.onerror = release; // a bad segment must not wedge the queue
    void this.audio.play().catch(release);
  }

  private maybeDone(): void {
    if (this.sawLast && this.queue.length === 0 && !this.playing) {
      this.sawLast = false;
      void api.voice.playbackDone(this.generation).catch(() => {});
    }
  }
}
