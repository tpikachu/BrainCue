import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the DB-backed settings repo so importing models.ts doesn't pull in
// better-sqlite3 (which is built for Electron's ABI and can't load under node).
// A mutable `state` lets each test drive the "stored" preset/overrides.
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

import {
  PRESETS,
  defaultModels,
  model,
  modelPreset,
  presetModels,
  reasoningEffort,
  isReasoningModel,
  reasoningParam,
} from './models';

beforeEach(() => {
  state.preset = null;
  state.models = {};
  state.efforts = {};
});

describe('modelPreset()', () => {
  it('defaults to balanced when unset', () => {
    expect(modelPreset()).toBe('balanced');
  });
  it('returns a valid stored preset', () => {
    state.preset = 'low_cost';
    expect(modelPreset()).toBe('low_cost');
    state.preset = 'best';
    expect(modelPreset()).toBe('best');
  });
  it('falls back to balanced for an unknown value', () => {
    state.preset = 'turbo'; // not a real preset
    expect(modelPreset()).toBe('balanced');
  });
});

describe('presetModels() / PRESETS', () => {
  it('every preset defines the same task keys', () => {
    const keys = Object.keys(PRESETS.balanced).sort();
    expect(Object.keys(PRESETS.low_cost).sort()).toEqual(keys);
    expect(Object.keys(PRESETS.best).sort()).toEqual(keys);
  });
  it('keeps the live paths (answer/classify) on NON-reasoning models in every preset', () => {
    for (const p of [PRESETS.balanced, PRESETS.low_cost, PRESETS.best]) {
      expect(isReasoningModel(p.answer)).toBe(false);
      expect(isReasoningModel(p.classify)).toBe(false);
    }
  });
  it('uses a reasoning model for the coding solver in every preset', () => {
    for (const p of [PRESETS.balanced, PRESETS.low_cost, PRESETS.best]) {
      expect(isReasoningModel(p.coding)).toBe(true);
    }
  });
  it('reflects the active preset', () => {
    expect(presetModels()).toEqual(PRESETS.balanced);
    state.preset = 'best';
    expect(presetModels()).toEqual(PRESETS.best);
  });
  it('defaultModels is the balanced table', () => {
    expect(defaultModels).toEqual(PRESETS.balanced);
  });
});

describe('model() resolution order', () => {
  it('uses the active preset when there is no override', () => {
    state.preset = 'best';
    expect(model('answer')).toBe(PRESETS.best.answer);
  });
  it('a per-task override wins over the preset', () => {
    state.preset = 'balanced';
    state.models = { answer: 'gpt-4o' };
    expect(model('answer')).toBe('gpt-4o');
    expect(model('classify')).toBe(PRESETS.balanced.classify); // untouched key still preset
  });
  it('ignores an empty-string override (falls back to preset)', () => {
    state.models = { coding: '' };
    expect(model('coding')).toBe(PRESETS.balanced.coding);
  });
});

describe('isReasoningModel()', () => {
  it('flags GPT-5 and o-series', () => {
    for (const id of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'GPT-5-MINI', 'o4-mini', 'o3']) {
      expect(isReasoningModel(id)).toBe(true);
    }
  });
  it('does not flag the gpt-4.1 / gpt-4o / embedding families', () => {
    for (const id of ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small']) {
      expect(isReasoningModel(id)).toBe(false);
    }
  });
});

describe('reasoningEffort()', () => {
  it('coding defaults to low', () => {
    expect(reasoningEffort('coding')).toBe('low');
  });
  it('non-coding tasks have no default effort', () => {
    expect(reasoningEffort('answer')).toBeNull();
  });
  it('a stored override wins over the default', () => {
    state.efforts = { coding: 'high' };
    expect(reasoningEffort('coding')).toBe('high');
  });
});

describe('reasoningParam()', () => {
  it('attaches effort for a reasoning coding model (default gpt-5-mini @ low)', () => {
    expect(reasoningParam('coding')).toEqual({ reasoning: { effort: 'low' } });
  });
  it('is EMPTY when the coding model is overridden to a non-reasoning model', () => {
    state.models = { coding: 'gpt-4.1' };
    expect(reasoningParam('coding')).toEqual({});
  });
  it('is empty for tasks with no configured effort even on a reasoning model', () => {
    state.preset = 'best'; // answer = full gpt-4.1 (non-reasoning) — still empty
    expect(reasoningParam('answer')).toEqual({});
  });
  it('respects an effort override on a reasoning model', () => {
    state.efforts = { coding: 'high' };
    expect(reasoningParam('coding')).toEqual({ reasoning: { effort: 'high' } });
  });
});
