import type { AnswerFormat, AppSettings, InterviewType } from '@shared/types';
import type { CloudProviderId } from '@shared/providers';
import { TrashIcon } from '../../components/icons';
import { pickerTask } from '../../lib/modelChoice';
import { noDrag } from '../lib/style';
import { Btn } from './Btn';
import { ModelChip } from './ModelChip';

/** The one answer control (v2.2): two styles. Everything the old interview-type
 *  dropdown and five-format control did is now automatic — behavioral
 *  questions get the story shape from the classifier, coding is reached via
 *  the capture hotkey. */
const STYLES: readonly [AnswerFormat, string, string][] = [
  ['general', 'General', 'Lead sentence + a few bullets'],
  ['technical', 'Technical', 'Specifics, a line of code if useful, approach and trade-offs'],
];

/** Answer controls (labeled): model, style (General | Technical), listen-only
 *  (coding), history, pronunciation, clear. All dynamic — change them anytime
 *  mid-interview. `interviewType` is still received for the model chip's task
 *  (coding sessions pick the solver model) — it is no longer a user control. */
export function AnswerControls(props: {
  interviewType: InterviewType;
  answerFormat: AnswerFormat;
  pronunciation: boolean;
  answerInterviewer: boolean;
  historyEnabled: boolean;
  /** Persisted settings (for the model chip); null until loaded. */
  settings: AppSettings | null;
  onPickModel: (task: 'answer' | 'coding', provider: CloudProviderId, id: string) => void;
  onChangeFormat: (f: AnswerFormat) => void;
  onTogglePronunciation: () => void;
  onToggleAnswerInterviewer: () => void;
  onToggleHistory: () => void;
  onClear: () => void;
}) {
  return (
    <div
      data-ct-interactive
      className="mb-2 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1"
      style={noDrag}
    >
      {/* Which model answers THIS session's questions: the solver in a coding
          interview, the live cue otherwise. Picking re-answers the current one. */}
      <ModelChip
        settings={props.settings}
        task={pickerTask(props.interviewType)}
        onPick={(provider, id) => props.onPickModel(pickerTask(props.interviewType), provider, id)}
      />
      <span className="flex overflow-hidden rounded-md ring-1 ring-neutral-700">
        {STYLES.map(([value, label, title]) => (
          <button
            key={value}
            onClick={() => props.onChangeFormat(value)}
            title={title}
            className={`px-2 py-1 text-[11px] font-medium normal-case transition-colors ${
              props.answerFormat === value
                ? 'bg-blue-600 text-white'
                : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {label}
          </button>
        ))}
      </span>
      {props.interviewType === 'coding' && (
        <button
          onClick={props.onToggleAnswerInterviewer}
          title={
            props.answerInterviewer
              ? 'Auto-answering the interviewer — click to go listen-only'
              : "Listen-only: transcribes but won't auto-answer (keeps your coding answer). Click to answer what the interviewer just asked."
          }
          className={`rounded-md px-2 py-1 text-[11px] font-medium normal-case transition-colors ${
            props.answerInterviewer
              ? 'bg-blue-600 text-white'
              : 'bg-neutral-800 text-amber-300 hover:text-amber-200'
          }`}
        >
          {props.answerInterviewer ? '🎧 Answering' : '🔇 Listen-only'}
        </button>
      )}
      <span className="flex-1" />
      <Btn
        active={props.historyEnabled}
        onClick={props.onToggleHistory}
        title="Keep answer history (collapse past answers instead of replacing them)"
      >
        <span className="text-[12px] leading-none">📚</span>
      </Btn>
      <Btn
        active={props.pronunciation}
        onClick={props.onTogglePronunciation}
        title="Pronunciation hints for rare / technical words"
      >
        <span className="text-[12px] font-semibold leading-none">æ</span>
      </Btn>
      <Btn onClick={props.onClear} title="Clear the answer">
        <TrashIcon className="h-3.5 w-3.5" />
      </Btn>
    </div>
  );
}
