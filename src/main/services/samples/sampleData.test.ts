import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sample data is the first-run "try it" path. Its résumé was parsed only when
 * an OPENAI key was stored, so a user set up with Anthropic (or any other
 * provider) got a sample profile with no parsed résumé — and the Interview,
 * which needs one, refused to start on the very data offered to try it.
 * Parsing runs on whichever provider the parsing task resolves to.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as import('../../test/dbHarness').TestDb,
  parsingReady: true,
  parsed: 0,
}));

vi.mock('../../db', async () => {
  const schema = await vi.importActual<typeof import('../../db/schema')>('../../db/schema');
  return {
    schema,
    db: () => h.db,
    initDb: () => h.db,
    rawDb: () => {
      throw new Error('rawDb not available in tests');
    },
  };
});
vi.mock('../readiness', () => ({ chatTaskReady: (task: string) => task === 'parsing' && h.parsingReady }));
// The OpenAI key store would say "no key" — it must not be what decides.
vi.mock('../security/apiKey', () => ({ apiKeyStore: { isPresent: () => false } }));
vi.mock('../openai/parsing', () => ({
  parseResume: async () => {
    h.parsed++;
    return { skills: ['TypeScript'], projects: [], workHistory: [], metrics: [], education: [], certifications: [], techStack: [], leadership: [] };
  },
  parseJobDescription: async () => ({ requirements: ['x'], responsibilities: [], keywords: [], focusAreas: [] }),
}));
vi.mock('../rag/indexProfile', () => ({ reindexProfile: async () => {}, indexJob: async () => {} }));

import { createTestDb } from '../../test/dbHarness';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { loadSampleData } from './sampleData';

beforeAll(async () => {
  h.db = (await createTestDb()).db;
});
beforeEach(() => {
  h.parsed = 0;
});

describe('sample data with a non-OpenAI provider', () => {
  it('parses the sample résumé when the parsing task has a keyed provider (no OpenAI key)', async () => {
    h.parsingReady = true;
    const { profileId } = await loadSampleData();
    expect(h.parsed).toBe(1);
    expect(profilesRepo.get(profileId)?.parsedResume).toBeTruthy();
  });

  it('with no provider for parsing, the résumé is kept unparsed (and no model call is attempted)', async () => {
    h.parsingReady = false;
    const { profileId } = await loadSampleData();
    expect(h.parsed).toBe(0);
    expect(profilesRepo.get(profileId)?.parsedResume).toBeFalsy();
  });
});
