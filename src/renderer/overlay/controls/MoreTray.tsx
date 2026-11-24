import type { AnswerFormat, AppSettings, InterviewType } from '@shared/types';
import type { ClientInfo } from '@shared/ipc';
import { api } from '../../lib/api';
import { BoltIcon, CompactIcon, ExpandIcon, FrameIcon, SettingsIcon, TrashIcon, UserIcon } from '../../components/icons';
import { noDrag } from '../lib/style';
import { ModelChip } from './ModelChip';

/** The answer style (v2.2): two styles. Everything the old interview-type
 *  dropdown and five-format control did is automatic — behavioral questions
 *  get the story shape from the classifier, coding is reached via capture. */
const STYLES: readonly [AnswerFormat, string, string][] = [
  ['general', 'General', 'Lead sentence + a few bullets'],
  ['technical', 'Technical', 'Specifics, a line of code if useful, approach and trade-offs'],
];

const chip = 'inline-flex h-7 items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-indigo-400';
const quiet = `${chip} bg-white/[0.04] text-neutral-400 hover:bg-white/[0.08] hover:text-neutral-100`;

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
  /** A qualified model id for the task, or null = Automatic. */
  onPickModel: (task: 'answer' | 'coding', value: string | null) => void;
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
      className="space-y-2 rounded-xl border border-neutral-700/80 bg-neutral-950 p-2.5 text-[11px] shadow-xl shadow-black/40"
      style={noDrag}
      aria-label="More controls"
    >
      {props.live && (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-3">
          <div className="space-y-1">
            <span className="block text-[10px] text-neutral-400">Style</span>
            <span className="inline-flex h-7 rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-white/[0.06]">
              {STYLES.map(([value, label, title]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => props.onChangeFormat(value)}
                  title={title}
                  aria-pressed={props.answerFormat === value}
                  className={`rounded-md px-2 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                    props.answerFormat === value ? 'bg-neutral-700 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
          {/* The model for spoken questions — in EVERY interview, coding
              included (their verbal questions are answers too). Picking
              re-answers the current question. */}
          <ModelChip settings={props.settings} task="answer" onPick={(v) => props.onPickModel('answer', v)} />
        </div>
      )}
      {props.live && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={props.historyEnabled ? `${chip} bg-indigo-400/10 text-indigo-200` : quiet} aria-pressed={props.historyEnabled} onClick={props.onToggleHistory} title="Keep earlier answers (collapsed) instead of replacing them">
            Keep earlier
          </button>
          <button type="button" className={props.pronunciation ? `${chip} bg-indigo-400/10 text-indigo-200` : quiet} aria-pressed={props.pronunciation} onClick={props.onTogglePronunciation} title="Pronunciation hints for rare / technical words">
            æ Pronunciation
          </button>
          <button type="button" className={`${quiet} ml-auto`} onClick={props.onClear} title="Clear every card from the Cue Card">
            <TrashIcon className="h-3 w-3" />
            Clear
          </button>
        </div>
      )}
      <div className="space-y-1.5 border-t border-white/[0.06] pt-2">
        <span className="block text-[10px] text-neutral-500">Tools</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={quiet} onClick={() => api.capture.quickSolve()} title="Solve from clipboard (Ctrl+Shift+Enter)">
            <BoltIcon className="h-3 w-3" />
            Solve clipboard
          </button>
          <button type="button" className={quiet} onClick={() => api.capture.openSelector()} title="Capture the problem (scroll & repeat for long ones, then Solve)">
            <FrameIcon className="h-3 w-3" />
            Capture
          </button>
          <button type="button" className={quiet} onClick={props.onToggleMode} title={props.mode === 'compact' ? 'Larger window, with the audio meter' : 'Compact window'}>
            {props.mode === 'compact' ? <ExpandIcon className="h-3 w-3" /> : <CompactIcon className="h-3 w-3" />}
            {props.mode === 'compact' ? 'Expand' : 'Compact'}
          </button>
          <button type="button" className={quiet} onClick={props.onOpenSettings} title="Audio device, appearance">
            <SettingsIcon className="h-3 w-3" />
            Settings
          </button>
        </div>
        {props.live && props.interviewType === 'coding' && (
          <ModelChip settings={props.settings} task="coding" onPick={(v) => props.onPickModel('coding', v)} />
        )}
      </div>
      {c && (
        <div className="border-t border-white/[0.06] pt-2 text-neutral-400">
          <div className="flex flex-wrap items-center gap-1.5">
            <UserIcon className="h-3 w-3 text-neutral-500" />
            <span className="min-w-0 truncate">{c.profileName ?? 'No profile'}</span>
            <Grounded on={c.hasResume} label="résumé" />
            <Grounded on={c.hasJd} label="JD" />
            <Grounded on={c.hasCompany} label="company" />
          </div>
          {(c.company || c.title) && (
            <p className="mt-1 truncate text-[10px] text-neutral-500">
              {c.company || c.title}
              {c.company && c.title ? ` · ${c.title}` : ''}
            </p>
          )}
          {c.notes && (
            <details className="mt-1 text-[10px] text-neutral-500">
              <summary className="cursor-pointer hover:text-neutral-300">Session notes</summary>
              <p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap leading-relaxed text-neutral-400">{c.notes}</p>
            </details>
          )}
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
