import { describe, expect, it } from 'vitest';
import { FLAGS } from './flags';
import {
  ACTIVITIES,
  ACTIVITY_ORDER,
  DEFAULT_ACTIVITY,
  activity,
  isInterviewSpace,
  modeEnabled,
  modeFor,
  startableActivities,
} from './activities';

/**
 * An activity is the ONE thing the user picks. Two lists used to answer that
 * question — a mode picker and a Space kind — and they could disagree. These
 * pin what would quietly regress if they drifted apart again: every activity
 * must have its own words, must resolve to exactly one built mode, and the
 * interview-only machinery must stay behind its gate.
 */

describe('the activity catalog', () => {
  it('covers every activity in the picker, and none twice', () => {
    expect([...ACTIVITY_ORDER].sort()).toEqual(Object.keys(ACTIVITIES).sort());
    expect(new Set(ACTIVITY_ORDER).size).toBe(ACTIVITY_ORDER.length);
  });

  it('gives each activity its own vocabulary — none is left speaking about jobs', () => {
    for (const kind of ACTIVITY_ORDER) {
      const c = ACTIVITIES[kind];
      for (const [field, text] of Object.entries(c)) {
        if (typeof text !== 'string') continue;
        if (kind === 'job') continue; // the job activity SHOULD say job things
        expect(text.toLowerCase(), `${kind}.${field}`).not.toMatch(
          /job description|interview|résumé|resume|candidate/,
        );
      }
    }
  });

  it('falls back to the generic activity rather than throwing on an unknown one', () => {
    // v1 rows, hand-edited databases, and future kinds all land here. NOT the
    // default activity: "I don't know what this was" must not read as "meeting".
    expect(activity('not-a-kind')).toBe(ACTIVITIES.custom);
    expect(activity(null)).toBe(ACTIVITIES.custom);
    expect(activity(undefined)).toBe(ACTIVITIES.custom);
    expect(activity('meeting')).toBe(ACTIVITIES.meeting);
  });

  it('treats only the job activity as an interview', () => {
    expect(isInterviewSpace('job')).toBe(true);
    for (const kind of ACTIVITY_ORDER.filter((k) => k !== 'job')) {
      expect(isInterviewSpace(kind), kind).toBe(false);
    }
    expect(isInterviewSpace(null)).toBe(false);
  });
});

describe('activity → mode: the mapping that replaced the mode picker', () => {
  it('resolves every activity to a mode the engine actually implements', () => {
    // The engine registry (engine.ts definitionFor) knows these three; anything
    // else silently falls through to the interview pipeline, which is exactly
    // the bug this list exists to prevent.
    const implemented = ['interview', 'meeting', 'companion'];
    for (const kind of ACTIVITY_ORDER) {
      expect(implemented, kind).toContain(ACTIVITIES[kind].mode);
    }
  });

  it('sends the assessed framing to interviews ONLY', () => {
    // Interview framing tells the answer prompt the user is being judged. Any
    // other activity inheriting it is the shipped bug this whole change undoes.
    expect(modeFor('job')).toBe('interview');
    for (const kind of ACTIVITY_ORDER.filter((k) => k !== 'job')) {
      expect(modeFor(kind), kind).not.toBe('interview');
    }
  });

  it('asks for a résumé for interviews ONLY', () => {
    // You should not have to upload a CV to sit in on your own standup.
    expect(ACTIVITIES.job.needsResume).toBe(true);
    for (const kind of ACTIVITY_ORDER.filter((k) => k !== 'job')) {
      expect(ACTIVITIES[kind].needsResume, kind).toBe(false);
    }
  });

  it('listens to the microphone exactly when there is no one else on the call', () => {
    const mic = ACTIVITY_ORDER.filter((k) => ACTIVITIES[k].listensTo === 'mic');
    expect(mic.sort()).toEqual(['game', 'solo']);
  });

  it('offers a startable activity by default', () => {
    expect(startableActivities()).toContain(DEFAULT_ACTIVITY);
  });
});

describe('flag gating', () => {
  it('offers only activities whose mode is built', () => {
    for (const kind of startableActivities()) {
      expect(modeEnabled(ACTIVITIES[kind].mode), kind).toBe(true);
    }
    // A gated activity is DROPPED, not downgraded into a different mode:
    // starting a standup as an interview is worse than not starting it.
    const dropped = ACTIVITY_ORDER.filter((k) => !startableActivities().includes(k));
    for (const kind of dropped) {
      expect(modeEnabled(ACTIVITIES[kind].mode), kind).toBe(false);
    }
  });

  it('reads each mode gate from flags.ts, not a hardcoded list', () => {
    expect(modeEnabled('meeting')).toBe(FLAGS.meeting);
    expect(modeEnabled('companion')).toBe(FLAGS.companion);
    expect(modeEnabled('tutor')).toBe(FLAGS.tutor);
    expect(modeEnabled('interviewer_assist')).toBe(FLAGS.interviewerAssist);
    // Interview and practice have shipped since v1 and have no gate.
    expect(modeEnabled('interview')).toBe(true);
    expect(modeEnabled('practice')).toBe(true);
  });
});
