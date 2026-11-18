import type { KeepStep, RememberResult } from '@shared/types';

/**
 * The save prompt's words (docs/16-CONTINUITY.md §9) — what Keep WILL do,
 * before it is pressed, and what it DID, after. Pure, so every outcome is
 * tested; never inferred from a zero count. Two things are kept apart: the
 * transcript, which is already on this machine and stays there, and the
 * summary / memory suggestions, which are made by sending the transcript to
 * the parsing provider.
 */

export type Tone = 'ok' | 'muted' | 'error';

/** " (why)" — without the error's own full stop, which the sentence supplies. */
const why = (error?: string) => (error ? ` (${error.trim().replace(/\.$/, '')})` : '');
export interface Line {
  tone: Tone;
  text: string;
}

/** What Keep would do, for the destination chosen right now. */
export function keepPreview(p: {
  /** A Space is chosen. */
  space: { title: string; remembers: boolean } | null;
  /** Settings › conversation summaries (default on). */
  archiveOn: boolean;
  /** Settings › memory suggestions (consent; default off). */
  memoryOn: boolean;
  /** A rehearsal is never summarised. */
  practice: boolean;
  /** Who summarises (the parsing route), by display name. */
  provider: string | null;
}): Line[] {
  const lines: Line[] = [{ tone: 'ok', text: 'The transcript stays on this machine, readable in Sessions.' }];
  if (!p.space) {
    lines.push({ tone: 'muted', text: 'No Space: nothing is summarised or suggested, and nothing is sent anywhere.' });
    return lines;
  }
  if (!p.space.remembers) {
    lines.push({ tone: 'muted', text: `“${p.space.title}” has remembering turned off: nothing is summarised or sent.` });
    return lines;
  }
  const summarise = p.archiveOn && !p.practice;
  const doing = [summarise ? 'a short summary' : null, p.memoryOn ? 'memory suggestions for you to review' : null].filter(Boolean);
  if (doing.length === 0) {
    lines.push({
      tone: 'muted',
      text: p.practice
        ? 'Practice is not summarised, and memory suggestions are off — nothing is sent.'
        : 'Summaries and memory suggestions are both off in Settings — nothing is sent.',
    });
    return lines;
  }
  const to = p.provider ? ` to ${p.provider}` : ' to your AI provider';
  lines.push({
    tone: 'ok',
    text: `The transcript is sent${to} to make ${doing.join(' and ')}, filed into “${p.space.title}”.`,
  });
  if (summarise && !p.memoryOn) lines.push({ tone: 'muted', text: 'Memory suggestions are off (Settings › Memory).' });
  if (!summarise) {
    lines.push({
      tone: 'muted',
      text: p.practice ? 'Practice is not summarised.' : 'Conversation summaries are off (Settings › Memory).',
    });
  }
  return lines;
}

const SUMMARY: Record<KeepStep['status'], (s: KeepStep, ctx: Ctx) => Line> = {
  done: (_s, c) => ({
    tone: 'ok',
    text: `Summary saved to “${c.space ?? 'the Space'}”${c.provider ? ` (made by ${c.provider})` : ''} — the next conversation there starts from it.`,
  }),
  'nothing-new': () => ({ tone: 'muted', text: 'Nothing to summarise.' }),
  off: () => ({ tone: 'muted', text: 'Summary: off in Settings — nothing was sent.' }),
  'space-off': (_s, c) => ({ tone: 'muted', text: `Summary: “${c.space ?? 'this Space'}” has remembering turned off — nothing was sent.` }),
  'no-space': () => ({ tone: 'muted', text: 'No Space, so nothing was summarised or sent.' }),
  practice: () => ({ tone: 'muted', text: 'Practice sessions are not summarised.' }),
  'too-short': () => ({ tone: 'muted', text: 'Too little was said to summarise — nothing was sent.' }),
  withheld: () => ({ tone: 'muted', text: 'The summary repeated something sensitive, so it was not saved.' }),
  failed: (s) => ({ tone: 'error', text: `The summary failed${why(s.error)}.` }),
};

const MEMORY: Record<KeepStep['status'], (s: KeepStep, ctx: Ctx) => Line> = {
  done: (s) => ({
    tone: 'ok',
    text: `${s.count} memory suggestion${s.count === 1 ? '' : 's'} waiting for your review in Memory — nothing is remembered until you approve it.`,
  }),
  'nothing-new': () => ({ tone: 'muted', text: 'No new memory suggestions.' }),
  off: () => ({ tone: 'muted', text: 'Memory suggestions are off (Settings › Memory).' }),
  'space-off': () => ({ tone: 'muted', text: 'No memory suggestions: this Space has remembering turned off.' }),
  'no-space': () => ({ tone: 'muted', text: 'No memory suggestions without a Space.' }),
  practice: () => ({ tone: 'muted', text: 'No memory suggestions from practice.' }),
  'too-short': () => ({ tone: 'muted', text: 'Too little was said for memory suggestions.' }),
  withheld: () => ({ tone: 'muted', text: 'Memory suggestions were withheld as sensitive.' }),
  failed: (s) => ({ tone: 'error', text: `Memory suggestions failed${why(s.error)}.` }),
};

interface Ctx {
  space: string | null;
  provider: string | null;
}

/** What Keep did, line by line, and whether a retry makes sense. */
export function keepResult(r: RememberResult, ctx: Ctx): { lines: Line[]; failed: boolean } {
  const lines: Line[] = [{ tone: 'ok', text: 'Kept — the transcript is on this machine, readable in Sessions.' }];
  const noSpace = r.summary.status === 'no-space' && r.memory.status === 'no-space';
  if (noSpace) {
    lines.push(SUMMARY['no-space'](r.summary, ctx));
  } else {
    lines.push(SUMMARY[r.summary.status](r.summary, ctx));
    // Memory off is worth one line; repeating "no Space"/"opted out" is not.
    if (!(r.memory.status === r.summary.status && r.memory.status !== 'done' && r.memory.status !== 'failed')) {
      lines.push(MEMORY[r.memory.status](r.memory, ctx));
    }
  }
  const failed = r.summary.status === 'failed' || r.memory.status === 'failed';
  if (failed) lines.push({ tone: 'muted', text: 'The transcript is kept either way. Retry now, or close and keep it as it is.' });
  return { lines, failed };
}
