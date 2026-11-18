import os from 'node:os';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { handle } from './helpers';
import { latency } from '../services/engine/metrics/latencyStore';

/** Live latency instrumentation. The overlay reports when a card's first
 *  real answer words were actually PAINTED (not when a token arrived, and not
 *  a bare Markdown marker), and the summary is read per stage, category and
 *  outcome. Ids and timestamps only — never text. */
export function registerMetricsIpc(): void {
  handle(
    IPC.metrics.firstUseful,
    z.object({ contributionId: z.string().min(1).max(100), at: z.number().int().positive() }),
    ({ contributionId, at }) => {
      latency.mark(contributionId, { firstUsefulAt: at });
      return { ok: true as const };
    },
  );

  handle(IPC.metrics.latency, z.void(), () => ({
    summary: latency.summary(),
    samples: latency.all().filter((t) => t.outcome).length,
    hardware: {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 2 ** 30),
      platform: `${os.platform()} ${os.release()}`,
    },
  }));
}
