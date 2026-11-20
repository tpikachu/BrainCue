import { test, expect } from './fixtures';

test.use({ noApiKey: true });

test('Fast processing defaults on, persists an opt-out independently, and rejects an invalid preference', async ({ dashboard }) => {
  const result = await dashboard.evaluate(async () => {
    const a = window.api;
    const initial = await a.settings.get() as { openaiInterviewFast: boolean; models: Record<string, string> };
    await a.settings.set({ openaiInterviewFast: false });
    const disabled = await a.settings.get() as typeof initial;
    let rejected = false;
    try { await a.settings.set({ openaiInterviewFast: 'yes' }); } catch { rejected = true; }
    const afterInvalid = await a.settings.get() as typeof initial;
    await a.settings.set({ openaiInterviewFast: true });
    const enabled = await a.settings.get() as typeof initial;
    return { initial, enabled, rejected, afterInvalid, disabled };
  });
  expect(result.initial.openaiInterviewFast).toBe(true);
  expect(result.enabled.openaiInterviewFast).toBe(true);
  expect(result.enabled.models).toEqual(result.initial.models);
  expect(result.rejected).toBe(true);
  expect(result.afterInvalid.openaiInterviewFast).toBe(false);
  expect(result.disabled.openaiInterviewFast).toBe(false);
});
