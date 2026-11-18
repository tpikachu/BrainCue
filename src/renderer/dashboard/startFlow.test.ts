import { describe, expect, it } from 'vitest';
import type { ContextPackKind, Profile, SessionMode } from '@shared/types';
import { ACTIVITIES, ACTIVITY_ORDER } from '@shared/activities';
import {
  START_ACTIVITIES,
  captureSummary,
  defaultSpaceFor,
  isResumableInterview,
  lastOtherActivity,
  nextSpaceChoice,
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
      .toMatch(/Per detected question/);
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

describe('defaultSpaceFor — the role a returning user does not have to choose again', () => {
  it('opens on the role of the most recent interview (sessions are newest first)', () => {
    const spaces = [role('r1'), role('r2'), role('r3')];
    expect(defaultSpaceFor('job', spaces, [sess({ jobId: 'r2' }), sess({ jobId: 'r1' })])).toBe('r2');
  });
  it('skips sessions that are not interviews when finding it', () => {
    const spaces = [role('r1'), role('r2'), { id: 'm1', kind: 'meeting' }];
    const history = [sess({ mode: 'meeting', activity: 'meeting', jobId: 'm1' }), sess({ kind: 'mock', mode: 'practice', jobId: 'r1' }), sess({ jobId: 'r2' })];
    expect(defaultSpaceFor('job', spaces, history)).toBe('r2');
  });
  it('with no history: the only role there is, but never a guess among several', () => {
    expect(defaultSpaceFor('job', [role('r1')], [])).toBe('r1');
    expect(defaultSpaceFor('job', [role('r1'), role('r2')], [])).toBe('');
    expect(defaultSpaceFor('job', [], [])).toBe('');
  });
  it('a role that no longer exists is never the default', () => {
    expect(defaultSpaceFor('job', [role('r1'), role('r2')], [sess({ jobId: 'gone' }), sess({ jobId: 'r1' })])).toBe('r1');
  });
  it('other activities default to their last-used Space, and to none rather than the only one', () => {
    const meetings = [{ id: 'm1', kind: 'meeting' }, { id: 'm2', kind: 'meeting' }];
    expect(defaultSpaceFor('meeting', meetings, [sess({ mode: 'meeting', activity: 'meeting', jobId: 'm2' })])).toBe('m2');
    expect(defaultSpaceFor('meeting', [{ id: 'm1', kind: 'meeting' }], [])).toBe('');
  });
});

describe('nextSpaceChoice — the start flow keeps a real choice and drops a stale one', () => {
  const spaces = [role('r1'), role('r2')];
  const history = [sess({ jobId: 'r2' })];
  it('decides nothing while either list is loading or belongs to another profile', () => {
    expect(nextSpaceChoice({ activity: 'job', spaces: null, sessions: history, spaceId: '', chosen: false })).toBeNull();
    expect(nextSpaceChoice({ activity: 'job', spaces, sessions: null, spaceId: '', chosen: false })).toBeNull();
  });
  it('applies the default once both are loaded', () => {
    expect(nextSpaceChoice({ activity: 'job', spaces, sessions: history, spaceId: '', chosen: false })).toEqual({ spaceId: 'r2', chosen: false });
  });
  it("keeps the user's own pick while it exists", () => {
    expect(nextSpaceChoice({ activity: 'job', spaces, sessions: history, spaceId: 'r1', chosen: true })).toBeNull();
  });
  it('drops a pick that was deleted, back to the default', () => {
    expect(nextSpaceChoice({ activity: 'job', spaces: [role('r2')], sessions: history, spaceId: 'r1', chosen: true })).toEqual({
      spaceId: 'r2',
      chosen: false,
    });
  });
  it("after a profile switch, the other profile's role is never kept", () => {
    // Profile B's lists: none of A's roles, and its own history.
    const bSpaces = [role('b1'), role('b2')];
    const bHistory = [sess({ jobId: 'b1' })];
    expect(nextSpaceChoice({ activity: 'job', spaces: bSpaces, sessions: bHistory, spaceId: 'r1', chosen: true })).toEqual({
      spaceId: 'b1',
      chosen: false,
    });
    // …and a stale default (not chosen) is replaced the same way.
    expect(nextSpaceChoice({ activity: 'job', spaces: bSpaces, sessions: [], spaceId: 'r2', chosen: false })).toEqual({
      spaceId: '',
      chosen: false,
    });
  });
});

describe('lastOtherActivity — "Other conversation" opens on what this profile last did', () => {
  it('the last non-interview activity, else a meeting', () => {
    expect(lastOtherActivity([sess(), { kind: 'live', activity: 'subject' }, { kind: 'live', activity: 'meeting' }])).toBe('subject');
    expect(lastOtherActivity([sess()])).toBe('meeting');
    expect(lastOtherActivity([{ kind: 'mock', activity: null }])).toBe('meeting');
  });
});

describe('captureSummary — names the engine and provider that will actually run', () => {
  it('on-device transcription: no audio leaves the machine, said plainly', () => {
    const s = captureSummary({ listensTo: 'system', spaceTitle: null, activity: 'job', sttEngine: 'local', chatProvider: 'Anthropic' });
    expect(s.sent[0]).toBe('No audio — it is transcribed on this device.');
    expect(s.sent.join(' ')).toMatch(/question text \+ the top-5 matching chunks from your profile, to Anthropic\./);
    expect(s.sent.join(' ')).not.toMatch(/OpenAI/);
  });
  it('cloud transcription names OpenAI Realtime and both streams', () => {
    expect(captureSummary({ listensTo: 'system', spaceTitle: null, activity: 'job', sttEngine: 'cloud' }).sent[0]).toBe(
      'Audio — both streams — to OpenAI Realtime, for transcription.',
    );
  });
});
