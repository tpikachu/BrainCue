import type { AppSettings, InterviewType } from '@shared/types';
import {
  CLOUD_PROVIDERS,
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

/** The two tasks the Cue Card chip can control: the coding solver in a coding
 *  interview, the live cue everywhere else. */
export type PickerTask = 'answer' | 'coding';

/** Which task the Cue Card's picker controls for this session. */
export function pickerTask(interviewType: InterviewType | null | undefined): PickerTask {
  return interviewType === 'coding' ? 'coding' : 'answer';
}

/** The effective model for a task: the user's override, else the preset default. */
export function currentModel(
  settings: Pick<AppSettings, 'models' | 'modelDefaults'> | null | undefined,
  task: string,
): string {
  if (!settings) return '';
  return settings.models?.[task] ?? settings.modelDefaults?.[task] ?? '';
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
