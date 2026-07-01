import { test, expect } from './fixtures';

// Regression test for the v1.0 fixes B1 + B2: a failed live answer must SURFACE an
// error AND clear the streaming state (no card stuck spinning forever). We launch
// with NO API key (noApiKey strips OPENAI_API_KEY), so the first OpenAI call throws
// "No OpenAI API key configured" — deterministic, offline, no real auth call. Each
// test has its own isolated data dir.
/* eslint-disable @typescript-eslint/no-explicit-any */
test.use({ noApiKey: true });

test('a failed answer surfaces an error and clears the streaming state (B1/B2)', async ({
  dashboard,
}) => {
  test.setTimeout(60_000);
  const result = await dashboard.evaluate(async () => {
    const api = (window as any).api;
    const profile = await api.profiles.create({
      name: 'Err',
      targetRole: 'SWE',
      targetCompany: null,
      interviewType: 'general',
      language: 'en',
      resumeText: null,
      jdText: null,
    });
    const session = await api.session.start(profile.id, 'general', null, 'key_points');

    // Listen BEFORE asking. answerDone firing on a failed ask is the core B1 fix
    // (the Cue Card card stops spinning); sessionError proves the failure isn't silent.
    const sawError = new Promise<boolean>((res) => api.events.onSessionError(() => res(true)));
    const sawDone = new Promise<boolean>((res) => api.events.onAnswerDone(() => res(true)));
    const timeout = (ms: number) => new Promise<boolean>((res) => setTimeout(() => res(false), ms));

    await api.session.ask(session.id, 'Tell me about a hard problem you solved.').catch(() => {});
    const [errored, doneFired] = await Promise.all([
      Promise.race([sawError, timeout(20_000)]),
      Promise.race([sawDone, timeout(20_000)]),
    ]);

    await api.session.stop(session.id).catch(() => {});
    await api.profiles.delete(profile.id).catch(() => {});
    return { errored, doneFired };
  });

  expect(result.errored).toBe(true); // failure is surfaced, not silent
  expect(result.doneFired).toBe(true); // streaming state cleared — card doesn't wedge
});
