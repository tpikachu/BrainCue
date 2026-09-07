import { SETTINGS_KEYS, settingsRepo } from '../../db/repositories/settings.repo';
import { DEFAULT_STT_PREFS, localSttModel, type SttPrefs } from '@shared/stt';

/**
 * The persisted engine + model choice. Lives apart from index.ts so the local
 * provider can read prefs without importing the module that registers it.
 */

export function readSttPrefs(): SttPrefs {
  const stored = settingsRepo.getJson<Partial<SttPrefs>>(SETTINGS_KEYS.sttPrefs, {});
  const engine = stored.engine === 'local' ? 'local' : 'cloud';
  const localModelId =
    stored.localModelId && localSttModel(stored.localModelId)
      ? stored.localModelId
      : DEFAULT_STT_PREFS.localModelId;
  return { engine, localModelId };
}

export function writeSttPrefs(prefs: SttPrefs): void {
  settingsRepo.setJson(SETTINGS_KEYS.sttPrefs, prefs);
}
