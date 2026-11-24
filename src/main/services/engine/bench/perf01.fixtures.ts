/**
 * PERF-01 measurement fixtures (M7.2b). SYNTHETIC: an invented candidate,
 * role and company. No real person's data, and nothing from a user's
 * sessions. The same fixtures drive the offline benchmark
 * (perf01.bench.test.ts) and the live run plan (docs/benchmarks/
 * PERF01-LIVE-PLAN.md), so a live result can be compared question by
 * question with the simulated one.
 *
 * Every question has a stable id, the category it is measured in, and the
 * fact its answer must be grounded on — with the source that holds it — so
 * a fast answer that lost its grounding fails rather than counts.
 *
 * Retrieval in the offline benchmark is real (chunker, index, vector store,
 * retriever, recall); its embedder is a deterministic TOPIC vector (one
 * dimension per topic word below). That makes "the right chunk ranks first"
 * a real outcome of the real ranking code, not a scripted reply.
 */

export const PERF01_VERSION = 'perf01-v1';

export type Source = 'resume' | 'jd' | 'company' | 'memory' | 'conversation' | 'session';

/** One topic of the candidate's history: the word retrieval keys on, and the
 *  exact fact the answer must carry. */
interface Topic {
  key: string;
  title: string;
  fact: string;
  detail: string;
}

/** The candidate's projects — one résumé paragraph each. */
const RESUME_TOPICS: Topic[] = [
  { key: 'atlas', title: 'Atlas cut-over', fact: '40 minutes of downtime', detail: 'moved the billing database to Postgres with three dry runs on production copies' },
  { key: 'ledger', title: 'payments ledger', fact: 'double-entry ledger handling 2.1 million entries a day', detail: 'replaced balance columns with an append-only journal and nightly reconciliation' },
  { key: 'kafka', title: 'event pipeline', fact: '14 Kafka topics with a 30-second end-to-end budget', detail: 'introduced schema registry checks and dead-letter queues for every consumer' },
  { key: 'oncall', title: 'on-call rotation', fact: 'cut pages per week from 46 to 9', detail: 'deleted symptom alerts and wrote runbooks for the five most common failures' },
  { key: 'mentoring', title: 'mentoring programme', fact: 'four junior engineers promoted within 18 months', detail: 'paired weekly, reviewed design docs together and rotated them through on-call' },
  { key: 'search', title: 'search relevance', fact: 'click-through on the first result rose from 31 to 44 percent', detail: 'added BM25 with field boosts and an offline judgement set of 600 queries' },
  { key: 'checkout', title: 'checkout rewrite', fact: 'checkout p95 fell from 2.4 seconds to 900 milliseconds', detail: 'split the monolith endpoint and moved tax calculation off the request path' },
  { key: 'terraform', title: 'infrastructure as code', fact: '230 hand-made cloud resources moved into Terraform modules', detail: 'imported state incrementally behind a drift report the team checked daily' },
  { key: 'fraud', title: 'fraud rules engine', fact: 'chargebacks down 37 percent in two quarters', detail: 'built a rules engine with shadow mode so analysts could test rules on live traffic' },
  { key: 'accessibility', title: 'accessibility audit', fact: 'all 112 WCAG AA issues closed before the public launch', detail: 'added axe checks to CI and ran sessions with screen-reader users' },
  { key: 'graphql', title: 'GraphQL gateway', fact: 'seven REST services behind one GraphQL schema', detail: 'used persisted queries and per-field cost limits to protect the backends' },
  { key: 'cache', title: 'read cache', fact: 'cache hit rate of 92 percent on product pages', detail: 'used request coalescing and stale-while-revalidate to stop thundering herds' },
  { key: 'hiring', title: 'hiring loop', fact: 'time to offer reduced from 41 to 19 days', detail: 'replaced take-home tests with a paid pairing session and a structured rubric' },
  { key: 'mobile', title: 'mobile release train', fact: 'weekly mobile releases with a crash-free rate of 99.8 percent', detail: 'added staged rollouts, feature flags and an automated rollback on crash spikes' },
];

/** What the role asks for — one JD paragraph each. */
const JD_TOPICS: Topic[] = [
  { key: 'latency', title: 'latency budget', fact: 'p99 under 200 milliseconds for the quote API', detail: 'the team owns the quote API that every partner integration calls synchronously' },
  { key: 'multiregion', title: 'multi-region', fact: 'active-active in three regions by the end of next year', detail: 'the platform is single-region today and the move must not lose a single order' },
  { key: 'compliance', title: 'compliance', fact: 'SOC 2 Type II renewal every March', detail: 'engineers own evidence collection for change management and access reviews' },
  { key: 'observability', title: 'observability', fact: 'OpenTelemetry traces on every service by Q3', detail: 'the current logs-only setup makes cross-service incidents slow to diagnose' },
  { key: 'leadership', title: 'technical leadership', fact: 'lead a group of six backend engineers', detail: 'the role sets technical direction and reviews every design document for the group' },
  { key: 'pricing', title: 'pricing engine', fact: 'pricing rules changed by analysts without a deploy', detail: 'today every pricing change needs an engineer and a release' },
];

/** The company — research the user saved for this Space. */
const COMPANY_TOPICS: Topic[] = [
  { key: 'northwind', title: 'Northwind mission', fact: 'insurance quotes for small logistics firms in under a minute', detail: 'Northwind sells commercial insurance to fleets of five to fifty vehicles' },
  { key: 'funding', title: 'funding', fact: 'a 60 million Series C in April', detail: 'the round funds expansion into Germany and the Netherlands' },
  { key: 'values', title: 'values', fact: 'write it down, ship it small, own the outcome', detail: 'the engineering handbook is public and reviewed every quarter' },
];

/** Approved memories (the user's own saved notes about how they answer). */
export const MEMORIES: { id: string; key: string; content: string }[] = [
  { id: 'perf01-mem-1', key: 'salary', content: 'For salary questions: say the range is 165 to 180 thousand and that equity matters more than base.' },
  { id: 'perf01-mem-2', key: 'relocation', content: 'For relocation questions: open to relocating to Rotterdam from June; not open to full-time travel.' },
];

/** Every topic word — the deterministic embedder's dimensions. */
export const TOPIC_WORDS: string[] = [
  ...RESUME_TOPICS,
  ...JD_TOPICS,
  ...COMPANY_TOPICS,
].map((t) => t.key).concat(MEMORIES.map((m) => m.key));

const paragraph = (t: Topic, who: string) =>
  `${t.title} (${t.key}). ${who} ${t.detail}. The result: ${t.fact}. ` +
  `This ${t.key} work was planned with the product team, reviewed in a written design document, rolled out behind a flag, ` +
  `and measured for a full quarter before it was called done; the dashboards and the runbook stayed with the team that runs it. ` +
  `Along the way the hardest calls were about scope: what to leave out of the first release, which teams to bring in early, and how to ` +
  `explain the trade-offs to people who would live with them, so the write-up records what we chose not to do as well as what we did.`;

export const PROFILE = {
  name: 'Jordan Vega (synthetic)',
  targetRole: 'Staff Backend Engineer',
  targetCompany: 'Northwind Mutual',
  resumeText: RESUME_TOPICS.map((t) => paragraph(t, 'I')).join('\n\n'),
};

export const SPACE = {
  title: 'Northwind — Staff Backend Engineer (synthetic)',
  company: 'Northwind Mutual',
  jdText: JD_TOPICS.map((t) => paragraph(t, 'The team')).join('\n\n'),
  companyResearch: COMPANY_TOPICS.map((t) => paragraph(t, 'Northwind')).join('\n\n'),
};

export type Category = 'general' | 'technical';

export interface Question {
  /** Stable across runs and between the offline and live benchmarks. */
  id: string;
  category: Category;
  text: string;
  /** The answer's grounding must contain this … */
  fact: string;
  /** … from this source. */
  source: Source;
}

const topic = (key: string): Topic =>
  [...RESUME_TOPICS, ...JD_TOPICS, ...COMPANY_TOPICS].find((t) => t.key === key)!;
const mem = (key: string) => MEMORIES.find((m) => m.key === key)!;

const G = (n: number, text: string, key: string, source: Source = 'resume'): Question => ({
  id: `G${String(n).padStart(2, '0')}`,
  category: 'general',
  text,
  fact: source === 'memory' ? mem(key).content.split(': ')[1].slice(0, 30) : topic(key).fact,
  source,
});
const T = (n: number, text: string, key: string, source: Source = 'resume'): Question => ({
  id: `T${String(n).padStart(2, '0')}`,
  category: 'technical',
  text,
  fact: topic(key).fact,
  source,
});

/** 30 General interview questions — behavioural, project and fit. */
export const GENERAL: Question[] = [
  G(1, 'Tell me about the Atlas cut-over you led.', 'atlas'),
  G(2, 'How did you handle the on-call situation when the oncall load got out of hand?', 'oncall'),
  G(3, 'Can you tell me about your mentoring of junior engineers?', 'mentoring'),
  G(4, 'What was the hardest part of the hiring loop redesign?', 'hiring'),
  G(5, 'Tell me about a time the fraud work changed a business number.', 'fraud'),
  G(6, 'How did you get the accessibility audit done before launch?', 'accessibility'),
  G(7, 'Why do you want to work at Northwind?', 'northwind', 'company'),
  G(8, 'What do you know about our funding and where we are going?', 'funding', 'company'),
  G(9, 'Which of our values resonates with you most?', 'values', 'company'),
  G(10, 'What are your salary expectations?', 'salary', 'memory'),
  G(11, 'Would you consider relocation for this role?', 'relocation', 'memory'),
  G(12, 'Tell me about the mobile release train you set up.', 'mobile'),
  G(13, 'How would you approach the leadership of a group of six engineers here?', 'leadership', 'jd'),
  G(14, 'Tell me about a project where checkout performance mattered.', 'checkout'),
  G(15, 'What did you learn from the search relevance project?', 'search'),
  G(16, 'How do you feel about owning compliance evidence like SOC 2?', 'compliance', 'jd'),
  G(17, 'Tell me about a time you had to convince people about the terraform migration.', 'terraform'),
  G(18, 'What was your role in the payments ledger project?', 'ledger'),
  G(19, 'How did the cache work affect the product pages?', 'cache'),
  G(20, 'Tell me about a time an incident on the kafka pipeline went badly.', 'kafka'),
  G(21, 'What would your first ninety days on the pricing engine look like?', 'pricing', 'jd'),
  G(22, 'How did you measure success on the GraphQL gateway?', 'graphql'),
  G(23, 'Why are you leaving your current role after the hiring work?', 'hiring'),
  G(24, 'Tell me about a disagreement during the Atlas planning.', 'atlas'),
  G(25, 'How do you mentor someone who is struggling on oncall?', 'oncall'),
  G(26, 'What excites you about the multiregion plans here?', 'multiregion', 'jd'),
  G(27, 'How did you prioritise the accessibility fixes?', 'accessibility'),
  G(28, 'What did the fraud team think of shadow mode at first?', 'fraud'),
  G(29, 'Tell me about the mobile crash spikes you dealt with.', 'mobile'),
  G(30, 'How would you describe your leadership style for a group this size?', 'leadership', 'jd'),
];

/** 30 simple Technical questions — short explanations, not coding. */
export const TECHNICAL: Question[] = [
  T(1, 'How would you keep the quote API latency under its p99 budget?', 'latency', 'jd'),
  T(2, 'How does a double-entry ledger avoid balance drift?', 'ledger'),
  T(3, 'What is a dead-letter queue and when did you use one on kafka?', 'kafka'),
  T(4, 'How does request coalescing protect a cache?', 'cache'),
  T(5, 'What would you change first to go multiregion active-active?', 'multiregion', 'jd'),
  T(6, 'How would you add OpenTelemetry observability across services?', 'observability', 'jd'),
  T(7, 'What is stale-while-revalidate and why use it for the cache?', 'cache'),
  T(8, 'How did BM25 field boosts help search?', 'search'),
  T(9, 'How do persisted queries protect a GraphQL gateway?', 'graphql'),
  T(10, 'How would you let analysts change the pricing engine without a deploy?', 'pricing', 'jd'),
  T(11, 'How do you import existing resources into terraform safely?', 'terraform'),
  T(12, 'What does shadow mode mean for a fraud rules engine?', 'fraud'),
  T(13, 'How would you make the Atlas database migration reversible?', 'atlas'),
  T(14, 'How do staged rollouts lower mobile crash risk?', 'mobile'),
  T(15, 'What makes an alert actionable for oncall?', 'oncall'),
  T(16, 'How would you split a slow checkout endpoint?', 'checkout'),
  T(17, 'How would you collect SOC 2 compliance evidence for change management?', 'compliance', 'jd'),
  T(18, 'How do you design a schema registry check for kafka consumers?', 'kafka'),
  T(19, 'What is the difference between p95 and p99 latency for the quote API?', 'latency', 'jd'),
  T(20, 'How would you reconcile a ledger nightly?', 'ledger'),
  T(21, 'How would you trace a request across services with observability tooling?', 'observability', 'jd'),
  T(22, 'How would you test a database migration like Atlas before production?', 'atlas'),
  T(23, 'How do per-field cost limits work in GraphQL?', 'graphql'),
  T(24, 'How do you build an offline judgement set for search?', 'search'),
  T(25, 'How would you detect drift in terraform state?', 'terraform'),
  T(26, 'How would you move tax calculation off the checkout request path?', 'checkout'),
  T(27, 'What does automated rollback on mobile crash spikes need?', 'mobile'),
  T(28, 'How would you design multiregion order writes without losing orders?', 'multiregion', 'jd'),
  T(29, 'How would you keep pricing rules testable?', 'pricing', 'jd'),
  T(30, 'How do runbooks reduce oncall pages?', 'oncall'),
];

/** Conversation scenarios — follow-ups, topic changes and long sessions. */
export const SCENARIOS = {
  /** A referential follow-up keeps its subject; a topic change drops it. */
  followup: [
    { id: 'F01', text: 'Tell me about the Atlas cut-over you led.', fact: topic('atlas').fact, source: 'resume' as Source },
    { id: 'F02', text: 'What was your role there?', fact: topic('atlas').fact, source: 'resume' as Source },
    { id: 'F03', text: 'Why do you want to work at Northwind?', fact: topic('northwind').fact, source: 'company' as Source },
  ],
  /** Said by the candidate early in a long session; recalled 30+ exchanges later. */
  longSession: {
    early: { q: 'Tell me about a migration you led.', said: 'The one I am proudest of is the Atlas cut-over: we ended with 40 minutes of downtime and I wrote the rollback plan myself on a whiteboard in Lisbon.' },
    filler: (i: number) => ({ q: `What did you work on in quarter ${i}?`, said: `In quarter ${i} I worked on the reporting service, mostly the caching layer number ${i}.` }),
    recall: { id: 'L01', text: 'Coming back to the Atlas cut-over, where did you write the rollback plan?', fact: 'whiteboard in Lisbon', source: 'conversation' as Source },
    /** Asked in a NEW session of the same Space, after the first was archived. */
    archived: { id: 'A01', text: 'Last time we spoke about the Atlas rollback plan — where did you write it?', fact: 'whiteboard in Lisbon', source: 'session' as Source },
  },
};

/** Size of the knowledge base — reported with every run so a faster
 *  result can never come from a smaller one. */
export function knowledgeBaseSize() {
  return {
    resumeChars: PROFILE.resumeText.length,
    jdChars: SPACE.jdText.length,
    companyChars: SPACE.companyResearch.length,
    memories: MEMORIES.length,
  };
}

/** Deterministic topic embedding: one dimension per topic word (its count
 *  in the text), plus a small shared component so every cosine is defined. */
export function topicVector(text: string): Float32Array {
  const t = text.toLowerCase();
  return Float32Array.from(TOPIC_WORDS.map((w) => (t.split(w).length - 1) + 0.02));
}
