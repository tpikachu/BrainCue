import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { AppSettings } from '@shared/types';
import { Dropdown, Modal } from '../../components/ui';
import { noDrag } from '../lib/style';

/** Cue Card settings: audio device, coding-solver model/effort/language, and
 *  appearance. Owns its own persisted state — loaded fresh each time it opens,
 *  so overrides changed meanwhile from the dashboard Settings page are never
 *  silently reverted. Appearance (opacity/text size) is window-level state and
 *  comes in via props. */
export function SettingsModal(props: {
  open: boolean;
  onClose: () => void;
  opacity: number;
  onOpacity: (v: number) => void;
  fontSize: number;
  onFontSize: (v: number) => void;
}) {
  const [audioSource, setAudioSource] = useState<'system' | 'mic'>('system');
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  // Coding-solver model + reasoning effort (persisted overrides; '' = use default).
  // Switchable live so a hard problem can be bumped to a stronger model on the spot.
  const [codingModel, setCodingModel] = useState('');
  const [codingEffort, setCodingEffort] = useState('');
  const [codingLanguage, setCodingLanguage] = useState('javascript');
  const [codingDefaults, setCodingDefaults] = useState({ model: 'gpt-5-mini', effort: 'low' });

  useEffect(() => {
    if (!props.open) return;
    // Seed from persisted settings on every open (fresh, not a boot snapshot).
    void api.settings.get().then((s) => {
      const ss = s as AppSettings;
      if (ss.audio) {
        setAudioSource(ss.audio.source);
        setMicDeviceId(ss.audio.micDeviceId);
      }
      setCodingModel(ss.models?.coding ?? '');
      setCodingEffort(ss.reasoningEfforts?.coding ?? '');
      setCodingLanguage(ss.codingLanguage ?? 'javascript');
      setCodingDefaults({
        model: ss.modelDefaults?.coding ?? 'gpt-5-mini',
        effort: ss.reasoningEffortDefaults?.coding ?? 'low',
      });
    });
    // Device labels only populate after a mic-permission grant — briefly probe
    // the mic to unlock them, then release it (main auto-allows 'media').
    void (async () => {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMicDevices(devices.filter((d) => d.kind === 'audioinput'));
        probe?.getTracks().forEach((t) => t.stop());
      } catch {
        setMicDevices([]);
      }
    })();
  }, [props.open]);

  const saveAudio = (next: { source?: 'system' | 'mic'; micDeviceId?: string | null }) => {
    const source = next.source ?? audioSource;
    const device = next.micDeviceId !== undefined ? next.micDeviceId : micDeviceId;
    setAudioSource(source);
    setMicDeviceId(device);
    void api.settings.set({ audio: { source, micDeviceId: device } });
  };

  // Persist the coding-solver model/effort. Read-modify-write against FRESH
  // settings (not a snapshot): the overlay window lives for the whole app
  // session, so merging into stale maps would silently revert overrides changed
  // later from the dashboard Settings page. '' clears the key → default.
  const saveCoding = async (next: { model?: string; effort?: string }) => {
    const m = next.model !== undefined ? next.model : codingModel;
    const e = next.effort !== undefined ? next.effort : codingEffort;
    setCodingModel(m);
    setCodingEffort(e);
    try {
      const fresh = (await api.settings.get()) as AppSettings;
      const models = { ...(fresh.models ?? {}) };
      if (m) models.coding = m;
      else delete models.coding;
      const efforts = { ...(fresh.reasoningEfforts ?? {}) };
      if (e) efforts.coding = e;
      else delete efforts.coding;
      await api.settings.set({ models, reasoningEfforts: efforts });
    } catch {
      // Persistence failed — the pickers still show the chosen value; the next
      // successful save (or app restart) reconciles.
    }
  };

  return (
    <div data-ct-interactive style={noDrag}>
      <Modal open={props.open} onClose={props.onClose} title="Cue Card settings" width="max-w-sm">
        <div className="space-y-5 text-sm">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Audio</p>
            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-400">Listen to</span>
              <Dropdown
                value={audioSource}
                options={[
                  { value: 'system', label: 'Interviewer (system audio)' },
                  { value: 'mic', label: 'Microphone (in-person)' },
                ]}
                onChange={(v) => saveAudio({ source: v as 'system' | 'mic' })}
              />
            </div>
            {audioSource === 'mic' && (
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
                  onChange={(v) => saveAudio({ micDeviceId: v || null })}
                />
              </div>
            )}
            <p className="text-xs text-neutral-500">
              Applies to your next interview (the running one keeps its device).
              {audioSource === 'mic' && micDevices.every((d) => !d.label)
                ? ' Grant microphone access once to see device names.'
                : ''}
            </p>
          </div>

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
                  void api.settings.set({ codingLanguage: v });
                }}
              />
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-400">Model</span>
              <Dropdown
                value={codingModel}
                options={[
                  { value: '', label: `Default (${codingDefaults.model})` },
                  ...['gpt-5-mini', 'gpt-5', 'gpt-4.1', 'o4-mini'].map((m) => ({ value: m, label: m })),
                ]}
                onChange={(v) => void saveCoding({ model: v })}
              />
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-neutral-400">
                Reasoning effort <span className="text-neutral-600">(reasoning models only)</span>
              </span>
              <Dropdown
                value={codingEffort}
                options={[
                  { value: '', label: `Default (${codingDefaults.effort})` },
                  { value: 'low', label: 'Low — fastest, cheapest' },
                  { value: 'medium', label: 'Medium — balanced' },
                  { value: 'high', label: 'High — hardest problems' },
                ]}
                onChange={(v) => void saveCoding({ effort: v })}
              />
            </div>
            <p className="text-xs text-neutral-500">
              Used by both “Solve from clipboard” and “Solve a region.” Bump a hard problem up
              to a stronger model or higher effort — it applies to your next solve.
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
