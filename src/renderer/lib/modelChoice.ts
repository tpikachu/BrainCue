import type { AnswerRoute, AppSettings } from '@shared/types';
import {
  CLOUD_PROVIDERS,
  cloudProvider,
  MODEL_CATALOG,
  modelLabel,
  modelOption,
  parseModelId,
  qualifyModel,
  type CloudProviderId,
  type ModelOption,
  type ModelUse,
} from '@shared/providers';

/**
 * Pure helpers behind every model picker in the renderer — the per-task table
 * in Settings → Language Models and the Cue Card's chip. Kept free of React and
 * of `api` so the selection rules are unit-testable and identical in both
 * windows: what the chip offers for a coding interview is exactly what the
 * Settings table offers for the `coding` row.
 */

/** The two tasks the Cue Card's chips control: `answer` (every spoken
 *  question, in every interview — coding included) and `coding` (the
 *  clipboard/screenshot solver). Each chip names its task (TASK_NAME). */
export type PickerTask = 'answer' | 'coding';

/** What each task's control is called, everywhere it appears. A coding-solver
 *  setting must never read as if it controlled the interview's answers. */
export const TASK_NAME: Record<PickerTask, string> = {
  answer: 'Interview answers',
  coding: 'Coding solver',
};

/**
 * The model the NEXT request for a task goes to: main's own resolution
 * (`effectiveModels` — an override when it can run, else the policy's pick
 * on the chosen provider, after any failover). The stored override and the
 * OpenAI preset table are only a fallback for a main that does not send it:
 * on their own they name a model that may not be the one that runs.
 */
export function currentModel(
  settings: Partial<Pick<AppSettings, 'models' | 'modelDefaults' | 'effectiveModels'>> | null | undefined,
  task: string,
): string {
  if (!settings) return '';
  return settings.effectiveModels?.[task] ?? settings.models?.[task] ?? settings.modelDefaults?.[task] ?? '';
}

/** A picker's value for "no per-task override". */
export const AUTOMATIC = '';

/** The stored override for a task, or AUTOMATIC. */
export function overrideFor(settings: Partial<Pick<AppSettings, 'models'>> | null | undefined, task: string): string {
  return settings?.models?.[task] ?? AUTOMATIC;
}

/** One task's picker: "Automatic — <the model it would use>" first (clears
 *  the override), then the grouped catalog. Shared by the Cue Card's chips
 *  and its settings, so both offer exactly the same choices. */
export function taskPickerRows(
  task: string,
  settings: Partial<Pick<AppSettings, 'models' | 'autoModels' | 'providerKeys'>> | null | undefined,
  opts: { addKeyDisabled: boolean; addKeyTitle?: string },
  account?: AccountModels,
): PickerRow[] {
  const auto = settings?.autoModels?.[task] ?? '';
  return [
    {
      value: AUTOMATIC,
      label: auto ? `Automatic — ${modelLabel(auto)}` : 'Automatic',
      description: 'Picked for your provider and preference',
    },
    ...pickerRows(task, settings?.providerKeys, overrideFor(settings, task), opts, account),
  ];
}

/** "Answered by Claude Sonnet 5.5", and the detail behind it: the provider,
 *  and any attempt that failed over before it. From the answer's own
 *  captured route — never from current settings. */
export function answeredByText(r: AnswerRoute): { label: string; detail: string } {
  const name = (p: string, m: string) => modelLabel(qualifyModel(p as CloudProviderId, m));
  const provider = cloudProvider(r.provider)?.name ?? r.provider;
  const failed = r.failed?.length
    ? ` Tried first: ${r.failed.map((f) => `${name(f.provider, f.model)} (${f.reason === 'model' ? 'not available' : 'network error'})`).join(', ')}.`
    : '';
  return { label: `Answered by ${name(r.provider, r.model)}`, detail: `${provider} · ${name(r.provider, r.model)}.${failed}` };
}

/** A catalog entry as the picker presents it for one task. */
export interface PickerModel extends ModelOption {
  /** The catalog marks it as a sensible pick for this task. */
  recommended: boolean;
  /** Listed by the vendor for this key but not described in the catalog. */
  fromAccount?: boolean;
}

export interface ModelGroup {
  provider: CloudProviderId;
  name: string;
  hasKey: boolean;
  keyUrl: string;
  models: PickerModel[];
}

/** Model ids each provider's key can see (`settings:list-provider-models`),
 *  merged under the catalog. Optional: the Cue Card's chip offers the catalog
 *  alone. */
export type AccountModels = Partial<Record<CloudProviderId, string[]>>;

/**
 * Models offered for `task`, grouped by provider in catalog order.
 *
 * EVERY chat model in the catalog is offered for every task — a user who has
 * paid for a key gets to choose Opus for the live cue or Haiku for the solver
 * if that is what they want. The catalog's `bestFor` only ORDERS the group:
 * recommended models first, flagged, the rest after. Below the catalog come
 * the models the vendor listed for this key that the catalog does not
 * describe (`account`), so nothing a key unlocks is hidden. Every
 * chat-capable provider is listed even without a key — the group then
 * carries an "Add key" affordance — so a user sees what a key would unlock
 * rather than a list that silently shrinks to OpenAI. The current selection
 * is always kept visible in its group, even when the catalog would not offer
 * it (a free-typed OpenRouter id), so the closed picker never shows a raw id
 * for something the user chose.
 */
export function modelGroupsFor(
  task: string,
  providerKeys: Partial<Record<CloudProviderId, boolean>> | null | undefined,
  current?: string,
  account?: AccountModels,
): ModelGroup[] {
  const cur = current ? parseModelId(current) : null;
  const use = task as ModelUse;
  return CLOUD_PROVIDERS.filter((p) => p.capabilities.includes('chat')).map((p) => {
    const hasKey = !!providerKeys?.[p.id];
    const catalog = MODEL_CATALOG.filter((m) => m.provider === p.id).map<PickerModel>((m) => ({
      ...m,
      recommended: m.bestFor.includes(use),
    }));
    // Stable partition: recommended first, catalog order within each half.
    const models = [...catalog.filter((m) => m.recommended), ...catalog.filter((m) => !m.recommended)];
    if (hasKey) {
      for (const id of account?.[p.id] ?? []) {
        if (models.some((m) => m.id === id)) continue;
        models.push({ id, provider: p.id, name: id, description: 'From your account', bestFor: [], recommended: false, fromAccount: true });
      }
    }
    if (cur && cur.provider === p.id && !models.some((m) => m.id === cur.model)) {
      models.unshift({
        ...(modelOption(p.id, cur.model) ?? {
          id: cur.model,
          provider: p.id,
          name: cur.model,
          description: 'Current selection',
          bestFor: [],
        }),
        recommended: false,
      });
    }
    return { provider: p.id, name: p.name, hasKey, keyUrl: p.keyUrl, models };
  });
}

/** The `models` override map with (provider, id) selected for `task`. */
export function withModel(
  models: Record<string, string> | null | undefined,
  task: string,
  provider: CloudProviderId,
  id: string,
): Record<string, string> {
  return { ...(models ?? {}), [task]: qualifyModel(provider, id) };
}

/** Value prefix of an "Add key" row. `addKeyProvider(value)` reads it back. */
export const ADD_KEY_PREFIX = 'add-key:';

export function addKeyProvider(value: string): CloudProviderId | null {
  return value.startsWith(ADD_KEY_PREFIX) ? (value.slice(ADD_KEY_PREFIX.length) as CloudProviderId) : null;
}

/** One row of a grouped picker — the shape the kit `Dropdown` renders. */
export interface PickerRow {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
  title?: string;
}

/** Marks a recommended row's description. */
export const RECOMMENDED_MARK = '★ Recommended';

/**
 * Flatten the groups into dropdown rows. Providers with a key list their
 * models (value = the qualified id that `AppSettings.models` stores); providers
 * without one get a single "Add key" row instead, enabled or disabled per the
 * surface — the dashboard can jump to the key field, the Cue Card cannot.
 */
export function pickerRows(
  task: string,
  providerKeys: Partial<Record<CloudProviderId, boolean>> | null | undefined,
  current: string,
  opts: { addKeyDisabled: boolean; addKeyTitle?: string },
  account?: AccountModels,
): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const g of modelGroupsFor(task, providerKeys, current, account)) {
    const cur = current ? parseModelId(current) : null;
    for (const m of g.models) {
      // Without a key only the current selection stays (it is what runs today);
      // the rest of that provider's catalog waits behind "Add key".
      if (!g.hasKey && !(cur && cur.provider === g.provider && cur.model === m.id)) continue;
      rows.push({
        value: qualifyModel(g.provider, m.id),
        label: m.name,
        description: m.recommended ? `${RECOMMENDED_MARK} · ${m.description}` : m.description,
        group: g.name,
      });
    }
    if (!g.hasKey) {
      rows.push({
        value: `${ADD_KEY_PREFIX}${g.provider}`,
        label: '🔑 Add key',
        description: opts.addKeyDisabled ? undefined : `Unlock ${g.name} models`,
        group: g.name,
        disabled: opts.addKeyDisabled,
        title: opts.addKeyTitle,
      });
    }
  }
  return rows;
}

export { modelLabel, parseModelId, qualifyModel };
