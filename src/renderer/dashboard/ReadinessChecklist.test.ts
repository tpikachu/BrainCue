import { describe, expect, it } from 'vitest';
import { EDIT_ROLE, checklistRows } from './ReadinessChecklist';
import type { Job, Profile, Readiness } from '@shared/types';

/** Main's readiness for a user with an Anthropic key and on-device transcription — no OpenAI key. */
const ready: Readiness = {
  chat: {
    ready: true,
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    classifyModel: 'claude-haiku-5-5',
    explanation: 'Anthropic · Claude Sonnet 5.5 — Balanced picks fast first token with stronger answers.',
  },
  transcription: { ready: true, engine: 'local' },
  retrieval: { ready: true, mode: 'embeddings' },
  routes: { answer: 'anthropic', classify: 'anthropic', parsing: 'anthropic' },
  features: { parsing: { ready: true }, mock: { ready: false }, sparring: { ready: false }, tailoring: { ready: false } },
};
const profile = { id: 'p1', name: 'Jordan Lee', parsedResume: { skills: [] }, resumeText: 'x' } as unknown as Profile;
const space = { id: 'j1', title: 'Senior engineer', company: 'Acme', parsedJd: { requirements: [] }, jdText: 'jd' } as unknown as Job;

const rows = (over: Partial<Parameters<typeof checklistRows>[0]> = {}) =>
  checklistRows({ profile, space, interview: true, listensTo: 'system', readiness: ready, hasMic: true, ...over });

describe('the interview setup summary', () => {
  it('is four short rows — résumé, role & JD, audio, AI — all ready for Anthropic + on-device', () => {
    const r = rows();
    expect(r.map((x) => x.label)).toEqual(['Résumé', 'Role & JD', 'Audio', 'AI']);
    expect(r.every((x) => x.state.tone === 'ok')).toBe(true);
    expect(r.map((x) => x.state.text)).toEqual([
      'Jordan Lee',
      'Senior engineer · Acme',
      'call + your mic · on-device transcription',
      'Anthropic · Claude Sonnet 5.5', // the why is hover detail, not form text
    ]);
    for (const x of r) expect(x.state.text.length).toBeLessThan(60);
  });

  it('every gap names its fix — the missing pieces come from main readiness', () => {
    const r = rows({
      profile: { ...profile, parsedResume: null, resumeText: '' } as unknown as Profile,
      space: undefined,
      readiness: {
        ...ready,
        chat: {
          ...ready.chat,
          ready: false,
          problem: 'Anthropic is selected for answers but has no API key.',
          action: 'Add its key…',
          blocked: [{ task: 'answer', provider: 'anthropic', override: false }],
        },
        transcription: { ready: false, engine: 'cloud', problem: 'Cloud transcription needs an OpenAI key, and none is stored.' },
      },
    });
    expect(r.map((x) => x.state.tone)).toEqual(['block', 'block', 'block', 'block']);
    expect(r[0].state.action?.to).toBe('/profiles/p1');
    expect(r[1].state.action).toBeUndefined(); // the role picker above IS the fix — no second link
    // A few words on the row (it must fit), main's full sentence and fix on hover.
    expect(r[2].state).toMatchObject({ text: 'cloud transcription needs an OpenAI key', action: { to: '/settings/speech' } });
    expect(r[2].state.detail).toMatch(/none is stored/);
    expect(r[3].state).toMatchObject({ text: 'no Anthropic key (answers)', action: { to: '/settings/models' } });
    // The fix is on the form itself, not only in a hover title.
    expect(r[2].state.fix).toBeUndefined(); // (this fixture's transcription has no action)
    expect(r[3].state.fix).toBe('Add its key…');
    for (const x of r) expect(x.state.text.length).toBeLessThan(45);
  });

  it('no key at all, and an undownloaded on-device model, read as such', () => {
    const r = rows({
      readiness: {
        ...ready,
        chat: { ...ready.chat, ready: false, problem: 'No AI provider is set up — nothing can detect questions or write answers.' },
        transcription: { ready: false, engine: 'local', problem: 'The on-device transcription model is not downloaded yet.' },
      },
    });
    expect(r[2].state.text).toBe('on-device model not downloaded');
    expect(r[3].state.text).toBe('no AI provider key yet');
  });

  it('a keyless CLASSIFY override names that provider and task — not the healthy answer provider', () => {
    // As main reports it: OpenAI answers fine; question detection is pinned
    // to Anthropic, which has no key.
    const r = rows({
      readiness: {
        ...ready,
        chat: {
          ...ready.chat,
          ready: false,
          provider: 'openai',
          problem: 'Your question detection override uses Anthropic, which has no API key.',
          action: 'Add that key, or clear the override, in Settings → Language Models → Advanced.',
          blocked: [{ task: 'classify', provider: 'anthropic', override: true }],
        },
      },
    });
    expect(r[3].state.text).toBe('no Anthropic key (question detection)');
    expect(r[3].state.text).not.toMatch(/OpenAI/);
    expect(r[3].state.fix).toBe('Add that key, or clear the override, in Settings → Language Models → Advanced.');
  });

  it('a role without a job description opens that role in place to add one', () => {
    const r = rows({ space: { ...space, parsedJd: null, jdText: '' } as unknown as Job });
    expect(r[1].state).toMatchObject({ tone: 'warn', action: { label: 'Add JD', to: EDIT_ROLE } });
  });

  it('no role: points at the picker — or, resuming one whose role was deleted (no picker), says so', () => {
    expect(rows({ space: undefined })[1].state).toEqual({ tone: 'block', text: 'choose the role above' });
    expect(rows({ space: undefined, roleGone: true })[1].state).toEqual({ tone: 'block', text: 'deleted — start a new interview' });
  });

  it('keyword-only document matching is said on the AI row but does not block', () => {
    const r = rows({ readiness: { ...ready, retrieval: { ready: true, mode: 'lexical', note: 'No OpenAI key…' } } });
    expect(r[3].state).toMatchObject({ tone: 'ok', text: 'Anthropic · Claude Sonnet 5.5 · keyword document matching' });
  });

  it('while readiness is being read, rows say "checking", never ready or missing', () => {
    const r = rows({ readiness: null });
    expect(r[2].state).toMatchObject({ tone: 'warn', text: 'checking…' });
    expect(r[3].state).toMatchObject({ tone: 'warn', text: 'checking…' });
  });

  it('other activities show only audio and AI', () => {
    expect(rows({ interview: false }).map((x) => x.label)).toEqual(['Audio', 'AI']);
  });
});
