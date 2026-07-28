import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { err, ok, type Result } from '@shared/result';
import { normalizeOpenAIError } from '../services/openai/client';
import { log } from '../services/security/logger';

/**
 * Register a request/response handler with zod validation and a uniform
 * Result<T> envelope. Errors are normalized (and redacted) — never thrown
 * across the wire.
 */
export function handle<S extends z.ZodTypeAny, TOutput>(
  channel: string,
  schema: S,
  fn: (input: z.infer<S>, event: IpcMainInvokeEvent) => Promise<TOutput> | TOutput,
): void {
  ipcMain.handle(channel, async (event, rawInput): Promise<Result<TOutput>> => {
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) {
      log.warn(`ipc ${channel}: invalid input`, parsed.error.flatten());
      return err(`Invalid request for ${channel}`);
    }
    try {
      const data = await fn(parsed.data, event);
      return ok(data);
    } catch (e) {
      const message = normalizeOpenAIError(e);
      log.error(`ipc ${channel}: handler error`, message);
      return err(message);
    }
  });
}

/** Common no-argument schema. */
export const NoInput = z.union([z.undefined(), z.null(), z.void()]).transform(() => undefined);
export const zId = z.object({ id: z.string().min(1) });
/** ContextPackKind — what a Space is about (see shared/spaceKinds.ts). */
export const zSpaceKind = z.enum([
  'job',
  'subject',
  'project',
  'meeting',
  'personal',
  'game',
  'custom',
]);
