import type { AppSettings } from '@shared/types';
import { cloudProvider } from '@shared/providers';
import { Dropdown } from '../../components/ui';
import { api } from '../../lib/api';
import { ctrlSelect } from '../lib/style';
import {
  addKeyProvider,
  currentModel,
  modelLabel,
  overrideFor,
  parseModelId,
  taskPickerRows,
  TASK_NAME,
  type PickerTask,
} from '../../lib/modelChoice';

/**
 * The Cue Card's model chip — "INTERVIEW ANSWERS  Claude Sonnet 5.5 ▾" — for
 * ONE named task (the caller decides via `task`). The closed chip names the
 * model the NEXT request for that task goes to (main's effective route, so a
 * fallback or another provider's pick is never hidden behind an override or
 * the OpenAI preset table). Its first row, Automatic, clears the override.
 * The model that produced an existing answer is on that answer's card.
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
  /** A qualified model id, or null for Automatic (clear the override). */
  onPick: (value: string | null) => void;
}) {
  const next = currentModel(settings, task);
  const value = overrideFor(settings, task);
  const notice = settings?.modelNotices?.[task];
  const rows = taskPickerRows(task, settings, {
    addKeyDisabled: false,
    addKeyTitle: 'Opens Settings → Language Models',
  });
  const name = TASK_NAME[task];
  const provider = next ? (cloudProvider(parseModelId(next).provider)?.name ?? parseModelId(next).provider) : '';
  // Details on hover, not in the bar: which provider, whose choice, and why
  // it differs from the override when it does.
  const detail = next
    ? `${name}: the next ${task === 'coding' ? 'solve' : 'answer'} uses ${provider} · ${modelLabel(next)} (${value ? 'your choice' : 'automatic'}).${notice ? ` ${notice}` : ''}`
    : name;
  return (
    <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500" title={detail} data-model-task={task}>
      {name}
      <Dropdown
        value={value}
        options={rows}
        disabled={!settings}
        ariaLabel={`${name} model`}
        buttonLabel={next ? `${notice ? '⚠ ' : ''}${modelLabel(next)}` : '…'}
        buttonClassName={`flex max-w-[11rem] items-center gap-1 ${ctrlSelect}`}
        onChange={(v) => {
          if (addKeyProvider(v)) {
            void api.window.openDashboard('/settings/models');
            return;
          }
          if (v === value) return;
          onPick(v || null);
        }}
      />
    </span>
  );
}
