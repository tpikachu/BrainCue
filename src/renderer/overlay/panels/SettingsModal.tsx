import { useEffect, useState } from 'react';
import { createSettingsFeed } from '../../lib/settingsFeed';
import { api } from '../../lib/api';
import type { AppSettings, VoicePrefs } from '@shared/types';
import { Dropdown, Modal, Switch } from '../../components/ui';
import { noDrag } from '../lib/style';
import { addKeyProvider, currentModel, modelLabel, overrideFor, taskPickerRows } from '../../lib/modelChoice';

/** Cue Card settings: audio device, voice output, coding-solver
 *  model/effort/language, and appearance. Owns its own persisted state —
 *  read fresh each time it opens and kept current by main's push, so changes
 *  made meanwhile elsewhere are shown and never silently reverted. Appearance
 *  (opacity/text size) is window-level state and comes in via props; voice
 *  prefs live with the Overlay's voice runtime (the player must react to an
 *  output-device change immediately) and come in via props too. */
export function SettingsModal(props: {
  open: boolean;
  onClose: () => void;
  opacity: number;
  onOpacity: (v: number) => void;
  fontSize: number;
  onFontSize: (v: number) => void;
  /** null = voice layer disabled (section hidden). */
  voicePrefs: VoicePrefs | null;
  onSaveVoicePrefs: (patch: Partial<VoicePrefs>) => void;
}) {
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  // Coding-solver model + reasoning effort (persisted overrides; '' =
  // Automatic). Switchable live so a hard problem can be bumped to a stronger
  // model on the spot. The model list is the shared per-task picker (the same
  // rows as the dashboard and the Cue Card's chip) over these settings.
  const [snap, setSnap] = useState<AppSettings | null>(null);
  const [codingModel, setCodingModel] = useState('');
  const [codingEffort, setCodingEffort] = useState('');
  const [codingLanguage, setCodingLanguage] = useState('javascript');
  // Voice output devices + quick-ask Spaces (loaded on open, voice section only).
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [spaces, setSpaces] = useState<{ id: string; label: string }[]>([]);

  // Settings reach this panel from its own reads (each open), its own write
  // replies and main's push. A reply older than what is shown — a read held
  // past a newer push, one from before a close/reopen, or one asked for
  // before the user's latest edit — is dropped (settingsFeed.ts): it used to
  // put back the previous solver model, which the next save then persisted.
  // One feed for the Cue Card's lifetime, so close/reopen is covered too.
  const [feed] = useState(() =>
    createSettingsFeed<AppSettings>((ss) => {
      if (ss.audio) setMicDeviceId(ss.audio.micDeviceId);
      setSnap(ss);
      setCodingModel(overrideFor(ss, 'coding'));
      setCodingEffort(ss.reasoningEfforts?.coding ?? '');
      setCodingLanguage(ss.codingLanguage ?? 'javascript');
    }),
  );
  useEffect(() => api.events.onSettingsChanged((s) => feed.push(s as AppSettings)), [feed]);

  useEffect(() => {
    if (!props.open) return;
    // Seed from persisted settings on every open (fresh, not a boot snapshot).
    void feed.request(api.settings.get() as Promise<AppSettings>).catch(() => {});
    // Device labels only populate after a mic-permission grant — briefly probe
    // the mic to unlock them, then release it (main auto-allows 'media').
    void (async () => {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMicDevices(devices.filter((d) => d.kind === 'audioinput'));
        setOutputDevices(devices.filter((d) => d.kind === 'audiooutput'));
        probe?.getTracks().forEach((t) => t.stop());
      } catch {
        setMicDevices([]);
        setOutputDevices([]);
      }
    })();
    // Spaces for the quick-ask default (voice section) — usually one profile.
    if (props.voicePrefs) {
      void (async () => {
        try {
          const profiles = (await api.profiles.list()) as { id: string }[];
          const all: { id: string; label: string }[] = [];
          for (const p of profiles) {
            const jobs = (await api.jobs.list(p.id)) as {
              id: string;
              title: string;
              company: string | null;
            }[];
            for (const j of jobs) all.push({ id: j.id, label: j.company ? `${j.company} — ${j.title}` : j.title });
          }
          setSpaces(all);
        } catch {
          setSpaces([]);
        }
      })();
    }
  }, [props.open, props.voicePrefs !== null]);

  /** Persist one edited field; the reply (or main's push) brings the rest. */
  const save = (patch: Record<string, unknown>) => {
    feed.edited();
    // Persistence failed — the control still shows the choice; the next push
    // or open reconciles.
    void feed.request(api.settings.set(patch) as Promise<AppSettings>).catch(() => {});
  };

  // A session hears the call AND the microphone (there is no source to pick);
  // the one audio preference left is WHICH microphone.
  const saveAudio = (device: string | null) => {
    setMicDeviceId(device);
    save({ audio: { micDeviceId: device } });
  };

  // Persist the solver's model OR its effort — only the field edited. Main
  // merges it into the stored map, so the other field (and every other
  // task's override) is never written from this panel's copy: changing the
  // effort keeps the current model, changing the model keeps the effort.
  // '' clears it (Automatic / the default). Main's reply carries the
  // re-resolved route for the next solve.
  const saveCoding = (edit: { model: string } | { effort: string }) => {
    if ('model' in edit) {
      setCodingModel(edit.model);
      save({ modelOverrides: { coding: edit.model || null } });
    } else {
      setCodingEffort(edit.effort);
      save({ effortOverrides: { coding: edit.effort || null } });
    }
  };

  return (
    <div data-ct-interactive style={noDrag}>
      <Modal open={props.open} onClose={props.onClose} title="Cue Card settings" width="max-w-sm">
        <div className="space-y-5 text-sm">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Audio</p>
            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-400">Microphone</span>
              <Dropdown
                value={micDeviceId ?? ''}
                options={[
                  { value: '', label: 'System default' },
                  ...micDevices.map((d, i) => ({
                    value: d.deviceId,
                    label: d.label || `Microphone ${i + 1}`,
                  })),
                ]}
                onChange={(v) => saveAudio(v || null)}
              />
            </div>
            <p className="text-xs text-neutral-500">
              A session hears the call (system audio) and this microphone; questions come from the
              call. Applies to your next session (the running one keeps its device).
              {micDevices.every((d) => !d.label)
                ? ' Grant microphone access once to see device names.'
                : ''}
            </p>
          </div>

          {props.voicePrefs && (
            <div className="space-y-3 border-t border-white/5 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Voice
              </p>
              <div>
                <span className="mb-1 block text-xs font-medium text-neutral-400">
                  BrainCue&apos;s voice
                </span>
                <Dropdown
                  value={props.voicePrefs.voice}
                  options={['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((v) => ({
                    value: v,
                    label: v,
                  }))}
                  onChange={(v) => props.onSaveVoicePrefs({ voice: v })}
                />
              </div>
              <div>
                <span className="mb-1 block text-xs font-medium text-neutral-400">
                  Speaker output
                </span>
                <Dropdown
                  value={props.voicePrefs.outputDeviceId ?? ''}
                  options={[
                    { value: '', label: 'System default' },
                    ...outputDevices.map((d, i) => ({
                      value: d.deviceId,
                      label: d.label || `Output ${i + 1}`,
                    })),
                  ]}
                  onChange={(v) => props.onSaveVoicePrefs({ outputDeviceId: v || null })}
                />
              </div>
              <div>
                <span className="mb-1 block text-xs font-medium text-neutral-400">
                  Quick-ask Space <span className="text-neutral-600">(no-session summons)</span>
                </span>
                <Dropdown
                  value={props.voicePrefs.quickAskPackId ?? ''}
                  options={[
                    { value: '', label: 'Most recent profile (no Space)' },
                    ...spaces.map((s) => ({ value: s.id, label: s.label })),
                  ]}
                  onChange={(v) => props.onSaveVoicePrefs({ quickAskPackId: v || null })}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-400">Save quick asks</span>
                <Switch
                  checked={props.voicePrefs.saveQuickAsks}
                  onChange={(next) => props.onSaveVoicePrefs({ saveQuickAsks: next })}
                />
              </div>
              <p className="text-xs text-neutral-500">
                Quick asks (summons with no session live) are ephemeral unless saved. In-session
                summons are part of that session as usual.
              </p>
            </div>
          )}

          <div className="space-y-3 border-t border-white/5 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Coding solver
            </p>
            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-400">Language</span>
              <Dropdown
                value={codingLanguage}
                options={[
                  'javascript',
                  'typescript',
                  'python',
                  'java',
                  'c++',
                  'c#',
                  'go',
                  'rust',
                  'ruby',
                  'swift',
                  'kotlin',
                  'php',
                ].map((l) => ({ value: l, label: l }))}
                onChange={(v) => {
                  setCodingLanguage(v);
                  save({ codingLanguage: v });
                }}
              />
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-400">Model</span>
              <Dropdown
                value={codingModel}
                ariaLabel="Coding solver model"
                disabled={!snap}
                options={taskPickerRows('coding', snap, {
                  addKeyDisabled: false,
                  addKeyTitle: 'Opens Settings → Language Models',
                })}
                onChange={(v) => {
                  if (addKeyProvider(v)) {
                    void api.window.openDashboard('/settings/models');
                    return;
                  }
                  saveCoding({ model: v });
                }}
              />
              {snap?.modelNotices?.coding && (
                <p className="mt-1 text-xs text-amber-300" data-model-notice="coding">
                  ⚠ Next solve: {modelLabel(currentModel(snap, 'coding'))}. {snap.modelNotices.coding}
                </p>
              )}
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-400">
                Reasoning effort <span className="text-neutral-600">(reasoning models only)</span>
              </span>
              <Dropdown
                value={codingEffort}
                options={[
                  { value: '', label: `Default (${snap?.reasoningEffortDefaults?.coding ?? 'low'})` },
                  { value: 'low', label: 'Low — fastest, cheapest' },
                  { value: 'medium', label: 'Medium — balanced' },
                  { value: 'high', label: 'High — hardest problems' },
                ]}
                onChange={(v) => saveCoding({ effort: v })}
              />
            </div>
            <p className="text-xs text-neutral-500">
              Used by “Solve clipboard” and “Capture”, not by interview answers (those have
              their own model, under ⋯). Applies to your next solve.
            </p>
          </div>

          <div className="space-y-3 border-t border-white/5 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Appearance
            </p>
            <label className="flex items-center gap-3">
              <span className="w-16 text-xs font-medium text-neutral-400">Opacity</span>
              <input
                type="range"
                min={0.4}
                max={1}
                step={0.05}
                value={props.opacity}
                onChange={(e) => props.onOpacity(Number(e.target.value))}
                className="h-1 flex-1 accent-indigo-500"
              />
            </label>
            <div className="flex items-center gap-3">
              <span className="w-16 text-xs font-medium text-neutral-400">Text size</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => props.onFontSize(Math.max(10, props.fontSize - 1))}
                  className="rounded-md bg-neutral-800 px-2.5 py-1 text-sm font-semibold text-neutral-200 hover:bg-neutral-700"
                >
                  A−
                </button>
                <span className="w-8 text-center text-xs tabular-nums text-neutral-400">
                  {props.fontSize}px
                </span>
                <button
                  onClick={() => props.onFontSize(Math.min(28, props.fontSize + 1))}
                  className="rounded-md bg-neutral-800 px-2.5 py-1 text-sm font-semibold text-neutral-200 hover:bg-neutral-700"
                >
                  A+
                </button>
              </div>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
