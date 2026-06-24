import { useEffect, useState } from 'react';
import { Button, Card } from '../components/ui';
import { ChevronRightIcon } from '../components/icons';

// Sample interviewer questions across the common interview types. Playing one
// aloud (browser speech synthesis — no API key, no cost) lets you test the live
// pipeline solo: start an interview with "Listen to: Interviewer (system audio)",
// play a question, and watch it get transcribed + answered in the Cue Card.
const SAMPLE_QUESTIONS: { category: string; items: string[] }[] = [
  {
    category: 'Behavioral',
    items: [
      'Tell me about yourself and why you’re interested in this role.',
      'Describe a time you disagreed with a teammate. How did you resolve it?',
      'Tell me about a project you’re most proud of and your specific contribution.',
      'Tell me about a time you failed and what you learned from it.',
    ],
  },
  {
    category: 'Technical',
    items: [
      'What’s the difference between a process and a thread?',
      'How would you design a rate limiter for an API?',
      'Explain how a hash map works and its average and worst-case time complexity.',
      'When would you choose a message queue over direct service-to-service calls?',
    ],
  },
  {
    category: 'System design',
    items: [
      'Design a URL shortener like bit.ly.',
      'How would you design a news feed for a social app?',
      'Walk me through designing a chat service that scales to millions of users.',
    ],
  },
  {
    category: 'Coding',
    items: [
      'Given an array of integers, return the indices of the two numbers that add up to a target.',
      'How would you reverse a singly linked list, in place?',
      'Find the length of the longest substring without repeating characters.',
    ],
  },
];

/** A collapsible panel of sample interview questions you can play aloud to test
 *  the live Cue Card without a real interviewer. */
export function SampleQuestions() {
  const [open, setOpen] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);

  // Stop any speech when the panel unmounts.
  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const play = (q: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(q);
    u.rate = 0.98;
    u.onend = () => setSpeaking(null);
    setSpeaking(q);
    window.speechSynthesis.speak(u);
  };
  const stop = () => {
    window.speechSynthesis?.cancel();
    setSpeaking(null);
  };

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2">
          <ChevronRightIcon
            className={`h-4 w-4 text-neutral-500 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <span className="font-medium">🔊 Test with sample questions</span>
        </span>
        <span className="text-xs text-neutral-500">play one aloud</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          <p className="text-xs text-neutral-500">
            Start an interview with <strong>Listen to: Interviewer (system audio)</strong>, then play
            a question — your speakers’ audio is captured, transcribed, and answered in the Cue Card.
            (Uses your OS voice; no API cost.)
          </p>
          {SAMPLE_QUESTIONS.map((cat) => (
            <div key={cat.category}>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {cat.category}
              </h4>
              <div className="space-y-1.5">
                {cat.items.map((q) => (
                  <div
                    key={q}
                    className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-1.5"
                  >
                    <span className="text-sm text-neutral-300">{q}</span>
                    <Button
                      variant={speaking === q ? 'danger' : 'default'}
                      onClick={() => (speaking === q ? stop() : play(q))}
                    >
                      {speaking === q ? '■ Stop' : '▶ Play'}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
