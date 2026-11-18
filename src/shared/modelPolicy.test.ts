import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, modelOption } from './providers';
import {
  POLICY_TASKS,
  PROVIDER_PLANS,
  defaultChatProvider,
  explainAnswerModel,
  presetToPreference,
  resolveChatTask,
  type ModelPreference,
} from './modelPolicy';

const openaiOnly = { openai: true };

describe('resolveChatTask — provider-aware defaults', () => {
  it('picks the preference’s first candidate on the chosen provider', () => {
    expect(resolveChatTask('answer', { provider: 'openai', preference: 'balanced', keys: openaiOnly })).toEqual({
      provider: 'openai',
      model: 'gpt-6-luna',
      source: 'policy',
    });
    expect(resolveChatTask('answer', { provider: 'openai', preference: 'quality', keys: openaiOnly }).model).toBe('gpt-6.1-terra');
  });

  it('defaults to a provider that HAS a key — an Anthropic-only user gets Claude, not an OpenAI error', () => {
    const r = resolveChatTask('answer', { provider: null, preference: 'fast', keys: { anthropic: true } });
    expect(r).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
  });

  it('a chosen provider without a key yields to one that has a key', () => {
    const r = resolveChatTask('classify', { provider: 'google', preference: 'balanced', keys: { groq: true } });
    expect(r.provider).toBe('groq');
  });

  it('only resolves to models the account serves (discovery filters the list)', () => {
    const r = resolveChatTask('classify', {
      provider: 'openai',
      preference: 'balanced',
      keys: openaiOnly,
      discovered: { openai: ['gpt-5-nano', 'gpt-4.1-mini'] }, // no gpt-6-luna on this account
    });
    expect(r).toMatchObject({ model: 'gpt-5-nano', source: 'fallback' });
    expect(r.notice).toMatch(/isn't available to your account/);
  });

  it('skips a model that failed as unavailable at runtime — same provider, next candidate', () => {
    const r = resolveChatTask('classify', {
      provider: 'openai',
      preference: 'balanced',
      keys: openaiOnly,
      unavailable: new Set(['gpt-6-luna']),
    });
    expect(r).toMatchObject({ provider: 'openai', model: 'gpt-5-nano' });
  });
});

describe('resolveChatTask — explicit overrides', () => {
  it('a valid override wins', () => {
    const r = resolveChatTask('answer', {
      provider: 'openai',
      preference: 'balanced',
      keys: { openai: true, anthropic: true },
      override: 'anthropic/claude-opus-5-5',
    });
    expect(r).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', source: 'override' });
  });

  it('an override the account cannot run is corrected, with the reason', () => {
    const r = resolveChatTask('classify', {
      provider: 'openai',
      preference: 'balanced',
      keys: openaiOnly,
      override: 'gpt-4.1-nano', // retired — not in the account's list
      discovered: { openai: ['gpt-6-luna', 'gpt-6.1-terra'] },
    });
    expect(r).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', source: 'fallback' });
    expect(r.notice).toMatch(/GPT-4\.1 Nano can't be used \(your account does not list it\)/);
  });

  it('an override for a provider without a key yields when another provider has one', () => {
    const r = resolveChatTask('answer', {
      provider: 'openai',
      preference: 'balanced',
      keys: openaiOnly,
      override: 'anthropic/claude-opus-5-5',
    });
    expect(r.provider).toBe('openai');
    expect(r.notice).toMatch(/Anthropic has no API key/);
  });

  it('with no key anywhere, the override is kept (its own error names the missing key)', () => {
    const r = resolveChatTask('answer', { provider: null, preference: 'balanced', keys: {}, override: 'anthropic/claude-opus-5-5' });
    expect(r).toMatchObject({ provider: 'anthropic', source: 'override' });
  });
});

describe('plans and catalog stay consistent', () => {
  it('every plan candidate is in the catalog with explicit metadata', () => {
    for (const [provider, prefs] of Object.entries(PROVIDER_PLANS)) {
      if (provider === 'openrouter') continue; // free-form, unverified suggestions
      for (const plan of Object.values(prefs)) {
        for (const t of POLICY_TASKS) {
          for (const id of plan[t]) {
            const opt = modelOption(provider as never, id);
            expect(opt, `${provider}/${id}`).toBeDefined();
            expect(opt?.status, `${provider}/${id} must not be retired`).not.toBe('retired');
          }
        }
      }
    }
  });

  it('every preference lists the preferred model first with a CURRENT model', () => {
    for (const [provider, prefs] of Object.entries(PROVIDER_PLANS)) {
      if (provider === 'openrouter') continue;
      for (const pref of ['fast', 'balanced', 'quality'] as ModelPreference[]) {
        for (const t of POLICY_TASKS) {
          const first = modelOption(provider as never, prefs[pref][t][0]);
          expect(first?.status ?? 'current', `${provider} ${pref} ${t}`).toBe('current');
        }
      }
    }
  });

  it('live tasks never default to a model that always reasons (latency)', () => {
    for (const [provider, prefs] of Object.entries(PROVIDER_PLANS)) {
      if (provider === 'openrouter' || provider === 'google' || provider === 'groq') continue; // no "off" exists there; lowest effort is sent
      for (const pref of ['fast', 'balanced'] as ModelPreference[]) {
        for (const t of ['classify', 'answer'] as const) {
          const opt = modelOption(provider as never, prefs[pref][t][0])!;
          const canSkip = !opt.reasoning || opt.efforts?.[0] === 'none' || opt.disableThinking || provider === 'anthropic';
          expect(canSkip, `${provider} ${pref} ${t} ${opt.id}`).toBe(true);
        }
      }
    }
  });

  it('the retired gpt-4.1-nano is catalogued as retired (overrides still display its name)', () => {
    expect(MODEL_CATALOG.find((m) => m.id === 'gpt-4.1-nano')?.status).toBe('retired');
  });
});

describe('helpers', () => {
  it('maps the legacy presets onto preferences', () => {
    expect(presetToPreference('low_cost')).toBe('fast');
    expect(presetToPreference('best')).toBe('quality');
    expect(presetToPreference(null)).toBe('balanced');
    expect(presetToPreference('quality')).toBe('quality');
  });

  it('default chat provider prefers OpenAI, then any configured provider, else none', () => {
    expect(defaultChatProvider({ openai: true, anthropic: true })).toBe('openai');
    expect(defaultChatProvider({ google: true })).toBe('google');
    expect(defaultChatProvider({})).toBeNull();
  });

  it('explains the answer model in one line', () => {
    const r = resolveChatTask('answer', { provider: 'anthropic', preference: 'fast', keys: { anthropic: true } });
    expect(explainAnswerModel(r, 'fast')).toBe('Anthropic · Claude Haiku 5.5 — Fast picks the lowest first-token latency.');
  });
});
