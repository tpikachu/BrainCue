import type { AppSettings } from '@shared/types';
import type { CloudProviderId } from '@shared/providers';
import { Dropdown } from '../../components/ui';
import { api } from '../../lib/api';
import { ctrlSelect } from '../lib/style';
import {
  addKeyProvider,
  currentModel,
  modelLabel,
  parseModelId,
  pickerRows,
  type PickerTask,
} from '../../lib/modelChoice';

/**
 * The Cue Card's model chip — "GPT-5 Mini ▾" — opening the catalog grouped by
 * provider with one-line descriptions. It controls ONE task for this session:
 * the coding solver in a coding interview, the live cue otherwise (the caller
 * decides via `task`). Picking re-answers the current question, so it is a
 * per-question control in effect.
 *
 * Providers without a key show a "🔑 Add key" row that brings the dashboard
 * up on Settings → Language Models (`window:open-dashboard`, the same path the
 * tray menu uses) — the key itself is never typed into the overlay.
 *
 * Kit `Dropdown`, never a native `<select>`: the native popup is a separate OS
 * window that screen shares can see even in Privacy Mode.
 */
export function ModelChip({
  settings,
  task,
  onPick,
}: {
  settings: AppSettings | null;
  task: PickerTask;
  onPick: (provider: CloudProviderId, id: string) => void;
}) {
  const current = currentModel(settings, task);
  const rows = pickerRows(task, settings?.providerKeys, current, {
    addKeyDisabled: false,
    addKeyTitle: 'Opens Settings → Language Models',
  });
  return (
    <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
      {task === 'coding' ? 'Solver' : 'Model'}
      <Dropdown
        value={current}
        options={rows}
        disabled={!settings}
        buttonLabel={current ? modelLabel(current) : '…'}
        buttonClassName={`flex max-w-[11rem] items-center gap-1 ${ctrlSelect}`}
        onChange={(v) => {
          if (addKeyProvider(v)) {
            void api.window.openDashboard('/settings/models');
            return;
          }
          if (v === current) return;
          const { provider, model } = parseModelId(v);
          onPick(provider, model);
        }}
      />
    </span>
  );
}
