import { beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as unknown as import('../../test/dbHarness').TestDb }));
vi.mock('../index', async () => ({
  schema: await vi.importActual<typeof import('../schema')>('../schema'),
  db: () => h.db,
}));
import * as schema from '../schema';
import { createTestDb } from '../../test/dbHarness';
import { profilesRepo } from './profiles.repo';

beforeAll(async () => {
  h.db = (await createTestDb()).db;
  h.db.insert(schema.profiles).values([
    { id: 'a', name: 'Candidate', targetRole: 'Default role', targetCompany: 'Old company' },
    { id: 'b', name: 'Other candidate' },
  ]).run();
  h.db.insert(schema.contextPacks).values([
    { id: 'own', profileId: 'a', kind: 'job', title: 'Infrastructure engineer', company: 'Solaris' },
    { id: 'other', profileId: 'b', kind: 'job', title: 'Private role', company: 'Private company' },
    { id: 'meeting', profileId: 'a', kind: 'meeting', title: 'Daily standup' },
    { id: 'unknown-company', profileId: 'a', kind: 'job', title: 'Backend engineer', company: null },
  ]).run();
});

describe('the selected interview target', () => {
  it('uses its job Space without mutating the stored profile target', () => {
    expect(profilesRepo.get('a', { interviewPackId: 'own' })).toMatchObject({ targetRole: 'Infrastructure engineer', targetCompany: 'Solaris' });
    expect(profilesRepo.get('a')).toMatchObject({ targetRole: 'Default role', targetCompany: 'Old company' });
  });

  it('never borrows a different profile or a non-job Space', () => {
    const original = profilesRepo.get('a');
    for (const id of ['other', 'meeting', 'missing'])
      expect(profilesRepo.get('a', { interviewPackId: id })).toEqual(original);
    expect(profilesRepo.get('missing', { interviewPackId: 'own' })).toBeNull();
  });

  it('does not invent a company from the default profile when the job has none', () => {
    expect(profilesRepo.get('a', { interviewPackId: 'unknown-company' })).toMatchObject({ targetRole: 'Backend engineer', targetCompany: null });
  });
});
