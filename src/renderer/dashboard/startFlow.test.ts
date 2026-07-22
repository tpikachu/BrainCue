import { describe, expect, it } from 'vitest';
import type { Profile } from '@shared/types';
import { captureSummary, enabledModes, START_MODES, startBlocker } from './startFlow';

const profile = (over: Partial<Profile> = {}): Profile =>
  ({ id: 'p1', name: 'A', parsedResume: '{"skills":[]}', ...over }) as Profile;

describe('mode catalog', () => {
  it('covers every SessionMode exactly once', () => {
    expect(START_MODES.map((m) => m.id).sort()).toEqual(
      ['companion', 'interview', 'interviewer_assist', 'meeting', 'practice', 'tutor'].sort(),
    );
  });

  it('flag-gated modes are hidden, not rendered dead — only shipped modes are enabled', () => {
    // Meeting shipped with Prompt 7 (FLAGS.meeting); the rest stay gated.
    expect(enabledModes().map((m) => m.id)).toEqual([
      'interview',
      'practice',
      'meeting',
      'companion',
    ]);
  });
});

describe('startBlocker — the explicit-start gate', () => {
  const ok = { profile: profile(), apiKeyPresent: true, sessionLive: false };

  it('passes when a keyed profile with a parsed résumé is picked and nothing is live', () => {
    expect(startBlocker(ok)).toBeNull();
  });

  it('blocks in priority order: live session > key > profile > résumé', () => {
    expect(startBlocker({ ...ok, sessionLive: true })).toMatch(/already live/);
    expect(startBlocker({ ...ok, apiKeyPresent: false })).toMatch(/API key/);
    expect(startBlocker({ ...ok, profile: undefined })).toMatch(/profile/i);
    expect(startBlocker({ ...ok, profile: profile({ parsedResume: null }) })).toMatch(/résumé/);
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

  it('companion: mic-only capture bounded to the session, and the no-model-call promise', () => {
    const s = captureSummary({ source: 'system', spaceTitle: null, mode: 'companion' });
    // Whatever source was toggled, companion always captures the microphone,
    // and only while the session runs (explicit consent boundary).
    expect(s.captured[0]).toMatch(/microphone/i);
    expect(s.captured[0]).toMatch(/ONLY while this session runs/);
    // Cost honesty: silence/mute/DND/cooldowns never spend a model call.
    expect(s.sent.join(' ')).toMatch(/never spend a model call/);
    expect(s.sent.join(' ')).toMatch(/APPROVED memories/);
  });
});
