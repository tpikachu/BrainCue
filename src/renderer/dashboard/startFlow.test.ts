import { describe, expect, it } from 'vitest';
import type { ContextPackKind, Profile, SessionMode } from '@shared/types';
import { ACTIVITIES, ACTIVITY_ORDER } from '@shared/activities';
import {
  START_ACTIVITIES,
  captureSummary,
  isResumableInterview,
  lastOtherActivity,
  lastUsedSpaceIds,
  pickerOptions,
  resolveDefaultSpace,
  spaceFits,
  spacesFor,
  startBlocker,
} from './startFlow';

const profile = (over: Partial<Profile> = {}): Profile =>
  ({ id: 'p1', name: 'A', parsedResume: '{"skills":[]}', ...over }) as Profile;

describe('the start catalog — one list, not two', () => {
  it('offers activities, and every one carries what it will actually do', () => {
    expect(START_ACTIVITIES.length).toBeGreaterThan(0);
    for (const a of START_ACTIVITIES) {
      expect(ACTIVITIES[a.id], a.id).toBeDefined();
      // `does` is shown under the picker: the behaviour a mode used to
      // advertise, as a consequence of the choice rather than a second one.
      expect(a.does.length, a.id).toBeGreaterThan(0);
      expect(a.label.length, a.id).toBeGreaterThan(0);
    }
  });

  it('lists nothing that cannot be started', () => {
    // The old mode picker listed unbuilt modes as "Coming soon" tiles. In the
    // ONE list you must answer to start, that is an obstacle, not honesty.
    const modes = new Set(START_ACTIVITIES.map((a) => a.mode));
    expect(modes.has('tutor')).toBe(false);
    expect(modes.has('interviewer_assist')).toBe(false);
    // Practice is not an activity at all — it never started a session.
    expect(modes.has('practice')).toBe(false);
  });

  it('leads with the interview — the primary feature — and keeps every other activity', () => {
    expect(START_ACTIVITIES[0].id).toBe('job');
    expect(START_ACTIVITIES.map((a) => a.id)).toEqual(expect.arrayContaining(['meeting', 'project', 'solo']));
  });
});

describe('startBlocker — the explicit-start gate', () => {
  const ok = { profile: profile(), chatReady: true, sttReady: true, sessionLive: false };

  it('passes when a keyed profile is picked and nothing is live', () => {
    expect(startBlocker({ ...ok, activity: 'meeting' })).toBeNull();
    // The default activity is the interview: ready once its Space is chosen.
    expect(startBlocker({ ...ok, spaceId: 'space-1' })).toBeNull();
  });

  it('blocks in priority order: live session > key > transcription > profile', () => {
    expect(startBlocker({ ...ok, sessionLive: true })).toMatch(/already live/);
    expect(startBlocker({ ...ok, chatReady: false })).toMatch(/API key/);
    // The readiness service's own wording wins when it has one.
    expect(startBlocker({ ...ok, chatReady: false, chatProblem: 'Anthropic is selected but has no key.' })).toBe(
      'Anthropic is selected but has no key.',
    );
    expect(startBlocker({ ...ok, sttReady: false })).toMatch(/Transcription is not set up/);
    expect(startBlocker({ ...ok, profile: undefined })).toMatch(/profile/i);
  });

  it('names the missing key before missing transcription — one fix can clear both', () => {
    // Cloud engine + no key: sttReady is false too, but "add the key" is the
    // actionable message. Local engine with a model but no key: still the key.
    expect(startBlocker({ ...ok, chatReady: false, sttReady: false })).toMatch(/API key/);
    expect(startBlocker({ ...ok, chatReady: false, sttReady: false })).not.toMatch(/Transcription/);
  });

  it('asks for a résumé before an interview', () => {
    expect(
      startBlocker({ ...ok, profile: profile({ parsedResume: null }), activity: 'job' }),
    ).toMatch(/résumé/);
  });

  it('asks for a role (an interview Space) before an interview, and takes one', () => {
    // An interview is one round of several for one role. Without a Space there
    // is nowhere to keep what was asked, what you claimed, and what they pushed
    // on — so the next round starts from nothing, which is the whole loss.
    expect(startBlocker({ ...ok, activity: 'job' })).toMatch(/role/);
    expect(startBlocker({ ...ok, activity: 'job', spaceId: '' })).toMatch(/role/);
    expect(startBlocker({ ...ok, activity: 'job', spaceId: 'space-1' })).toBeNull();
  });

  it('names the missing résumé before the missing Space', () => {
    // Both are missing here. One message at a time, and the résumé is the one
    // that takes longer to fix.
    expect(
      startBlocker({ ...ok, profile: profile({ parsedResume: null }), activity: 'job' }),
    ).toMatch(/résumé/);
  });

  it('does NOT ask for a Space before anything else', () => {
    // Every other activity starts with nothing set up. Requiring a Space is
    // requiring setup, and that friction is exactly what made this feel like a
    // job-interview tool — you can sit in on a call you were not expecting.
    for (const kind of Object.keys(ACTIVITIES) as (keyof typeof ACTIVITIES)[]) {
      if (kind === 'job') continue;
      expect(startBlocker({ ...ok, activity: kind }), kind).toBeNull();
    }
  });

  it('does NOT ask for a résumé before anything else', () => {
    // The gate used to be unconditional: you could not sit in on your own
    // standup without first uploading a CV. That was the loudest remaining way
    // the app insisted it was an interview tool.
    const noResume = profile({ parsedResume: null });
    for (const kind of Object.keys(ACTIVITIES) as (keyof typeof ACTIVITIES)[]) {
      if (kind === 'job') continue;
      expect(startBlocker({ ...ok, profile: noResume, activity: kind }), kind).toBeNull();
    }
    // With no activity passed, the default is now the INTERVIEW (interview-
    // first), which genuinely answers from the résumé — so it asks.
    expect(startBlocker({ ...ok, profile: noResume, spaceId: 'space-1' })).toMatch(/résumé/);
  });
});

describe('spacesFor — a Space is a saved activity', () => {
  const spaces = [
    { id: 'm1', kind: 'meeting' },
    { id: 'm2', kind: 'meeting' },
    { id: 'j1', kind: 'job' },
    { id: 'v1', kind: null }, // a v1 row from before the catalog
    { id: 'x1', kind: 'not-a-kind' },
  ];

  it('offers only the Spaces of the chosen activity', () => {
    expect(spacesFor(spaces, 'meeting').map((s) => s.id)).toEqual(['m1', 'm2']);
    expect(spacesFor(spaces, 'job').map((s) => s.id)).toEqual(['j1']);
    expect(spacesFor(spaces, 'game')).toEqual([]);
  });

  it('files an unknown kind under "something else" rather than hiding it', () => {
    // A Space you cannot see in any list is a Space you cannot use — and the
    // start modal is the only place it can be chosen.
    expect(spacesFor(spaces, 'custom').map((s) => s.id)).toEqual(['v1', 'x1']);
  });

  it('leaves every Space reachable from exactly one activity', () => {
    const seen = ACTIVITY_ORDER.flatMap((k) => spacesFor(spaces, k).map((s) => s.id));
    expect(seen.sort()).toEqual(spaces.map((s) => s.id).sort());
    expect(new Set(seen).size).toBe(spaces.length);
  });
});

describe('captureSummary — the transparency contract', () => {
  it('says a call is heard on BOTH sides, and that questions come from the call', () => {
    const call = captureSummary({ listensTo: 'system', spaceTitle: null }).captured[0];
    expect(call).toMatch(/System audio/);
    expect(call).toMatch(/microphone/);
    expect(call).toMatch(/Questions are taken from the call/);
    // Both streams leave the machine when the cloud engine transcribes.
    expect(captureSummary({ listensTo: 'system', spaceTitle: null }).sent[0]).toMatch(/both streams/);
    expect(captureSummary({ listensTo: 'mic', spaceTitle: null }).captured[0]).toMatch(/microphone/);
    expect(captureSummary({ listensTo: 'mic', spaceTitle: null }).captured[0]).not.toMatch(
      /System audio/,
    );
  });

  it('scopes the sent-chunks line to the Space when one is selected', () => {
    const withSpace = captureSummary({ listensTo: 'system', spaceTitle: 'Stripe · Platform PM' });
    expect(withSpace.sent[1]).toContain('Stripe · Platform PM');
    const noSpace = captureSummary({ listensTo: 'system', spaceTitle: null });
    expect(noSpace.sent[1]).toContain('your profile');
    expect(noSpace.sent[1]).not.toContain('Space');
  });

  it('says what survives the session — before it starts, not at the save prompt', () => {
    // A Space is the only place a conversation is kept, so starting without one
    // means keeping nothing. Discovering that after the call is discovering it
    // too late.
    const noSpace = captureSummary({ listensTo: 'system', spaceTitle: null }).captured.join(' ');
    expect(noSpace).toMatch(/nothing is summarised or remembered/i);

    const withSpace = captureSummary({
      listensTo: 'system',
      spaceTitle: 'Senior engineer · Acme',
    }).captured.join(' ');
    expect(withSpace).toContain('Senior engineer · Acme');
    expect(withSpace).not.toMatch(/nothing is summarised/i);
  });

  it('always states what NEVER leaves the machine (key, full docs, screen)', () => {
    const { neverSent } = captureSummary({ listensTo: 'system', spaceTitle: null });
    expect(neverSent.join(' ')).toMatch(/API key/);
    expect(neverSent.join(' ')).toMatch(/résumé|documents/);
    expect(neverSent.join(' ')).toMatch(/screen/i);
  });

  it('describes the pipeline of the activity’s MODE, not the activity', () => {
    // A project call and a standup are different activities that run the same
    // mode — so they must promise exactly the same things.
    expect(captureSummary({ listensTo: 'system', spaceTitle: null, activity: 'project' })).toEqual(
      captureSummary({ listensTo: 'system', spaceTitle: null, activity: 'meeting' }),
    );
    expect(captureSummary({ listensTo: 'system', spaceTitle: null, activity: 'meeting' }).sent.join(' '))
      .toMatch(/salience scoring/);
    expect(captureSummary({ listensTo: 'system', spaceTitle: null, activity: 'job' }).sent.join(' '))
      .toMatch(/each detected question/);
  });

  it('solo: mic-only capture bounded to the session, and the no-model-call promise', () => {
    const s = captureSummary({ listensTo: 'system', spaceTitle: null, activity: 'solo' });
    // Whatever source was toggled, a companion session always captures the
    // microphone, and only while the session runs (explicit consent boundary).
    expect(s.captured[0]).toMatch(/microphone/i);
    expect(s.captured[0]).toMatch(/ONLY while this session runs/);
    // Cost honesty: silence/mute/DND/cooldowns never spend a model call.
    expect(s.sent.join(' ')).toMatch(/never spend a model call/);
    expect(s.sent.join(' ')).toMatch(/APPROVED memories/);
  });
});

// ---- M5: a returning user's path, interview-only choices, honest disclosure ----

type S = { kind: 'live' | 'mock' | 'sparring'; mode: SessionMode; activity: ContextPackKind | null; jobId: string | null };
const sess = (over: Partial<S> = {}): S => ({ kind: 'live', mode: 'interview', activity: 'job', jobId: 'r1', ...over });
const role = (id: string) => ({ id, kind: 'job' });

describe('isResumableInterview — only real interviews are offered for Resume', () => {
  it('a live interview in a role is resumable (v1 rows with no activity too)', () => {
    expect(isResumableInterview(sess())).toBe(true);
    expect(isResumableInterview(sess({ activity: null }))).toBe(true);
  });
  it('meetings, companion sessions, mock interviews and sparring drills are not', () => {
    expect(isResumableInterview(sess({ mode: 'meeting', activity: 'meeting' }))).toBe(false);
    expect(isResumableInterview(sess({ mode: 'meeting', activity: 'project' }))).toBe(false);
    expect(isResumableInterview(sess({ mode: 'companion', activity: 'solo' }))).toBe(false);
    expect(isResumableInterview(sess({ kind: 'mock', mode: 'practice', activity: null }))).toBe(false);
    expect(isResumableInterview(sess({ kind: 'sparring', mode: 'practice', activity: null }))).toBe(false);
    expect(isResumableInterview(sess({ jobId: null }))).toBe(false);
  });
});

// A role as main returns it.
type R = { id: string; profileId: string; kind: string; title: string };
const r = (id: string, over: Partial<R> = {}): R => ({ id, profileId: 'pA', kind: 'job', title: id, ...over });
/** 101 roles, newest first like the page query: the first page holds 100. */
const all = Array.from({ length: 101 }, (_, i) => r(`role-${101 - i}`));
const firstPage = { items: all.slice(0, 100), total: 101 };
/** main's jobs.get: by id, wherever the role sits; null once deleted. */
const getter = (rows: R[]) => async (id: string) => rows.find((x) => x.id === id) ?? null;

describe('spaceFits — a chosen Space must be this profile’s and this activity’s', () => {
  it('accepts its own role; refuses a deleted one, another profile’s, another activity’s', () => {
    const at = { profileId: 'pA', activity: 'job' as const };
    expect(spaceFits(r('role-1'), at)).toBe(true);
    expect(spaceFits(null, at)).toBe(false);
    expect(spaceFits(r('role-1', { profileId: 'pB' }), at)).toBe(false);
    expect(spaceFits(r('m1', { kind: 'meeting' }), at)).toBe(false);
  });
});

describe('the default role is found wherever it sits — never only on the first page', () => {
  it('lastUsedSpaceIds: newest first, distinct, interviews only, bounded', () => {
    const history = [sess({ jobId: 'role-1' }), sess({ mode: 'meeting', activity: 'meeting', jobId: 'm1' }), sess({ jobId: 'role-1' }), sess({ jobId: 'role-7' })];
    expect(lastUsedSpaceIds('job', history)).toEqual(['role-1', 'role-7']);
    const many = Array.from({ length: 9 }, (_, i) => sess({ jobId: `x${i}` }));
    expect(lastUsedSpaceIds('job', many)).toHaveLength(5);
  });
  it('the last-used role OUTSIDE the first 100 is the default (read by id)', async () => {
    expect(firstPage.items.some((x) => x.id === 'role-1')).toBe(false); // really not on the page
    const s = await resolveDefaultSpace({ activity: 'job', profileId: 'pA', sessions: [sess({ jobId: 'role-1' })], page: firstPage, get: getter(all) });
    expect(s?.id).toBe('role-1');
  });
  it('a deleted last-used role falls back to the one used before it, then to none', async () => {
    const history = [sess({ jobId: 'gone' }), sess({ jobId: 'role-2' })];
    expect((await resolveDefaultSpace({ activity: 'job', profileId: 'pA', sessions: history, page: firstPage, get: getter(all) }))?.id).toBe('role-2');
    expect(await resolveDefaultSpace({ activity: 'job', profileId: 'pA', sessions: [sess({ jobId: 'gone' })], page: firstPage, get: getter(all) })).toBeNull();
  });
  it('a role that is now another profile’s, or a get that fails, is never the default', async () => {
    const moved = [r('role-1', { profileId: 'pB' })];
    expect(await resolveDefaultSpace({ activity: 'job', profileId: 'pA', sessions: [sess({ jobId: 'role-1' })], page: firstPage, get: getter(moved) })).toBeNull();
    const failing = async () => {
      throw new Error('ipc');
    };
    expect(await resolveDefaultSpace({ activity: 'job', profileId: 'pA', sessions: [sess({ jobId: 'role-1' })], page: firstPage, get: failing })).toBeNull();
  });
  it('with no history: the only role there is (by TOTAL), never a guess among several', async () => {
    const one = { items: [r('only')], total: 1 };
    expect((await resolveDefaultSpace({ activity: 'job', profileId: 'pA', sessions: [], page: one, get: getter([]) }))?.id).toBe('only');
    expect(await resolveDefaultSpace({ activity: 'job', profileId: 'pA', sessions: [], page: firstPage, get: getter(all) })).toBeNull();
    // A meeting needs no Space: none rather than the only one.
    expect(await resolveDefaultSpace({ activity: 'meeting', profileId: 'pA', sessions: [], page: { items: [r('m', { kind: 'meeting' })], total: 1 }, get: getter([]) })).toBeNull();
  });
});

describe('pickerOptions — a selection is never dropped because of where it sits', () => {
  it('keeps a chosen role that is not on the loaded page (older, or filtered by a search)', () => {
    const chosen = r('role-1');
    const opts = pickerOptions(firstPage.items, chosen);
    expect(opts[0]).toBe(chosen);
    expect(opts).toHaveLength(101);
    expect(pickerOptions(firstPage.items, firstPage.items[3])).toHaveLength(100); // already there: not doubled
    expect(pickerOptions(firstPage.items, null)).toHaveLength(100);
  });
});

describe('lastOtherActivity — "Other conversation" opens on what this profile last did', () => {
  it('the last non-interview activity, else a meeting', () => {
    expect(lastOtherActivity([sess(), { kind: 'live', activity: 'subject' }, { kind: 'live', activity: 'meeting' }])).toBe('subject');
    expect(lastOtherActivity([sess()])).toBe('meeting');
    expect(lastOtherActivity([{ kind: 'mock', activity: null }])).toBe('meeting');
  });
});

describe('captureSummary — what is sent, and to which provider', () => {
  const split = { answer: 'Anthropic', classify: 'OpenAI', parsing: 'Anthropic' };
  const job = (over: Partial<Parameters<typeof captureSummary>[0]> = {}) =>
    captureSummary({ listensTo: 'system', spaceTitle: 'Stripe', activity: 'job', sttEngine: 'local', routes: split, retrieval: 'lexical', ...over });

  it('on-device transcription: no audio leaves the machine, said plainly', () => {
    expect(job().sent[0]).toBe('No audio — it is transcribed on this device.');
  });
  it('cloud transcription names OpenAI Realtime and both streams', () => {
    expect(job({ sttEngine: 'cloud' }).sent[0]).toBe('Audio — both streams — to OpenAI Realtime, for transcription.');
  });
  it('the answer request: question, passages, BOTH sides of the conversation, earlier suggestions, approved memories — to the answer provider', () => {
    const line = job().sent.find((l) => l.startsWith('To Anthropic:'))!;
    expect(line).toMatch(/each detected question/);
    expect(line).toMatch(/matching passages from your profile and the “Stripe” Space/);
    expect(line).toMatch(/recent and earlier conversation — what they and you said/);
    expect(line).toMatch(/earlier suggestions/);
    expect(line).toMatch(/approved memories/);
  });
  it('split routing: question detection is named with ITS provider', () => {
    const line = job().sent.find((l) => l.startsWith('To OpenAI:'))!;
    expect(line).toMatch(/interviewer turns the rules can’t settle, with the last few turns/);
    expect(line).toMatch(/predict a follow-up/);
    expect(job().sent.join(' ')).not.toMatch(/To Anthropic: interviewer turns/);
  });
  it('document matching by meaning sends the question to OpenAI; keyword matching sends nothing extra', () => {
    expect(job({ retrieval: 'embeddings' }).sent.join(' ')).toMatch(/To OpenAI: the question .*to find matching passages/);
    expect(job({ retrieval: 'lexical' }).sent.join(' ')).not.toMatch(/to find matching passages/);
  });
  it('a kept session’s transcript goes to the summary provider — only when there is a Space to keep it in', () => {
    expect(job().sent.join(' ')).toMatch(/To Anthropic: if you keep it afterwards, the transcript/);
    expect(job({ spaceTitle: null }).sent.join(' ')).not.toMatch(/if you keep it afterwards/);
  });
  it('meetings name the scoring provider and the card provider separately', () => {
    const m = captureSummary({ listensTo: 'system', spaceTitle: null, activity: 'meeting', routes: split });
    expect(m.sent.join(' ')).toMatch(/To OpenAI: ambiguous turns/);
    expect(m.sent.join(' ')).toMatch(/To Anthropic: when it answers or makes a card.*approved memories/);
  });
});
