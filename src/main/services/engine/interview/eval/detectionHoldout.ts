import type { LabeledUtterance } from './detectionSet';

/**
 * HELD-OUT detection set. Written after the rules were tuned on
 * detectionSet.ts and NOT used for tuning: its score is the honest estimate
 * of the rule layer on unseen phrasing. If a rule is ever changed because of
 * a miss here, move that case into detectionSet.ts and write new held-out
 * cases — otherwise this number stops meaning anything.
 */
const ctx = [
  { speaker: 'interviewer' as const, text: 'You mentioned the search relevance work at your last company.' },
  { speaker: 'candidate' as const, text: 'Yes, I rebuilt the ranking pipeline and we moved to learning to rank.' },
];

export const DETECTION_HOLDOUT: LabeledUtterance[] = [
  // answer-worthy
  { text: 'Run me through a typical week in your current job.', answer: true, tag: 'imperative' },
  { text: 'Paint me a picture of the system before you touched it.', answer: true, tag: 'imperative', context: ctx },
  { text: 'Say more about the ranking change.', answer: true, tag: 'imperative', context: ctx },
  { text: 'Tell me what success looked like for that project.', answer: true, tag: 'imperative', context: ctx },
  { text: 'Describe your ideal manager', answer: true, tag: 'imperative' },
  { text: 'Give me the thirty second version of your background.', answer: true, tag: 'imperative' },
  { text: 'Explain it to me like I am a product manager.', answer: true, tag: 'imperative', context: ctx },
  { text: 'Talk about a time you changed your mind.', answer: true, tag: 'behavioral' },
  { text: 'Now I want you to design a notification service.', answer: true, tag: 'technical' },
  { text: 'Implement an LRU cache.', answer: true, tag: 'technical' },
  { text: 'What metrics did you look at', answer: true, tag: 'no-qmark', context: ctx },
  { text: 'How did you get buy-in from the other teams?', answer: true, tag: 'wh', context: ctx },
  { text: 'Why learning to rank instead of tuning the heuristics', answer: true, tag: 'no-qmark', context: ctx },
  { text: 'What made you apply here?', answer: true, tag: 'wh' },
  { text: 'How many people reported to you?', answer: true, tag: 'wh' },
  { text: 'What does a good code review look like to you', answer: true, tag: 'no-qmark' },
  { text: 'How do you keep up with new tools', answer: true, tag: 'no-qmark' },
  { text: 'What happens when a node goes down?', answer: true, tag: 'technical' },
  { text: 'How would you debug a memory leak in production?', answer: true, tag: 'technical' },
  { text: 'Do you prefer working alone or in a team?', answer: true, tag: 'aux' },
  { text: 'Did that ship on time?', answer: true, tag: 'aux', context: ctx },
  { text: 'Were you the one who proposed it', answer: true, tag: 'aux', context: ctx },
  { text: 'Can you give me a concrete number?', answer: true, tag: 'aux', context: ctx },
  { text: 'Would you be open to relocating?', answer: true, tag: 'aux' },
  { text: 'Has anyone pushed back on that?', answer: true, tag: 'aux', context: ctx },
  { text: 'Then what?', answer: true, tag: 'followup', context: ctx },
  { text: 'And the results?', answer: true, tag: 'followup', context: ctx },
  { text: 'For example?', answer: true, tag: 'followup', context: ctx },
  { text: 'Such as', answer: true, tag: 'followup', context: ctx },
  { text: 'Your role in that specifically?', answer: true, tag: 'followup', context: ctx },
  { text: 'And who made the final call', answer: true, tag: 'followup', context: ctx },
  { text: 'How long did that take you?', answer: true, tag: 'followup', context: ctx },
  { text: 'Why?', answer: true, tag: 'followup', context: ctx },
  {
    text: 'We have had some trouble with flaky tests here. How would you go about fixing that, and how would you keep it fixed?',
    answer: true,
    tag: 'multi-part',
  },
  { text: 'First, what was the scale, and second, what broke first?', answer: true, tag: 'multi-part', context: ctx },
  { text: 'Last question from me: why should we hire you?', answer: true, tag: 'wh' },
  { text: 'I want to hear how you would prioritize these three bugs.', answer: true, tag: 'imperative' },
  { text: 'Your experience with on-call', answer: true, tag: 'no-qmark' },
  { text: 'I would be interested to know how you mentor juniors.', answer: true, tag: 'imperative' },
  { text: 'Curious what your stance is on pair programming', answer: true, tag: 'no-qmark' },
  // not answer-worthy
  { text: 'Sounds good.', answer: false, tag: 'backchannel' },
  { text: 'Uh-huh.', answer: false, tag: 'backchannel' },
  { text: 'Yep, yep.', answer: false, tag: 'backchannel' },
  { text: 'Okay, cool, that is helpful context.', answer: false, tag: 'courtesy' },
  { text: 'Love that.', answer: false, tag: 'courtesy' },
  { text: 'That is a really thoughtful answer.', answer: false, tag: 'courtesy' },
  { text: 'Appreciate you sharing that.', answer: false, tag: 'courtesy' },
  { text: 'We actually went through something very similar last quarter.', answer: false, tag: 'statement' },
  { text: 'Our stack is React on the front end and Rust services behind it.', answer: false, tag: 'statement' },
  { text: 'I lead the infrastructure group, so I will be your skip level.', answer: false, tag: 'statement' },
  { text: 'The next round is a system design interview with two engineers.', answer: false, tag: 'statement' },
  { text: 'We should hear back from the team by Friday.', answer: false, tag: 'statement' },
  { text: 'Why we ask this is mostly to understand how you think.', answer: false, tag: 'statement' },
  { text: 'What I like about this team is how fast it ships.', answer: false, tag: 'statement' },
  { text: 'I will put a link in the chat.', answer: false, tag: 'logistics' },
  { text: 'Can you hear me now?', answer: false, tag: 'logistics' },
  { text: 'Hold on, my dog is barking.', answer: false, tag: 'logistics' },
  { text: 'Let me stop sharing.', answer: false, tag: 'logistics' },
  { text: 'You are breaking up a little.', answer: false, tag: 'logistics' },
  { text: 'Okay, next one.', answer: false, tag: 'transition' },
  { text: 'Good, that is all I had on that topic.', answer: false, tag: 'transition' },
  { text: 'Let me write that down.', answer: false, tag: 'transition' },
  { text: 'No worries at all.', answer: false, tag: 'courtesy' },
  { text: 'Hard problem, honestly.', answer: false, tag: 'statement' },
  { text: 'Fun times.', answer: false, tag: 'rhetorical' },
];
