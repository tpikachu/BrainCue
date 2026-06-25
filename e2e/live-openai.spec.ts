import { test, expect, hasKey, setApiKey } from './fixtures';

// LIVE tier — hits real OpenAI via the in-app pipeline (parse + embed + retrieve).
// Gated on OPENAI_API_KEY so CI without a key still passes. Asserts on STRUCTURE,
// not exact text, since real output is non-deterministic. Audio/transcription are
// NOT exercised (no mic in headless) — covered here via the no-audio sample/RAG path.

/* eslint-disable @typescript-eslint/no-explicit-any */
test.describe('live OpenAI (real key)', () => {
  test.skip(!hasKey, 'Set OPENAI_API_KEY in .env to run the live tier.');

  test('load samples → résumé is parsed and chunks are embedded', async ({ dashboard }) => {
    test.setTimeout(180_000); // real parse of a résumé + JDs + embeddings can take a while
    await setApiKey(dashboard);

    const result = await dashboard.evaluate(async () => {
      const api = (window as any).api;
      const { profileId, jobs } = await api.data.loadSamples(); // real parse + index
      const profile = await api.profiles.get(profileId);
      const reindex = await api.documents.reindexProfile(profileId); // real embeddings
      return {
        jobs,
        hasParsedResume: !!profile.parsedResume,
        skills: profile.parsedResume?.skills?.length ?? 0,
        embedded: reindex.embedded,
      };
    });

    expect(result.jobs).toBeGreaterThan(0); // sample interviews created
    expect(result.hasParsedResume).toBe(true); // real OpenAI parse happened
    expect(result.skills).toBeGreaterThan(0);
    expect(result.embedded).toBeGreaterThan(0); // real OpenAI embeddings produced
  });
});
