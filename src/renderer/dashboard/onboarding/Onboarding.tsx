import type React from 'react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useProfileStore } from '../../store/useProfileStore';
import { useOnboardingStore } from '../../store/useOnboardingStore';
import { useTourStore } from '../../store/useTourStore';
import type { CloudProviderId } from '@shared/providers';
import type { SttEngine } from '@shared/stt';
import { Badge, Button, Card } from '../../components/ui';
import { Logo } from '../../components/Logo';
import { NewProfileForm } from '../NewProfileModal';
import { EngineRow } from '../pages/settings/SpeechPanel';
import { LocalModelList, useSttModels } from '../pages/settings/LocalModelList';
import { PresetPicker, ProviderKeyBlock, ProviderTiles } from '../pages/settings/ProviderSetup';
import { setupRows, type SetupStatus } from '../setupChecklistState';
import {
  ONBOARDING_STEPS,
  STEP_LABELS,
  canAdvance,
  canSkip,
  nextStep,
  prevStep,
  stepIndex,
} from './onboardingFlow';

/**
 * First-run setup (docs/11-UX-NAVIGATION.md "First run").
 *
 * Rendered by App IN PLACE of the sidebar and pages — under the title bar and
 * the download strip, which stay live so a model download started here is
 * visible while the rest of the flow continues. Not dismissable: there is no
 * dashboard behind it to go back to. The exit is the Done screen, which is
 * two "Later"s away from any step.
 *
 * Every control on steps 2 and 3 is the Settings control itself
 * (`EngineRow`, `LocalModelList`, `ProviderTiles`, `ProviderKeyBlock`,
 * `PresetPicker`) so what is chosen here reads identically in Settings →
 * Speech-to-Text / Language Models afterwards, and vice versa.
 */
export function Onboarding() {
  const { step, setStep, close } = useOnboardingStore();
  const { settings, load } = useSettingsStore();
  const profiles = useProfileStore((s) => s.profiles);
  const startTour = useTourStore((s) => s.start);
  const models = useSttModels();
  const [finishing, setFinishing] = useState(false);

  if (!settings) return null;
  const profileCount = profiles.length;
  const idx = stepIndex(step);

  const finish = async (tour: boolean) => {
    setFinishing(true);
    try {
      // "Skip tour" records both at once, so App's auto-start never sees
      // onboardingDone without tourDone in between.
      await api.settings.set(tour ? { onboardingDone: true } : { onboardingDone: true, tourDone: true });
      await load();
    } finally {
      setFinishing(false);
    }
    close();
    if (tour) startTour();
  };

  return (
    <div className="flex min-h-0 flex-1" role="dialog" aria-modal="true" aria-label="Set up BrainCue">
      <aside className="flex w-64 shrink-0 flex-col border-r border-white/5 bg-neutral-950/60 p-5">
        <div className="brand mb-8 flex items-center gap-2.5 px-1">
          <span className="logo-glow relative inline-flex">
            <Logo className="h-9 w-9" />
          </span>
          <div className="leading-tight">
            <h1 className="brand-gradient text-sm font-semibold tracking-tight">BrainCue</h1>
            <span className="text-[11px] text-neutral-500">First-run setup</span>
          </div>
        </div>
        <ol className="space-y-1" aria-label="Setup steps">
          {ONBOARDING_STEPS.map((s) => {
            const i = stepIndex(s);
            const state = i < idx ? 'done' : i === idx ? 'current' : 'upcoming';
            return (
              <li
                key={s}
                aria-current={state === 'current' ? 'step' : undefined}
                className={`relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                  state === 'current' ? 'bg-indigo-500/10 text-white' : state === 'done' ? 'text-neutral-300' : 'text-neutral-500'
                }`}
              >
                <span
                  className={`absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-indigo-400 ${
                    state === 'current' ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    state === 'done'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : state === 'current'
                        ? 'bg-indigo-500/30 text-indigo-100'
                        : 'border border-neutral-700 text-neutral-500'
                  }`}
                >
                  {state === 'done' ? '✓' : s === 'done' ? '★' : i + 1}
                </span>
                {STEP_LABELS[s].replace(/^\d+ · /, '')}
              </li>
            );
          })}
        </ol>
        <p className="mt-auto px-1 text-xs leading-relaxed text-neutral-500">
          Only the name is required. Anything you leave for later is listed on Home under
          “Finish setup” until it is done.
        </p>
      </aside>

      <main className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
          <div className="mx-auto max-w-2xl">
            {step === 'name' && (
              <NameStep profileCount={profileCount} onCreated={() => setStep('transcription')} />
            )}
            {step === 'transcription' && <TranscriptionStep models={models} />}
            {step === 'ai' && <AiStep />}
            {step === 'done' && <DoneStep models={models} />}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-white/5 bg-neutral-950/40 px-8 py-4">
          <div>
            {idx > 0 && step !== 'done' && (
              <Button variant="ghost" onClick={() => setStep(prevStep(step))}>
                Back
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step === 'done' ? (
              <>
                <Button variant="ghost" onClick={() => void finish(false)} disabled={finishing}>
                  Skip tour
                </Button>
                <Button variant="primary" onClick={() => void finish(true)} loading={finishing}>
                  Take the tour
                </Button>
              </>
            ) : (
              <>
                {canSkip(step) && (
                  <Button variant="ghost" onClick={() => setStep(nextStep(step))}>
                    Later
                  </Button>
                )}
                {/* The name step advances from its own form ("Get started"). */}
                {step !== 'name' && (
                  <Button
                    variant="primary"
                    disabled={!canAdvance(step, { profileCount })}
                    onClick={() => setStep(nextStep(step))}
                  >
                    Continue
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function StepHeading({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-xl font-semibold tracking-tight text-neutral-100">{title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">{children}</p>
    </div>
  );
}

function NameStep({ profileCount, onCreated }: { profileCount: number; onCreated: () => void }) {
  const profile = useProfileStore((s) => s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0]);
  const setStep = useOnboardingStore((s) => s.setStep);
  if (profileCount > 0 && profile) {
    return (
      <>
        <StepHeading title="Welcome back">
          This is set up for <span className="text-neutral-200">{profile.name}</span>. Profiles are managed under
          Profiles in the sidebar once setup is over.
        </StepHeading>
        <Button variant="primary" onClick={() => setStep('transcription')}>
          Continue
        </Button>
      </>
    );
  }
  return (
    <>
      <StepHeading title="Welcome to BrainCue">
        An AI that sits in on the conversation you are actually in — and contributes through a Cue Card
        nobody else can see. Three short questions and it is ready.
      </StepHeading>
      <Card>
        <NewProfileForm firstRun onCreated={onCreated} />
      </Card>
    </>
  );
}

function TranscriptionStep({ models }: { models: ReturnType<typeof useSttModels> }) {
  const { settings, load } = useSettingsStore();
  if (!settings) return null;
  const { engine, localModelId } = settings.stt;

  const setEngine = async (e: SttEngine) => {
    await api.settings.set({ stt: { engine: e, localModelId } });
    await load();
  };
  const setLocalModel = async (id: string) => {
    await api.settings.set({ stt: { engine, localModelId: id } });
    await load();
  };

  return (
    <>
      <StepHeading title="How should BrainCue hear the room?">
        Live transcription is what everything else reacts to. Both engines can be changed at any time
        under Settings → Speech-to-Text.
      </StepHeading>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <EngineRow
          active={engine === 'cloud'}
          title="Cloud"
          blurb="OpenAI Realtime. Accurate; audio leaves this machine. Needs your OpenAI key."
          onClick={() => void setEngine('cloud')}
        />
        <EngineRow
          active={engine === 'local'}
          title="Local"
          blurb="On-device NVIDIA models — fully private, nothing leaves the machine. One ~630 MB download."
          onClick={() => void setEngine('local')}
        />
      </div>

      {engine === 'cloud' ? (
        <Card>
          <div className="mb-3 flex items-center gap-2 border-b border-white/5 pb-2">
            <span className="rounded-md bg-indigo-500/15 px-2.5 py-1 text-xs font-medium text-indigo-200">OpenAI</span>
            <span className="text-xs text-neutral-500">Realtime transcription</span>
            <span className="ml-auto">
              {settings.apiKeyPresent ? <Badge tone="green">key ✓</Badge> : <Badge tone="amber">key needed</Badge>}
            </span>
          </div>
          {settings.apiKeyPresent ? (
            <p className="text-sm text-neutral-300">
              Your OpenAI key is stored — cloud transcription is ready. The same key covers the next step.
            </p>
          ) : (
            <ProviderKeyBlock provider="openai" settings={settings} onSaved={load} />
          )}
        </Card>
      ) : (
        <Card>
          <div className="mb-3 flex items-center gap-2 border-b border-white/5 pb-2">
            <span className="rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-200">NVIDIA</span>
            <span className="text-xs text-neutral-500">
              Streaming transducers via sherpa-onnx, CPU. The download keeps going while you continue.
            </span>
          </div>
          <LocalModelList selectedModelId={localModelId} onSelect={setLocalModel} models={models} />
        </Card>
      )}
    </>
  );
}

function AiStep() {
  const { settings, load } = useSettingsStore();
  const [provider, setProvider] = useState<CloudProviderId>('openai');
  if (!settings) return null;

  const selectPreset = async (p: string) => {
    // A clean switch, as in Settings: the preset replaces any per-task override.
    await api.settings.set({ modelPreset: p, models: {} });
    await load();
  };

  return (
    <>
      <StepHeading title="Which AI should it think with?">
        BrainCue has no account of its own — every call is billed to your key. The{' '}
        <span className="text-neutral-200">OpenAI key is required</span>: retrieval (embeddings) and the
        default models run there. Anthropic, Google Gemini, Groq and OpenRouter are optional extras you can
        pick per task later, in Settings → Language Models. Keys are encrypted by your OS and never leave
        the background process.
      </StepHeading>
      <Card className="mb-4">
        <ProviderTiles settings={settings} selected={provider} onSelect={setProvider} />
        <div className="mt-4 border-t border-white/5 pt-4">
          <ProviderKeyBlock key={provider} provider={provider} settings={settings} onSaved={load} />
        </div>
      </Card>
      <Card>
        <h3 className="mb-1 font-medium">Cost / quality preset</h3>
        <p className="mb-3 text-sm text-neutral-400">
          Sets which model each task uses. Balanced is right for most people; any single task can be
          overridden later.
        </p>
        <PresetPicker value={settings.modelPreset ?? 'balanced'} onSelect={(p) => void selectPreset(p)} />
      </Card>
    </>
  );
}

function DoneStep({ models }: { models: ReturnType<typeof useSttModels> }) {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return null;
  const rows = setupRows({
    stt: settings.stt,
    sttReady: settings.sttReady,
    apiKeyPresent: settings.apiKeyPresent,
    providerKeys: settings.providerKeys,
    models: models.statuses,
    live: models.live,
  });
  const allReady = rows.every((r) => r.status === 'ready');
  return (
    <>
      <StepHeading title={allReady ? 'You’re set up' : 'Almost there'}>
        {allReady
          ? 'Everything a live session needs is in place. The tour takes about ninety seconds and covers the whole loop.'
          : 'What is not ready yet is listed on Home under “Finish setup” until it is — nothing here is lost. The tour takes about ninety seconds and covers the whole loop.'}
      </StepHeading>
      <Card>
        <ul className="divide-y divide-white/5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-3">
              <StatusDot status={r.status} />
              <span className="w-28 shrink-0 text-sm font-medium text-neutral-200">{r.label}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-400">{r.detail}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

/** Green = ready, amber pulsing = in progress (a download), hollow = missing.
 *  Shared with Home's checklist so the two read the same. */
export function StatusDot({ status }: { status: SetupStatus }) {
  return (
    <span
      aria-label={status}
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
        status === 'ready' ? 'bg-emerald-400' : status === 'pending' ? 'animate-pulse bg-amber-400' : 'border border-neutral-600'
      }`}
    />
  );
}

