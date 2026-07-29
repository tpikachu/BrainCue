import { describe, expect, it } from 'vitest';
import type { Profile } from '@shared/types';
import { ACTIVITIES, ACTIVITY_ORDER } from '@shared/activities';
import { START_ACTIVITIES, captureSummary, spacesFor, startBlocker } from './startFlow';

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

  it('leads with the daily conversations, not the interview', () => {
    expect(START_ACTIVITIES[0].id).toBe('meeting');
    expect(START_ACTIVITIES.findIndex((a) => a.id === 'job')).toBeGreaterThan(0);
  });
});

describe('startBlocker — the explicit-start gate', () => {
  const ok = { profile: profile(), apiKeyPresent: true, sessionLive: false };

  it('passes when a keyed profile is picked and nothing is live', () => {
    expect(startBlocker(ok)).toBeNull();
  });

  it('blocks in priority order: live session > key > profile', () => {
    expect(startBlocker({ ...ok, sessionLive: true })).toMatch(/already live/);
    expect(startBlocker({ ...ok, apiKeyPresent: false })).toMatch(/API key/);
    expect(startBlocker({ ...ok, profile: undefined })).toMatch(/profile/i);
  });

  it('asks for a résumé before an interview', () => {
    expect(
      startBlocker({ ...ok, profile: profile({ parsedResume: null }), activity: 'job' }),
    ).toMatch(/résumé/);
  });

  it('asks for a Space before an interview, and takes one', () => {
    // An interview is one round of several for one role. Without a Space there
    // is nowhere to keep what was asked, what you claimed, and what they pushed
    // on — so the next round starts from nothing, which is the whole loss.
    expect(startBlocker({ ...ok, activity: 'job' })).toMatch(/Space/);
    expect(startBlocker({ ...ok, activity: 'job', spaceId: '' })).toMatch(/Space/);
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
    // …including when no activity is passed at all.
    expect(startBlocker({ ...ok, profile: noResume })).toBeNull();
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
  it('names the chosen audio source', () => {
    expect(captureSummary({ source: 'system', spaceTitle: null }).captured[0]).toMatch(
      /System audio/,
    );
    expect(captureSummary({ source: 'mic', spaceTitle: null }).captured[0]).toMatch(/microphone/);
  });

  it('scopes the sent-chunks line to the Space when one is selected', () => {
    const withSpace = captureSummary({ source: 'system', spaceTitle: 'Stripe · Platform PM' });
    expect(withSpace.sent[1]).toContain('Stripe · Platform PM');
    const noSpace = captureSummary({ source: 'system', spaceTitle: null });
    expect(noSpace.sent[1]).toContain('your profile');
    expect(noSpace.sent[1]).not.toContain('Space');
  });

  it('says what survives the session — before it starts, not at the save prompt', () => {
    // A Space is the only place a conversation is kept, so starting without one
    // means keeping nothing. Discovering that after the call is discovering it
    // too late.
    const noSpace = captureSummary({ source: 'system', spaceTitle: null }).captured.join(' ');
    expect(noSpace).toMatch(/nothing is summarised or remembered/i);

    const withSpace = captureSummary({
      source: 'system',
      spaceTitle: 'Senior engineer · Acme',
    }).captured.join(' ');
    expect(withSpace).toContain('Senior engineer · Acme');
    expect(withSpace).not.toMatch(/nothing is summarised/i);
  });

  it('always states what NEVER leaves the machine (key, full docs, screen)', () => {
    const { neverSent } = captureSummary({ source: 'system', spaceTitle: null });
    expect(neverSent.join(' ')).toMatch(/API key/);
    expect(neverSent.join(' ')).toMatch(/résumé|documents/);
    expect(neverSent.join(' ')).toMatch(/screen/i);
  });

  it('describes the pipeline of the activity’s MODE, not the activity', () => {
    // A project call and a standup are different activities that run the same
    // mode — so they must promise exactly the same things.
    expect(captureSummary({ source: 'system', spaceTitle: null, activity: 'project' })).toEqual(
      captureSummary({ source: 'system', spaceTitle: null, activity: 'meeting' }),
    );
    expect(captureSummary({ source: 'system', spaceTitle: null, activity: 'meeting' }).sent.join(' '))
      .toMatch(/salience scoring/);
    expect(captureSummary({ source: 'system', spaceTitle: null, activity: 'job' }).sent.join(' '))
      .toMatch(/Per detected question/);
  });

  it('solo: mic-only capture bounded to the session, and the no-model-call promise', () => {
    const s = captureSummary({ source: 'system', spaceTitle: null, activity: 'solo' });
    // Whatever source was toggled, a companion session always captures the
    // microphone, and only while the session runs (explicit consent boundary).
    expect(s.captured[0]).toMatch(/microphone/i);
    expect(s.captured[0]).toMatch(/ONLY while this session runs/);
    // Cost honesty: silence/mute/DND/cooldowns never spend a model call.
    expect(s.sent.join(' ')).toMatch(/never spend a model call/);
    expect(s.sent.join(' ')).toMatch(/APPROVED memories/);
  });
});
