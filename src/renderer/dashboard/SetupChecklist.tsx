import { Link } from 'react-router-dom';
import { useSettingsStore } from '../store/useSettingsStore';
import { useOnboardingStore } from '../store/useOnboardingStore';
import { Card } from '../components/ui';
import { useSttModels } from './pages/settings/LocalModelList';
import { StatusDot } from './onboarding/Onboarding';
import { setupComplete, setupRows } from './setupChecklistState';

/**
 * Home's "Finish setup" card — the reminder behind every "Later" in the
 * onboarding flow. Shown while a live session could not start (no way to
 * hear, or no OpenAI key); gone the moment both are ready. Each row says what
 * is configured and links to the Settings section that fixes it; "Resume
 * setup" reopens the flow at Transcription, the first optional step.
 */
export function SetupChecklist() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings || setupComplete(settings)) return null;
  return <SetupChecklistCard />;
}

function SetupChecklistCard() {
  const settings = useSettingsStore((s) => s.settings)!;
  const openAt = useOnboardingStore((s) => s.openAt);
  const models = useSttModels();
  const rows = setupRows({
    stt: settings.stt,
    sttReady: settings.sttReady,
    apiKeyPresent: settings.apiKeyPresent,
    providerKeys: settings.providerKeys,
    models: models.statuses,
    live: models.live,
  });

  return (
    <Card className="mb-4 border-amber-500/20 bg-amber-500/5" data-tour="setup-checklist">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-amber-200">Finish setup</h3>
        <button
          type="button"
          onClick={() => openAt('transcription')}
          className="text-xs text-amber-300 hover:underline"
        >
          Resume setup →
        </button>
      </div>
      <ul className="divide-y divide-white/5">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 py-2.5">
            <StatusDot status={r.status} />
            <span className="w-24 shrink-0 text-sm font-medium text-neutral-200">{r.label}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-neutral-400">{r.detail}</span>
            <Link
              to={r.route}
              className="shrink-0 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 ring-1 ring-white/5 transition-colors hover:bg-neutral-700"
            >
              {r.action}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
