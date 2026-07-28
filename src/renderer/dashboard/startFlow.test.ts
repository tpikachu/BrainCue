import { describe, expect, it } from 'vitest';
import type { Profile } from '@shared/types';
import { ACTIVITIES } from '@shared/activities';
import { START_ACTIVITIES, captureSummary, startBlocker } from './startFlow';

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
