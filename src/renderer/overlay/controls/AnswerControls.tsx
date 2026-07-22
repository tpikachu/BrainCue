import type { AnswerFormat, InterviewType } from '@shared/types';
import { Dropdown } from '../../components/ui';
import { TrashIcon } from '../../components/icons';
import { ctrlSelect, noDrag } from '../lib/style';
import { Btn } from './Btn';

const INTERVIEW_TYPES: { value: InterviewType; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'behavioral', label: 'Behavioral' },
  { value: 'technical', label: 'Technical' },
  { value: 'coding', label: 'Coding' },
  { value: 'system_design', label: 'System design' },
];

/** Answer controls (labeled): interview type, format, listen-only (coding),
 *  history, pronunciation, clear. All dynamic — change them anytime mid-interview. */
export function AnswerControls(props: {
  interviewType: InterviewType;
  answerFormat: AnswerFormat;
  pronunciation: boolean;
  answerInterviewer: boolean;
  historyEnabled: boolean;
  onChangeType: (t: InterviewType) => void;
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
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
        Type
        {/* Dropdown (not a native <select>): the native option popup is a
            separate OS window that screen shares CAN see even in Privacy Mode. */}
        <Dropdown
          value={props.interviewType}
          options={INTERVIEW_TYPES}
          onChange={(v) => props.onChangeType(v as InterviewType)}
          buttonClassName={`flex items-center gap-1 ${ctrlSelect}`}
        />
      </span>
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
        Format
        <span className="flex overflow-hidden rounded-md ring-1 ring-neutral-700">
          {(
            [
              ['key_points', 'Key points', 'Short, glanceable key points'],
              ['explanation', 'Explanation', 'A natural, spoken explanation'],
              ['detailed', 'Detailed', 'Thorough, with a concrete example'],
              ['story_teller', 'Story', 'A short, vivid first-person story'],
            ] as const
          ).map(([value, label, title]) => (
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
