import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { voiceService } from '../services/voice/voiceService';

/** Voice/summon layer (v2 Prompt 9). Control channels return the resulting
 *  dialogue state; audio is one-way (fire-and-forget, like realtimeAudio) —
 *  raw PCM is buffered in main while listening and never echoed back. */
export function registerVoiceIpc(): void {
  handle(IPC.voice.summon, z.void(), () => voiceService.summon());
  handle(IPC.voice.commit, z.void(), async () => {
    // Commit runs STT + routing; the state journey streams over EVENTS.voiceState.
    void voiceService.commit();
    return { state: voiceService.state };
  });
  handle(IPC.voice.cancel, z.void(), () => voiceService.cancel());
  handle(IPC.voice.interrupt, z.void(), () => voiceService.interrupt());
  handle(IPC.voice.playbackDone, z.object({ generation: z.number().int() }), ({ generation }) => {
    voiceService.playbackDone(generation);
    return { state: voiceService.state };
  });
  handle(IPC.voice.getPrefs, z.void(), () => voiceService.getPrefs());
  handle(
    IPC.voice.setPrefs,
    z.object({
      voice: z.string().min(1).optional(),
      muted: z.boolean().optional(),
      outputDeviceId: z.string().nullable().optional(),
      saveQuickAsks: z.boolean().optional(),
      quickAskPackId: z.string().nullable().optional(),
    }),
    (patch) => voiceService.setPrefs(patch),
  );

  // High-frequency push-to-talk PCM frames: fire-and-forget (no Result envelope).
  ipcMain.on(IPC.voice.audio, (_e, payload: { pcm: ArrayBuffer }) => {
    if (payload?.pcm) voiceService.feedAudio(payload.pcm);
  });
}
