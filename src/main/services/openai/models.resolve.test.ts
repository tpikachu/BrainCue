import { describe, it, expect, beforeEach, vi } from 'vitest';

// Same DB stub as models.test.ts: a mutable `state` drives the stored
// preset / per-task overrides so importing models.ts never touches sqlite.
const state = vi.hoisted(() => ({
  preset: null as string | null,
  models: {} as Record<string, string>,
  efforts: {} as Record<string, string>,
}));

vi.mock('../../db/repositories/settings.repo', () => ({
  SETTINGS_KEYS: { modelPreset: 'model_preset', models: 'models', reasoningEfforts: 'reasoning_efforts' },
  settingsRepo: {
    get: (k: string) => (k === 'model_preset' ? state.preset : null),
    getJson: (k: string, fallback: unknown) =>
      k === 'models' ? state.models : k === 'reasoning_efforts' ? state.efforts : fallback,
  },
}));

import { PRESETS, model, reasoningEffort, reasoningEffortOverride, resolveModel } from './models';
import { taskProvider } from '../../providers/taskRoute';

beforeEach(() => {
  state.preset = null;
  state.models = {};
  state.efforts = {};
});

describe('resolveModel() — per-task provider + bare id', () => {
  it('a task with no override is the preset OpenAI model', () => {
    expect(resolveModel('answer')).toEqual({ provider: 'openai', model: PRESETS.balanced.answer });
    state.preset = 'best';
    expect(resolveModel('coding')).toEqual({ provider: 'openai', model: PRESETS.best.coding });
  });

  it('a bare override stays OpenAI (every pre-multi-provider setting resolves as before)', () => {
    state.models = { answer: 'gpt-4o' };
    expect(resolveModel('answer')).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('a qualified override routes to that provider with the bare vendor id', () => {
    state.models = {
      coding: 'anthropic/claude-fable-5-1',
      answer: 'google/gemini-2.5-flash',
      mock: 'groq/llama-3.3-70b-versatile',
    };
    expect(resolveModel('coding')).toEqual({ provider: 'anthropic', model: 'claude-fable-5-1' });
    expect(resolveModel('answer')).toEqual({ provider: 'google', model: 'gemini-2.5-flash' });
    expect(resolveModel('mock')).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
    expect(resolveModel('classify').provider).toBe('openai'); // untouched task stays preset
  });

  it('keeps OpenRouter ids (which contain their own slash) intact', () => {
    state.models = { coding: 'openrouter/openai/gpt-5', answer: 'openrouter/anthropic/claude-sonnet-5' };
    expect(resolveModel('coding')).toEqual({ provider: 'openrouter', model: 'openai/gpt-5' });
    expect(resolveModel('answer')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' });
  });

  it('only a KNOWN provider prefix is stripped — an unknown one is an OpenAI id verbatim', () => {
    state.models = { answer: 'acme/some-model', coding: 'ft:gpt-4.1:org::abc' };
    expect(resolveModel('answer')).toEqual({ provider: 'openai', model: 'acme/some-model' });
    expect(resolveModel('coding')).toEqual({ provider: 'openai', model: 'ft:gpt-4.1:org::abc' });
  });
});

describe('model() stays the BARE id for OpenAI callers', () => {
  it('strips the provider prefix of a qualified override', () => {
    state.models = { coding: 'anthropic/claude-opus-5' };
    expect(model('coding')).toBe('claude-opus-5');
  });
  it('is unchanged for bare overrides and presets', () => {
    state.models = { answer: 'gpt-4o' };
    expect(model('answer')).toBe('gpt-4o');
    expect(model('classify')).toBe(PRESETS.balanced.classify);
  });
});

describe('the task-route resolver is installed at load', () => {
  it('routing sees the same provider resolveModel does', () => {
    expect(taskProvider('coding')).toBe('openai');
    state.models = { coding: 'anthropic/claude-opus-5', tailor: 'openrouter/openai/gpt-5' };
    expect(taskProvider('coding')).toBe('anthropic');
    expect(taskProvider('tailor')).toBe('openrouter');
    expect(taskProvider('answer')).toBe('openai');
  });
});

describe('reasoningEffortOverride() — the user override alone', () => {
  it('is null when only the built-in default applies', () => {
    expect(reasoningEffort('coding')).toBe('low'); // built-in OpenAI default…
    expect(reasoningEffortOverride('coding')).toBeNull(); // …is not a user override
  });
  it('returns the stored value verbatim and keeps reasoningEffort() consistent', () => {
    state.efforts = { coding: 'high', tailor: 'minimal' };
    expect(reasoningEffortOverride('coding')).toBe('high');
    expect(reasoningEffort('coding')).toBe('high');
    expect(reasoningEffortOverride('tailor')).toBe('minimal');
  });
});
