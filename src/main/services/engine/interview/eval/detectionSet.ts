/**
 * Labeled interviewer utterances for the detection evaluation
 * (detection.eval.test.ts, and the live run in detection.live.test.ts).
 *
 * `answer: true` = an interviewer turn that should produce an answer cue.
 * The set mixes what interviewers actually say, written the way a streaming
 * transcriber returns it — the "?" is often missing on falling intonation,
 * imperatives carry a period, and filler survives. Negatives are weighted
 * toward the hard cases: interviewer statements about their company, call
 * logistics, courtesy replies to the candidate, and rhetorical questions.
 *
 * `context` is what the classifier would see as RECENT (oldest first). It
 * matters for the elliptical follow-ups ("And your role").
 *
 * This is a regression set, written by hand for this codebase — not a
 * benchmark. Grow it from real misses (no transcript text from a user's
 * sessions is ever added without their say-so).
 */
export interface LabeledUtterance {
  text: string;
  answer: boolean;
  context?: { speaker: 'interviewer' | 'candidate'; text: string }[];
  /** What the case exercises. */
  tag:
    | 'imperative'
    | 'wh'
    | 'aux'
    | 'followup'
    | 'multi-part'
    | 'behavioral'
    | 'technical'
    | 'no-qmark'
    | 'backchannel'
    | 'courtesy'
    | 'statement'
    | 'logistics'
    | 'rhetorical'
    | 'transition';
}

const prevProject = [
  { speaker: 'interviewer' as const, text: 'Tell me about the payments migration you led.' },
  { speaker: 'candidate' as const, text: 'Sure, we moved the ledger from MySQL to Postgres over about six months.' },
];

export const DETECTION_SET: LabeledUtterance[] = [
  // ---- interview requests (imperative) ----
  { text: 'Tell me about yourself.', answer: true, tag: 'imperative' },
  { text: 'So tell me a little bit about yourself', answer: true, tag: 'imperative' },
  { text: 'Walk me through that project.', answer: true, tag: 'imperative', context: prevProject },
  { text: 'Walk me through your resume.', answer: true, tag: 'imperative' },
  { text: 'Explain the trade-offs.', answer: true, tag: 'imperative', context: prevProject },
  { text: 'Describe a time you had to deliver bad news to a stakeholder.', answer: true, tag: 'behavioral' },
  { text: 'Talk me through how you would design the rate limiter.', answer: true, tag: 'imperative' },
  { text: 'Give me an example of a decision you made with incomplete data.', answer: true, tag: 'behavioral' },
  { text: 'Okay, now take me through the architecture.', answer: true, tag: 'imperative' },
  { text: 'Share a bit about your current team.', answer: true, tag: 'imperative' },
  { text: 'Elaborate on that.', answer: true, tag: 'imperative', context: prevProject },
  { text: 'Expand on the testing strategy a little', answer: true, tag: 'imperative', context: prevProject },
  { text: 'Compare that with an event sourced approach.', answer: true, tag: 'imperative', context: prevProject },
  { text: 'Great. Explain how a hash map handles collisions.', answer: true, tag: 'technical' },
  { text: 'Define idempotency for me', answer: true, tag: 'technical' },
  { text: 'Design a URL shortener.', answer: true, tag: 'technical' },
  { text: 'Write a function that checks whether a string is a palindrome.', answer: true, tag: 'technical' },
  { text: 'Sketch out the data model for me', answer: true, tag: 'technical' },
  { text: 'Introduce yourself briefly and then we will get into the technical part.', answer: true, tag: 'imperative' },
  { text: 'Help me understand why you chose Kafka over SQS.', answer: true, tag: 'imperative' },
  { text: "I'd love to hear about a project you're proud of.", answer: true, tag: 'imperative' },
  { text: "I'm curious how you handled the rollback.", answer: true, tag: 'imperative', context: prevProject },
  { text: "Let's talk about your time at Stripe.", answer: true, tag: 'transition' },
  { text: 'Could you walk me through how you tested it', answer: true, tag: 'aux' },
  { text: 'Can you tell me about a conflict on your team', answer: true, tag: 'aux' },
  { text: "I'd like to understand your role in the launch.", answer: true, tag: 'imperative' },

  // ---- wh questions, with and without the "?" ----
  { text: 'Why that approach?', answer: true, tag: 'wh', context: prevProject },
  { text: 'Why that approach', answer: true, tag: 'no-qmark', context: prevProject },
  { text: 'What was your role there', answer: true, tag: 'no-qmark', context: prevProject },
  { text: 'What was the hardest part?', answer: true, tag: 'wh', context: prevProject },
  { text: 'How did you measure success', answer: true, tag: 'no-qmark' },
  { text: 'How would you scale this to ten million users?', answer: true, tag: 'technical' },
  { text: 'What is the difference between a process and a thread?', answer: true, tag: 'technical' },
  { text: 'Where do you see yourself in five years?', answer: true, tag: 'wh' },
  { text: 'Which database would you pick and why', answer: true, tag: 'no-qmark' },
  { text: 'Who did you work with most closely?', answer: true, tag: 'wh' },
  { text: "What's your biggest weakness?", answer: true, tag: 'wh' },
  { text: 'When did you decide to move into management?', answer: true, tag: 'wh' },
  { text: 'How come you left after a year?', answer: true, tag: 'wh' },
  { text: 'What are your salary expectations', answer: true, tag: 'no-qmark' },
  { text: 'So how do you usually approach code review', answer: true, tag: 'no-qmark' },
  { text: 'What would you do differently next time?', answer: true, tag: 'wh', context: prevProject },
  { text: 'Okay and how did the team react to that', answer: true, tag: 'no-qmark', context: prevProject },

  // ---- inverted auxiliaries ----
  { text: 'Have you ever had to fire someone?', answer: true, tag: 'aux' },
  { text: 'Do you have experience with Kubernetes?', answer: true, tag: 'aux' },
  { text: 'Did you own the on-call rotation', answer: true, tag: 'aux' },
  { text: 'Are you comfortable working across time zones?', answer: true, tag: 'aux' },
  { text: 'Would you do it the same way again?', answer: true, tag: 'aux', context: prevProject },
  { text: 'Is that something you would want to do here?', answer: true, tag: 'aux' },
  { text: 'Have you used GraphQL in production', answer: true, tag: 'aux' },
  { text: 'Could you have caught that earlier?', answer: true, tag: 'aux', context: prevProject },

  // ---- short follow-ups ----
  { text: 'And your role?', answer: true, tag: 'followup', context: prevProject },
  { text: 'And your role', answer: true, tag: 'followup', context: prevProject },
  { text: 'The timeline?', answer: true, tag: 'followup', context: prevProject },
  { text: 'And the outcome?', answer: true, tag: 'followup', context: prevProject },
  { text: 'How so?', answer: true, tag: 'followup', context: prevProject },
  { text: 'Meaning what?', answer: true, tag: 'followup', context: prevProject },
  { text: 'What about the second one?', answer: true, tag: 'followup', context: prevProject },
  { text: 'How big was the team', answer: true, tag: 'followup', context: prevProject },
  { text: 'Any regrets there?', answer: true, tag: 'followup', context: prevProject },
  { text: 'In what way?', answer: true, tag: 'followup', context: prevProject },

  // ---- multi-part ----
  {
    text: 'Tell me about a time you failed, what happened, and what you learned from it.',
    answer: true,
    tag: 'multi-part',
  },
  {
    text: 'Two questions: how did you shard the data, and how did you handle hot keys?',
    answer: true,
    tag: 'multi-part',
  },
  {
    text: 'We have a pretty big monolith here and we are slowly breaking it apart. How would you approach that?',
    answer: true,
    tag: 'multi-part',
  },
  {
    text: 'So our team is about twelve people, mostly backend. What kind of team do you work best in?',
    answer: true,
    tag: 'multi-part',
  },

  // ---- ambiguous but answer-worthy ----
  { text: 'Thoughts on microservices versus a modular monolith', answer: true, tag: 'no-qmark' },
  { text: 'Your take on TDD.', answer: true, tag: 'no-qmark' },
  { text: 'Any questions for me?', answer: true, tag: 'wh' },
  { text: 'Anything you would add?', answer: true, tag: 'wh', context: prevProject },

  // ---- backchannel / courtesy (never a cue) ----
  { text: 'Okay.', answer: false, tag: 'backchannel' },
  { text: 'Mm-hmm.', answer: false, tag: 'backchannel' },
  { text: 'Great, thanks.', answer: false, tag: 'backchannel' },
  { text: 'Yeah, that makes sense.', answer: false, tag: 'backchannel' },
  { text: 'Got it.', answer: false, tag: 'backchannel' },
  { text: 'Perfect.', answer: false, tag: 'backchannel' },
  { text: 'Right, right.', answer: false, tag: 'backchannel' },
  { text: 'Interesting.', answer: false, tag: 'backchannel' },
  { text: 'Cool, cool.', answer: false, tag: 'backchannel' },
  { text: 'Thank you so much.', answer: false, tag: 'backchannel' },
  { text: "That's a great example, thanks for sharing.", answer: false, tag: 'courtesy' },
  { text: 'That sounds like a really interesting project.', answer: false, tag: 'courtesy' },
  { text: 'Awesome, that was really helpful.', answer: false, tag: 'courtesy' },
  { text: "That's fair.", answer: false, tag: 'courtesy' },
  { text: 'Nice, I like that answer.', answer: false, tag: 'courtesy' },
  { text: 'Thanks for walking me through that.', answer: false, tag: 'courtesy' },

  // ---- interviewer statements ----
  { text: 'So a bit about us, we are a payments company with about two hundred engineers.', answer: false, tag: 'statement' },
  { text: 'The team you would be joining owns the checkout flow.', answer: false, tag: 'statement' },
  { text: 'We use mostly Go and some Python for the data pipelines.', answer: false, tag: 'statement' },
  { text: "I've been here about three years, I started on the platform team.", answer: false, tag: 'statement' },
  { text: 'The process from here is two more rounds and then a call with the hiring manager.', answer: false, tag: 'statement' },
  { text: 'We are really focused on reliability this year.', answer: false, tag: 'statement' },
  { text: 'I will leave about ten minutes at the end for your questions.', answer: false, tag: 'statement' },
  { text: 'Yeah, we had a similar problem with our ledger last year.', answer: false, tag: 'statement' },
  { text: 'So the role is about seventy percent hands-on coding.', answer: false, tag: 'statement' },
  { text: 'What we usually do here is pair on the first ticket.', answer: false, tag: 'statement' },
  { text: 'How we run on-call is a weekly rotation with a secondary.', answer: false, tag: 'statement' },
  { text: 'I think that covers the technical part.', answer: false, tag: 'statement' },
  { text: 'Honestly we struggled with the same migration.', answer: false, tag: 'statement' },

  // ---- logistics ----
  { text: 'Can you hear me okay?', answer: false, tag: 'logistics' },
  { text: 'Can you see my screen?', answer: false, tag: 'logistics' },
  { text: 'Let me share my screen.', answer: false, tag: 'logistics' },
  { text: 'One second, let me pull up the doc.', answer: false, tag: 'logistics' },
  { text: 'Sorry, you cut out for a second there.', answer: false, tag: 'logistics' },
  { text: 'I think you are on mute.', answer: false, tag: 'logistics' },
  { text: 'Bear with me.', answer: false, tag: 'logistics' },
  { text: 'Let me just check the time.', answer: false, tag: 'logistics' },
  { text: 'Is my audio coming through?', answer: false, tag: 'logistics' },

  // ---- transitions / rhetorical ----
  { text: 'Okay, let me think about how to phrase the next one.', answer: false, tag: 'transition' },
  { text: 'Alright, moving on.', answer: false, tag: 'transition' },
  { text: "Let's switch gears.", answer: false, tag: 'transition' },
  { text: 'Who knows, right?', answer: false, tag: 'rhetorical' },
  { text: "Isn't that always the way.", answer: false, tag: 'rhetorical' },
  { text: 'Take your time.', answer: false, tag: 'transition' },
  { text: 'Go ahead.', answer: false, tag: 'transition' },
  { text: 'Anyway.', answer: false, tag: 'transition' },
];
