import os from 'node:os';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { latency } from '../services/engine/metrics/latencyStore';

/** Live latency instrumentation. The overlay reports when a card's first
 *  words were actually PAINTED (not when a token arrived), and the dashboard
 *  reads the per-stage summary. Ids and timestamps only — never text. */
export function registerMetricsIpc(): void {
  handle(
    IPC.metrics.firstVisible,
    z.object({ contributionId: z.string().min(1).max(100), at: z.number().int().positive() }),
    ({ contributionId, at }) => {
      latency.mark(contributionId, { firstVisibleAt: at });
      return { ok: true as const };
    },
  );

  handle(IPC.metrics.latency, z.void(), () => ({
    summary: latency.summary(),
    samples: latency.all().length,
    hardware: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 2 ** 30),
      platform: `${os.platform()} ${os.release()}`,
    },
  }));
}
