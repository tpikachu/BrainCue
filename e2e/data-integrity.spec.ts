import { test, expect } from './fixtures';

// Exercises the REAL main process + SQLite through the typed window.api facade —
// no brittle UI selectors. This is where the FK-cascade path lives (the one unit
// tests structurally can't cover, since better-sqlite3 won't load under vitest).
//
// OFFLINE (the default tier's guard): no key of any kind, so jobs.save never
// tries to parse the JD — and each DB test also proves it never even TRIED the
// network, so it can never depend on a provider succeeding. Live parsing is the
// live tier's job (live-openai.spec.ts).

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
  test('deleting an interview cleans up without a FOREIGN KEY error', async ({ dashboard, guardLog }) => {
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
    expect(guardLog().filter((e) => e.kind === 'net')).toEqual([]); // no provider was even tried
  });

  test('deleting a profile cascades to its interviews', async ({ dashboard, guardLog }) => {
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
    expect(guardLog().filter((e) => e.kind === 'net')).toEqual([]);
  });

  test('model preset + per-task override round-trip through settings', async ({ dashboard }) => {
    // Model ids are policy data (the account's own model list decides), so this
    // checks the round-trip — not a hard-coded id that a policy update retires.
    const out = await dashboard.evaluate(async () => {
      const api = (window as any).api;
      await api.settings.set({ modelPreset: 'best', models: {} });
      const best = await api.settings.get();
      await api.settings.set({ modelPreset: 'low_cost', models: {} });
      const fast = await api.settings.get();
      await api.settings.set({ models: { answer: 'override-model' } });
      const overridden = await api.settings.get();
      await api.settings.set({ modelPreset: 'balanced', models: {} });
      const reset = await api.settings.get();
      return { best, fast, overridden, reset };
    });
    expect(out.best.modelPreset).toBe('best');
    expect(out.fast.modelPreset).toBe('low_cost');
    // The preset's table flows into the effective defaults, task by task.
    for (const t of ['answer', 'classify', 'parsing']) {
      expect(typeof out.best.modelDefaults[t]).toBe('string');
      expect(out.best.modelDefaults[t].length).toBeGreaterThan(0);
    }
    expect(out.fast.modelDefaults).not.toEqual(out.best.modelDefaults);
    // A per-task override is kept apart from the defaults, and cleared on reset.
    expect(out.overridden.models.answer).toBe('override-model');
    expect(out.overridden.modelDefaults.answer).toBe(out.fast.modelDefaults.answer);
    expect(out.reset.modelPreset).toBe('balanced');
    expect(out.reset.models.answer ?? null).toBeNull();
  });
});
