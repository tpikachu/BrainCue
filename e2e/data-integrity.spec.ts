import { test, expect } from './fixtures';

// Exercises the REAL main process + SQLite through the typed window.api facade —
// no brittle UI selectors. This is where the FK-cascade path lives (the one unit
// tests structurally can't cover, since better-sqlite3 won't load under vitest).
// No OpenAI key required: jobs.save just skips parsing when no key is present.

/* eslint-disable @typescript-eslint/no-explicit-any */
const newProfile = {
  name: 'E2E Tester',
  targetRole: 'SWE',
  targetCompany: null,
  interviewType: 'general',
  language: 'en',
  resumeText: null,
  jdText: null,
};

test.describe('data integrity (window.api → real DB)', () => {
  test('deleting an interview cleans up without a FOREIGN KEY error', async ({ dashboard }) => {
    const result = await dashboard.evaluate(async (profileInput) => {
      const api = (window as any).api;
      const profile = await api.profiles.create(profileInput);
      const saved = await api.jobs.save({
        profileId: profile.id,
        title: 'E2E Role',
        company: 'Acme',
        jdUrl: null,
        jdText: 'Build resilient systems.',
        companyUrl: null,
        notes: null,
      });
      const jobId = saved.job.id;
      // The FK-cascade workaround: this must NOT throw "FOREIGN KEY constraint failed".
      await api.jobs.delete(jobId);
      const remaining = await api.jobs.list(profile.id);
      await api.profiles.delete(profile.id); // cleanup
      return { jobId, remainingIds: remaining.map((j: any) => j.id) };
    }, newProfile);

    expect(result.remainingIds).not.toContain(result.jobId);
  });

  test('deleting a profile cascades to its interviews', async ({ dashboard }) => {
    const remaining = await dashboard.evaluate(async (profileInput) => {
      const api = (window as any).api;
      const profile = await api.profiles.create({ ...profileInput, name: 'E2E Cascade' });
      await api.jobs.save({
        profileId: profile.id,
        title: 'J1',
        company: null,
        jdUrl: null,
        jdText: 'x',
        companyUrl: null,
        notes: null,
      });
      await api.profiles.delete(profile.id); // must not throw
      return (await api.jobs.list(profile.id)).length;
    }, newProfile);

    expect(remaining).toBe(0);
  });

  test('model preset + per-task override round-trip through settings', async ({ dashboard }) => {
    const out = await dashboard.evaluate(async () => {
      const api = (window as any).api;
      await api.settings.set({ modelPreset: 'best', models: {} });
      const a = await api.settings.get();
      await api.settings.set({ models: { answer: 'gpt-4o' } });
      const b = await api.settings.get();
      // reset
      await api.settings.set({ modelPreset: 'balanced', models: {} });
      return {
        preset: a.modelPreset,
        bestAnswerDefault: a.modelDefaults.answer, // preset table flows into modelDefaults
        override: b.models.answer,
      };
    });
    expect(out.preset).toBe('best');
    expect(out.bestAnswerDefault).toBe('gpt-4.1'); // Best uses the full model on the live path
    expect(out.override).toBe('gpt-4o');
  });
});
