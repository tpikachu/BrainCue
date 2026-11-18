import type { AnswerFormat, AppSettings, InterviewType } from '@shared/types';
import type { ClientInfo } from '@shared/ipc';
import type { CloudProviderId } from '@shared/providers';
import { api } from '../../lib/api';
import { BoltIcon, CompactIcon, ExpandIcon, FrameIcon, SettingsIcon, TrashIcon } from '../../components/icons';
import { pickerTask } from '../../lib/modelChoice';
import { noDrag } from '../lib/style';
import { ModelChip } from './ModelChip';

/** The answer style (v2.2): two styles. Everything the old interview-type
 *  dropdown and five-format control did is automatic — behavioral questions
 *  get the story shape from the classifier, coding is reached via capture. */
const STYLES: readonly [AnswerFormat, string, string][] = [
  ['general', 'General', 'Lead sentence + a few bullets'],
  ['technical', 'Technical', 'Specifics, a line of code if useful, approach and trade-offs'],
];

const chip = 'rounded-md px-2 py-1 text-[11px] font-medium transition-colors';
const quiet = `${chip} bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100`;

/**
 * Everything a live call does NOT need at a glance, one tap away (the
 * header's ⋯): answer style, the answering model, answer history,
 * pronunciation hints, clear, the coding capture tools, the expanded view,
 * Cue Card settings, and what this session is grounded in. Each control
 * still applies immediately, mid-interview.
 */
export function MoreTray(props: {
  live: boolean;
  interviewType: InterviewType;
  answerFormat: AnswerFormat;
  pronunciation: boolean;
  historyEnabled: boolean;
  settings: AppSettings | null;
  mode: 'compact' | 'expanded';
  clientInfo: ClientInfo | null;
  onPickModel: (task: 'answer' | 'coding', provider: CloudProviderId, id: string) => void;
  onChangeFormat: (f: AnswerFormat) => void;
  onTogglePronunciation: () => void;
  onToggleHistory: () => void;
  onClear: () => void;
  onToggleMode: () => void;
  onOpenSettings: () => void;
}) {
  const c = props.clientInfo;
  return (
    <div
      data-ct-interactive
      className="mb-2 shrink-0 space-y-1.5 rounded-lg border border-neutral-700/80 bg-neutral-950/70 p-2 text-[11px]"
      style={noDrag}
      aria-label="More controls"
    >
      {props.live && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-12 shrink-0 text-neutral-500">Style</span>
          <span className="flex overflow-hidden rounded-md ring-1 ring-neutral-700">
            {STYLES.map(([value, label, title]) => (
              <button
                key={value}
                type="button"
                onClick={() => props.onChangeFormat(value)}
                title={title}
                aria-pressed={props.answerFormat === value}
                className={`px-2 py-1 font-medium transition-colors ${
                  props.answerFormat === value ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {label}
              </button>
            ))}
          </span>
          {/* Which model answers THIS session's questions: the solver in a
              coding interview, the live cue otherwise. Picking re-answers. */}
          <ModelChip
            settings={props.settings}
            task={pickerTask(props.interviewType)}
            onPick={(provider, id) => props.onPickModel(pickerTask(props.interviewType), provider, id)}
          />
        </div>
      )}
      {props.live && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-12 shrink-0 text-neutral-500">Answers</span>
          <button type="button" className={props.historyEnabled ? `${chip} bg-neutral-700 text-white` : quiet} aria-pressed={props.historyEnabled} onClick={props.onToggleHistory} title="Keep earlier answers (collapsed) instead of replacing them">
            Keep earlier
          </button>
          <button type="button" className={props.pronunciation ? `${chip} bg-neutral-700 text-white` : quiet} aria-pressed={props.pronunciation} onClick={props.onTogglePronunciation} title="Pronunciation hints for rare / technical words">
            æ Pronunciation
          </button>
          <button type="button" className={quiet} onClick={props.onClear} title="Clear every card from the Cue Card">
            <TrashIcon className="mr-1 inline h-3 w-3" />
            Clear
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-12 shrink-0 text-neutral-500">Tools</span>
        <button type="button" className={quiet} onClick={() => api.capture.quickSolve()} title="Solve from clipboard (Ctrl+Shift+Enter)">
          <BoltIcon className="mr-1 inline h-3 w-3" />
          Solve clipboard
        </button>
        <button type="button" className={quiet} onClick={() => api.capture.openSelector()} title="Capture the problem (scroll & repeat for long ones, then Solve)">
          <FrameIcon className="mr-1 inline h-3 w-3" />
          Capture
        </button>
        <button type="button" className={quiet} onClick={props.onToggleMode} title={props.mode === 'compact' ? 'Larger window, with the audio meter' : 'Compact window'}>
          {props.mode === 'compact' ? <ExpandIcon className="mr-1 inline h-3 w-3" /> : <CompactIcon className="mr-1 inline h-3 w-3" />}
          {props.mode === 'compact' ? 'Expand' : 'Compact'}
        </button>
        <button type="button" className={quiet} onClick={props.onOpenSettings} title="Audio device, appearance">
          <SettingsIcon className="mr-1 inline h-3 w-3" />
          Settings
        </button>
      </div>
      {c && (
        <div className="border-t border-white/5 pt-1.5 text-neutral-400">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate">👤 {c.profileName ?? 'No profile'}</span>
            <Grounded on={c.hasResume} label="résumé" />
            <Grounded on={c.hasJd} label="JD" />
            <Grounded on={c.hasCompany} label="company" />
          </div>
          {(c.company || c.title) && (
            <p className="mt-0.5 text-neutral-300">
              {c.company || c.title}
              {c.company && c.title ? ` · ${c.title}` : ''}
            </p>
          )}
          {c.notes && <p className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap leading-relaxed text-neutral-400">{c.notes}</p>}
        </div>
      )}
    </div>
  );
}

function Grounded({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`rounded px-1 py-px text-[10px] ${on ? 'bg-green-900/40 text-green-300' : 'bg-neutral-800 text-neutral-500'}`}>
      {label} {on ? '✓' : '—'}
    </span>
  );
}
