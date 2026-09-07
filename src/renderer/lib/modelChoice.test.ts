import { describe, expect, it } from 'vitest';
import {
  ADD_KEY_PREFIX,
  addKeyProvider,
  currentModel,
  modelGroupsFor,
  pickerRows,
  pickerTask,
  withModel,
} from './modelChoice';

const keys = { openai: true, anthropic: true, google: false, groq: false, openrouter: false };

describe('the Cue Card picker task', () => {
  it('controls the coding solver in a coding interview and the live cue otherwise', () => {
    expect(pickerTask('coding')).toBe('coding');
    expect(pickerTask('technical')).toBe('answer');
    expect(pickerTask('general')).toBe('answer');
    expect(pickerTask(null)).toBe('answer');
  });

  it('reads the override first, then the preset default', () => {
    const s = { models: { coding: 'anthropic/claude-opus-5' }, modelDefaults: { coding: 'gpt-5-mini', answer: 'gpt-4.1-mini' } };
    expect(currentModel(s, 'coding')).toBe('anthropic/claude-opus-5');
    expect(currentModel(s, 'answer')).toBe('gpt-4.1-mini');
    expect(currentModel(null, 'answer')).toBe('');
  });
});

describe('grouping the catalog per task', () => {
  it('offers EVERY catalog model of a provider for every task, recommended ones first', () => {
    const groups = modelGroupsFor('coding', keys);
    const openai = groups.find((g) => g.provider === 'openai')!;
    // Recommended for coding lead, then the rest of the OpenAI catalog in order.
    expect(openai.models.slice(0, 2).map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(openai.models.slice(0, 2).every((m) => m.recommended)).toBe(true);
    expect(openai.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5-nano']),
    );
    expect(openai.models.find((m) => m.id === 'gpt-4.1-nano')!.recommended).toBe(false);
    const anthropic = groups.find((g) => g.provider === 'anthropic')!;
    expect(anthropic.models[0].id).toBe('claude-fable-5-1');
    // Haiku is not a coding recommendation, but a paying user may still pick it.
    expect(anthropic.models.map((m) => m.id)).toContain('claude-haiku-4-5');
    expect(anthropic.models.at(-1)!.id).toBe('claude-haiku-4-5');
  });

  it('merges the models a key can see under the catalog, for keyed providers only', () => {
    const account = { openai: ['gpt-4.1', 'o4-mini', 'gpt-5.5-preview'], google: ['gemini-3-pro'] };
    const groups = modelGroupsFor('answer', keys, undefined, account);
    const openai = groups.find((g) => g.provider === 'openai')!;
    const ids = openai.models.map((m) => m.id);
    expect(ids.filter((id) => id === 'gpt-4.1')).toHaveLength(1); // catalog wins, no duplicate
    expect(ids.slice(-2)).toEqual(['o4-mini', 'gpt-5.5-preview']); // account rows last
    expect(openai.models.at(-1)).toMatchObject({ name: 'gpt-5.5-preview', fromAccount: true, recommended: false });
    // No Google key: its account list is ignored (and the group still says "Add key").
    const google = groups.find((g) => g.provider === 'google')!;
    expect(google.models.map((m) => m.id)).not.toContain('gemini-3-pro');
  });

  it('lists every chat provider, flagging which ones have a key', () => {
    const groups = modelGroupsFor('answer', keys);
    expect(groups.map((g) => g.provider)).toEqual(['openai', 'anthropic', 'google', 'groq', 'openrouter']);
    expect(groups.find((g) => g.provider === 'google')!.hasKey).toBe(false);
    expect(groups.find((g) => g.provider === 'anthropic')!.hasKey).toBe(true);
  });

  it('keeps the current selection visible even outside the catalog', () => {
    // A catalog model stays in its catalog place (not duplicated to the top)…
    const g1 = modelGroupsFor('coding', keys, 'gpt-4.1').find((g) => g.provider === 'openai')!;
    expect(g1.models.filter((m) => m.id === 'gpt-4.1')).toHaveLength(1);
    expect(g1.models.find((m) => m.id === 'gpt-4.1')!.name).toBe('GPT-4.1'); // catalog name, not the raw id
    // …and a free-typed OpenRouter id nobody catalogued.
    const g2 = modelGroupsFor('answer', keys, 'openrouter/mistralai/mistral-large').find(
      (g) => g.provider === 'openrouter',
    )!;
    expect(g2.models[0]).toMatchObject({ id: 'mistralai/mistral-large', name: 'mistralai/mistral-large' });
  });
});

describe('the rows a dropdown renders', () => {
  it('flags recommended rows in the description and lists account models after the catalog', () => {
    const rows = pickerRows('answer', keys, '', { addKeyDisabled: true }, { openai: ['o4-mini'] });
    const openai = rows.filter((r) => r.group === 'OpenAI');
    expect(openai[0].description).toMatch(/^★ Recommended · /);
    expect(openai.find((r) => r.value === 'gpt-5')!.description).not.toMatch(/Recommended/);
    expect(openai.at(-1)).toMatchObject({ value: 'o4-mini', label: 'o4-mini', description: 'From your account' });
  });

  it('stores qualified ids — bare for OpenAI, provider-prefixed otherwise', () => {
    const rows = pickerRows('coding', keys, 'gpt-5-mini', { addKeyDisabled: true });
    expect(rows.find((r) => r.label === 'GPT-5')!.value).toBe('gpt-5');
    expect(rows.find((r) => r.label === 'Claude Opus 5')!.value).toBe('anthropic/claude-opus-5');
  });

  it('replaces a keyless provider’s models with one "Add key" row', () => {
    const rows = pickerRows('answer', keys, 'gpt-4.1-mini', { addKeyDisabled: true, addKeyTitle: 'Add a key in Settings' });
    const google = rows.filter((r) => r.group === 'Google Gemini');
    expect(google).toHaveLength(1);
    expect(google[0]).toMatchObject({ value: `${ADD_KEY_PREFIX}google`, disabled: true, title: 'Add a key in Settings' });
    expect(addKeyProvider(google[0].value)).toBe('google');
    expect(addKeyProvider('gpt-5')).toBeNull();
    // The dashboard variant is clickable and says what it unlocks.
    const dash = pickerRows('answer', keys, '', { addKeyDisabled: false }).find((r) => r.value === `${ADD_KEY_PREFIX}groq`)!;
    expect(dash.disabled).toBe(false);
    expect(dash.description).toMatch(/Groq/);
  });

  it('still shows the running model when its provider has no key', () => {
    const rows = pickerRows('answer', { openai: false }, 'gpt-4.1-mini', { addKeyDisabled: true });
    const openai = rows.filter((r) => r.group === 'OpenAI');
    expect(openai.map((r) => r.label)).toEqual(['GPT-4.1 Mini', '🔑 Add key']);
  });
});

describe('selecting a model', () => {
  it('writes the qualified id into the override map without touching other tasks', () => {
    const next = withModel({ answer: 'gpt-4.1' }, 'coding', 'anthropic', 'claude-fable-5-1');
    expect(next).toEqual({ answer: 'gpt-4.1', coding: 'anthropic/claude-fable-5-1' });
    expect(withModel(undefined, 'answer', 'openai', 'gpt-4.1-mini')).toEqual({ answer: 'gpt-4.1-mini' });
  });
});
