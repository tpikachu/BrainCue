import { apiKeyStore } from '../security/apiKey';
import { registerProvider, setProviderSelection } from '../../providers/registry';
import { log } from '../security/logger';
import { localRealtimeStt, warmLocalStt } from './localRealtimeStt';
import { installed } from './modelStore';
import { readSttPrefs } from './prefs';

export { readSttPrefs, writeSttPrefs } from './prefs';

/**
 * Speech-to-text engine selection (docs/06-OPENAI-SERVICE.md, docs/22-LOCAL-STT.md).
 *
 * The seam the rest of main talks to:
 *
 *  - `readSttPrefs()`      the persisted engine + model choice
 *  - `sttReady()`          can a live session transcribe right now?
 *  - `applySttSelection()` point the `realtimeStt` capability at the chosen
 *                          engine (call at startup and after every change)
 *
 * The local engine itself is modelStore.ts (disk), downloader.ts (network),
 * worker.ts (the sherpa-onnx utility process) and localRealtimeStt.ts (the
 * provider that drives it).
 */

/** True when the chosen local model has every file on disk at its pinned size. */
export function isLocalModelInstalled(modelId: string): boolean {
  return installed(modelId);
}

/** Whether a live session can transcribe with the current choice. */
export function sttReady(): boolean {
  const prefs = readSttPrefs();
  return prefs.engine === 'local' ? isLocalModelInstalled(prefs.localModelId) : apiKeyStore.isPresent();
}

let localRegistered = false;

/**
 * Select the realtimeStt provider that matches the prefs. `local` is chosen
 * only when its model is actually installed — a half-downloaded model falls
 * back to the cloud transcriber rather than a session that cannot start.
 */
export function applySttSelection(): void {
  if (!localRegistered) {
    registerProvider('local', 'realtimeStt', localRealtimeStt);
    localRegistered = true;
  }
  const prefs = readSttPrefs();
  const useLocal = prefs.engine === 'local' && isLocalModelInstalled(prefs.localModelId);
  setProviderSelection('realtimeStt', useLocal ? 'local' : 'openai');
  log.info(`stt engine: ${useLocal ? `local (${prefs.localModelId})` : 'cloud'}`);
  // Load the model now rather than during the first words of the next call.
  if (useLocal) warmLocalStt();
}
