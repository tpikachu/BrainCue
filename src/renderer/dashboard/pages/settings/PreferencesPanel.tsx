import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useTourStore } from '../../../store/useTourStore';
import { api } from '../../../lib/api';
import type { AppSettings, CompanionPrefs } from '@shared/types';
import { FLAGS } from '@shared/flags';
import { Badge, Button, Card, Field, Select, Switch, TextInput } from '../../../components/ui';
import { PlayIcon } from '../../../components/icons';
import { BUDGET_OPTIONS, COMPANION_PRESENCE_OPTIONS } from '../../startFlow';
import { PanelBody, PanelHeader } from './SettingsLayout';
import { settingsSection } from './sections';

/** Same list the Cue Card's settings modal offers — the solver writes in one of these. */
const CODING_LANGUAGES = [
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
];

export function PreferencesPanel() {
  const { settings, load } = useSettingsStore();
  const startTour = useTourStore((s) => s.start);
  const meta = settingsSection('preferences');

  return (
    <>
      <PanelHeader title={meta.title} blurb={meta.blurb} />
      <PanelBody>
        <Card>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="font-medium">Getting started</h3>
              <p className="text-xs text-neutral-500">
                Replay the guided tour, or open Help for the quick start, the shortcuts, and the
                FAQ. Help is also the “?” in the title bar, from any page.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Link to="/help">
                <Button variant="ghost">Help &amp; FAQ</Button>
              </Link>
              <Button onClick={startTour}>
                <PlayIcon /> Replay tour
              </Button>
            </div>
          </div>
        </Card>

        {settings && <CodingLanguageCard settings={settings} onSaved={load} />}

        {FLAGS.companion && settings && <CompanionCard settings={settings} onSaved={load} />}
      </PanelBody>
    </>
  );
}

/** The language the coding solver answers in. Also switchable from the Cue
 *  Card's settings modal mid-interview; both write `codingLanguage`. */
function CodingLanguageCard({ settings, onSaved }: { settings: AppSettings; onSaved: () => Promise<void> }) {
  const [lang, setLang] = useState(settings.codingLanguage ?? 'javascript');
  useEffect(() => setLang(settings.codingLanguage ?? 'javascript'), [settings.codingLanguage]);
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-medium">Coding solver language</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            Solutions from “Solve from clipboard” and “Solve a region” are written in this language.
            Change it mid-interview from the Cue Card’s settings too.
          </p>
        </div>
        <div className="w-40 shrink-0">
          <Select
            value={lang}
            onChange={(e) => {
              const v = e.target.value;
              setLang(v);
              void api.settings.set({ codingLanguage: v }).then(onSaved);
            }}
          >
            {CODING_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </Card>
  );
}

const minToTime = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const timeToMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Global companion configuration: personality (the ONE persona source —
 *  engine/persona.ts renders it), default posture, a do-not-disturb window,
 *  and the default hard session budget. Per-Space overrides live on each
 *  Space in the Library. */
function CompanionCard({ settings, onSaved }: { settings: AppSettings; onSaved: () => Promise<void> }) {
  const [prefs, setPrefs] = useState<CompanionPrefs>(settings.companionPrefs);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setPrefs(settings.companionPrefs), [settings.companionPrefs]);

  const dnd = prefs.dnd[0] ?? null;
  const patch = (p: Partial<CompanionPrefs>) => {
    setSaved(false);
    setPrefs((v) => ({ ...v, ...p }));
  };
  const patchPersonality = (p: Partial<CompanionPrefs['personality']>) =>
    patch({ personality: { ...prefs.personality, ...p } });

  const save = async () => {
    setSaving(true);
    try {
      await api.settings.set({ companionPrefs: prefs });
      await onSaved();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-medium">Companion</h3>
        <Badge tone="amber">Labs</Badge>
      </div>
      <p className="mb-4 text-sm text-neutral-400">
        How the companion behaves in every session. A Space can override tone, brevity, humor, and
        posture for sessions grounded in it (Library › Spaces).
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <TextInput
            value={prefs.personality.name}
            onChange={(e) => patchPersonality({ name: e.target.value })}
            placeholder="BrainCue"
          />
        </Field>
        <Field label="Tone">
          <Select
            value={prefs.personality.tone}
            onChange={(e) => patchPersonality({ tone: e.target.value as CompanionPrefs['personality']['tone'] })}
          >
            <option value="warm">Warm</option>
            <option value="neutral">Neutral</option>
            <option value="direct">Direct</option>
          </Select>
        </Field>
        <Field label="Brevity">
          <Select
            value={prefs.personality.brevity}
            onChange={(e) => patchPersonality({ brevity: e.target.value as CompanionPrefs['personality']['brevity'] })}
          >
            <option value="terse">Terse</option>
            <option value="normal">Normal</option>
            <option value="chatty">Chatty</option>
          </Select>
        </Field>
        <Field label="Default presence">
          <Select
            value={prefs.presence}
            onChange={(e) => patch({ presence: e.target.value as CompanionPrefs['presence'] })}
          >
            {COMPANION_PRESENCE_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label} — {p.desc}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default session budget">
          <Select
            value={prefs.budgetCents === null ? '' : String(prefs.budgetCents)}
            onChange={(e) =>
              patch({ budgetCents: e.target.value === '' ? null : Number(e.target.value) })
            }
          >
            {BUDGET_OPTIONS.map((b) => (
              <option key={b.label} value={b.value === null ? '' : String(b.value)}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-white/5 pt-4">
        <div>
          <h4 className="text-sm font-medium">Light humor</h4>
          <p className="mt-0.5 text-xs text-neutral-500">Allow the occasional aside when it fits.</p>
        </div>
        <Switch
          checked={prefs.personality.humor}
          onChange={(v) => patchPersonality({ humor: v })}
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-white/5 pt-4">
        <div>
          <h4 className="text-sm font-medium">Do not disturb</h4>
          <p className="mt-0.5 text-xs text-neutral-500">
            No automatic contributions in this window (summons still answer). Spans midnight if the
            end is earlier than the start.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dnd && (
            <>
              <input
                type="time"
                value={minToTime(dnd.startMin)}
                onChange={(e) => patch({ dnd: [{ ...dnd, startMin: timeToMin(e.target.value) }] })}
                className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
              />
              <span className="text-xs text-neutral-500">to</span>
              <input
                type="time"
                value={minToTime(dnd.endMin)}
                onChange={(e) => patch({ dnd: [{ ...dnd, endMin: timeToMin(e.target.value) }] })}
                className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm text-neutral-100"
              />
            </>
          )}
          <Switch
            checked={!!dnd}
            onChange={(v) => patch({ dnd: v ? [{ startMin: 1320, endMin: 420 }] : [] })}
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-3 border-t border-white/5 pt-4">
        {saved && <span className="text-xs text-green-400">Saved ✓</span>}
        <Button variant="primary" onClick={() => void save()} loading={saving}>
          Save companion settings
        </Button>
      </div>
    </Card>
  );
}
