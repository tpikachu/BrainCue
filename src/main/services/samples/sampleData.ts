import { db, schema } from '../../db';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { jobsRepo } from '../../db/repositories/jobs.repo';
import { parseResume, parseJobDescription } from '../openai/parsing';
import { reindexProfile, indexJob } from '../rag/indexProfile';
import { apiKeyStore } from '../security/apiKey';
import { isInterviewSpace, modeFor } from '@shared/activities';
import type { ContextPackKind } from '@shared/types';

/**
 * The demo world.
 *
 * This is both the "Load sample data" button AND the world every screenshot and
 * every second of the demo video is captured from (docs/21-MEDIA.md). Those are
 * deliberately the same thing: a fixture that exists only for the marketing
 * capture is exactly how a product film drifts from the product — the video
 * shows a populated, articulate app and the user's first run shows an empty one.
 * Anyone who watches the video can press one button and be standing in the same
 * room.
 *
 * The rule that keeps it honest: **nothing downstream is fabricated here.** No
 * archives, no summaries, no memories are written directly. What is seeded is
 * only the raw input a user would have produced — a résumé, some Spaces, and
 * finished conversations with transcripts. Every derived artifact in the video
 * is produced by the real pipeline at capture time, from this input.
 */

/** A realistic sample résumé so users can try the full flow without their own. */
const SAMPLE_RESUME = `Alex Rivera — Senior Software Engineer
San Francisco, CA · alex.rivera@example.com · github.com/alexrivera

SUMMARY
Senior software engineer with 8 years building large-scale web platforms and
distributed backends. Strong in TypeScript, Go, and React; comfortable from
product UI to systems design. Led teams of 4–6 and shipped products to millions
of users.

EXPERIENCE
Staff Software Engineer — Northwind (2021–present)
- Led the redesign of the checkout service (Go, gRPC, Postgres) cutting p99
  latency from 1.2s to 280ms and lifting conversion 3.4%.
- Built an event-driven inventory pipeline (Kafka) processing 40M events/day;
  drove on-call from 12 to 2 pages/week with better backpressure + alerting.
- Mentored 5 engineers; introduced an RFC process now used company-wide.

Senior Software Engineer — Brightloom (2017–2021)
- Rebuilt the customer dashboard in React + TypeScript; reduced bundle size 45%
  and time-to-interactive from 6s to 1.9s.
- Designed a multi-tenant permissions model (RBAC) adopted across 3 products.
- Owned the migration from a monolith to 8 services with zero customer downtime.

Software Engineer — Datalith (2015–2017)
- Shipped the first version of the analytics ingestion API (Node.js).

SKILLS
TypeScript, JavaScript, Go, Python, React, Node.js, Postgres, Redis, Kafka,
gRPC, GraphQL, AWS, Kubernetes, Terraform, system design, distributed systems.

EDUCATION
B.S. Computer Science — UC Berkeley (2015)`;

interface SampleSpace {
  /** Stable handle used by the conversations below and by the capture spec. */
  key: string;
  /** What this Space IS (shared/activities.ts). */
  kind: ContextPackKind;
  title: string;
  company: string;
  jdText: string;
  notes?: string;
}

/**
 * Seven Spaces across five activities.
 *
 * Order matters: sample data is the first thing a new user sees, and when it was
 * three job Spaces and nothing else it said "this is an interview tool" before
 * they had done anything. The recurring meeting is first, the interviews are in
 * the middle, and a house move is in there because the claim "any conversation"
 * is either true in the sample data or it is marketing.
 */
const SAMPLE_SPACES: SampleSpace[] = [
  {
    key: 'standup',
    kind: 'meeting',
    title: 'Tuesday standup — Atlas',
    company: 'Atlas platform team',
    notes:
      'Priya runs it. Keep updates under a minute. Never commit to dates in the room — take them away and confirm.',
    jdText: `Tuesday standup — Atlas platform team

Purpose: a 15-minute sync on the Atlas migration. Not a status theatre — the
point is to surface blockers early enough that someone can act on them.

Who is in it:
- Priya (EM, runs it), Dan (backend), Mei (infra), Sam (product, occasional).

How it runs:
- Round the room, under a minute each: what moved, what is blocked, what you need.
- Blockers get an owner and a date before the meeting ends, or they get carried.
- Decisions that affect other teams are written down and shared the same day.

Current state:
- Phase one shipped in June. Phase two is scoped but not started.
- The renewal pricing sign-off from legal is the standing blocker on phase two.
- Budget is fixed through September.`,
  },
  {
    key: 'atlas',
    kind: 'project',
    title: 'Atlas migration',
    company: 'Platform team',
    notes: 'Phase 2 cannot start before legal signs off. Mei owns the infra cutover plan.',
    jdText: `Atlas migration — project brief

Goal: move the billing and entitlement services off the legacy monolith onto the
Atlas platform, without a customer-visible outage and without a pricing change.

Scope:
- Phase one (done, June): read paths moved behind a proxy; dual-write in place.
- Phase two: writes cut over, legacy tables frozen, proxy removed.
- Out of scope: the reporting warehouse, which moves next year.

Decisions already made:
- Dual-write stays for one full billing cycle after cutover, then is deleted.
- No customer-visible pricing change during the migration — this is why legal
  sign-off on renewal pricing gates phase two.
- Rollback is a proxy flag flip, not a data restore.

Open threads:
- Who owns the entitlement cache invalidation after the proxy is removed.
- Whether the September freeze applies to internal-only services.`,
  },
  {
    key: 'google',
    kind: 'job',
    title: 'Software Engineer, L4',
    company: 'Google',
    notes:
      'Recruiter: Jamie. Loop: 1 coding, 1 system design, 1 behavioral (Googleyness & Leadership), 1 coding. Emphasis on data structures, scalability, and clear communication.',
    jdText: `Google — Software Engineer, L4 (Full Stack)

Minimum qualifications:
- Bachelor's degree in CS or equivalent practical experience.
- 2+ years of experience with software development in one or more general
  purpose programming languages (Java, C++, Python, Go, JavaScript/TypeScript).
- Experience with data structures and algorithms.

Preferred:
- Experience designing and operating large-scale distributed systems.
- Experience building full-stack web applications (React, gRPC/REST APIs).
- Strong communication and a track record of cross-functional collaboration.

Responsibilities:
- Design, develop, test, deploy, maintain, and improve software.
- Manage individual project priorities, deadlines, and deliverables.
- Contribute to system design reviews and mentor junior engineers.`,
  },
  {
    key: 'amazon',
    kind: 'job',
    title: 'Software Development Engineer II (SDE II)',
    company: 'Amazon',
    notes:
      'Loop centers on the Leadership Principles — prepare STAR stories (Customer Obsession, Ownership, Dive Deep, Bias for Action). Plus 2 coding + 1 system design.',
    jdText: `Amazon — Software Development Engineer II

Basic qualifications:
- 3+ years of non-internship professional software development experience.
- Experience programming with at least one modern language (Java, C++, Go,
  TypeScript) and with data structures, algorithms, and complexity analysis.
- Experience contributing to the architecture and design of new and current
  systems (scalability, reliability, availability).

Preferred:
- Experience with distributed systems, microservices, and AWS.
- Experience leading design or architecture of new and existing systems.

Responsibilities:
- Own the design and delivery of services used by millions of customers.
- Raise the bar on operational excellence: monitoring, on-call, and resilience.
- Embody Amazon's Leadership Principles in how you build and collaborate.`,
  },
  {
    key: 'stripe',
    kind: 'job',
    title: 'Senior Frontend Engineer',
    company: 'Stripe',
    notes:
      'Mostly practical: a React/TypeScript take-home discussion, a UI system-design round, and behavioral on past impact. They value craft and DX.',
    jdText: `Stripe — Senior Frontend Engineer

About the role:
We're looking for a senior engineer to build delightful, accessible, high-
performance interfaces for our financial products used by millions of businesses.

What you'll do:
- Build complex, reliable UI in React + TypeScript with a focus on performance
  and accessibility (WCAG).
- Partner with design and product to ship features end-to-end.
- Improve our component library, testing, and frontend architecture.

We're looking for:
- 5+ years building production web applications, deep React + TypeScript.
- Strong understanding of browser performance, state management, and testing.
- Care about developer experience and craft; clear written communication.`,
  },
  {
    key: 'consensus',
    kind: 'subject',
    title: 'Distributed systems',
    company: 'MIT 6.824',
    notes: 'Exam in November. Weakest on consensus — Raft leader election especially.',
    jdText: `Distributed systems — working notes

Where I am: through the Raft paper and lab 2A. Comfortable with the log
replication argument, shaky on the election-restriction proof.

The parts that keep not sticking:
- Why a candidate with a shorter log cannot win an election (the
  up-to-date check compares last term first, then index).
- What exactly commitment means across a term boundary, and why a leader may
  not commit an entry from a previous term by counting replicas alone.
- The difference between the state machine safety property and log matching.

Next: lab 2B, then re-read section 5.4.`,
  },
  {
    key: 'move',
    kind: 'personal',
    title: 'House move',
    company: 'Sam — the agent',
    notes: 'Completion is 12 September. Do not agree to a date on a call without checking the survey.',
    jdText: `House move — background

Buying at 14 Fenwick Road; chain of three. Completion currently pencilled for
12 September.

Who is who:
- Sam — the estate agent, calls on Fridays.
- Ellen — the solicitor, only emails.
- The seller is waiting on their own purchase, which is the real risk.

Things already agreed:
- The survey money is spent; the damp report came back clear.
- The seller pays for the boiler service before completion.
- Nothing is agreed on the fixtures list yet.`,
  },
];

interface SampleConversation {
  /** Which Space this happened in (`SampleSpace.key`). */
  space: string;
  daysAgo: number;
  minutes: number;
  /** Left unkept — the user pressing Keep is the demo, so it must not be
   *  pre-pressed. See `keepable` below. */
  turns: { speaker: string; text: string }[];
}

/**
 * Finished conversations, all left UNKEPT.
 *
 * Keeping one is what runs the archive + memory-extraction pipeline, and that
 * decision belongs to whoever is sitting in front of the app — so it is never
 * pre-pressed here. The capture spec keeps the two older standups (producing
 * real archives and real memory candidates), and leaves the most recent one
 * alone so the video can show the decision being made.
 *
 * The two older standups are written so that a fact CHANGES between them:
 * phase two is a September start in the first and slips to October in the
 * second. That is the whole reason they exist. It gives the extractor a genuine
 * contradiction to find, so the Replace/supersede scene in the video shows real
 * output rather than a staged screen — and if the model does not spot it, the
 * scene is dropped rather than faked (docs/21-MEDIA.md § Scenes that may not
 * appear).
 */
const SAMPLE_CONVERSATIONS: SampleConversation[] = [
  {
    space: 'standup',
    daysAgo: 21,
    minutes: 12,
    turns: [
      { speaker: 'them', text: 'Morning — standup on the Atlas migration.' },
      { speaker: 'them', text: 'Phase one is done. Phase two is scoped and we are starting it in September.' },
      { speaker: 'them', text: 'The one thing in the way is the renewal pricing sign-off from legal.' },
      { speaker: 'you', text: 'I can take the legal chase if someone else owns the cutover plan.' },
      { speaker: 'them', text: 'Mei owns the cutover plan. Alex owns the legal chase.' },
      { speaker: 'them', text: 'Reminder that budget is fixed through September, so nothing that costs money.' },
    ],
  },
  {
    space: 'standup',
    daysAgo: 7,
    minutes: 14,
    turns: [
      { speaker: 'them', text: 'Standup. Quick one, Priya has a hard stop.' },
      { speaker: 'them', text: 'Legal came back and they want another two weeks on renewal pricing.' },
      { speaker: 'them', text: 'So phase two is not starting in September. We are moving it to October.' },
      { speaker: 'you', text: 'That pushes the dual-write window into the December freeze.' },
      { speaker: 'them', text: 'Noted. Mei, can you re-cut the cutover plan against an October start?' },
      { speaker: 'them', text: 'And nobody commits to a customer-facing date until legal is actually signed.' },
    ],
  },
  {
    space: 'standup',
    daysAgo: 0,
    minutes: 11,
    turns: [
      { speaker: 'them', text: 'Morning everyone — quick standup on the Atlas migration.' },
      { speaker: 'them', text: 'Phase two is still blocked on the renewal pricing sign-off from legal.' },
      { speaker: 'them', text: 'Keep updates concise please, under a minute each.' },
      { speaker: 'you', text: 'I can take the legal chase, but I want to see the September budget first.' },
      { speaker: 'them', text: 'Fine. Sam, can you pull the budget before Thursday?' },
      { speaker: 'them', text: 'And we commit to nothing before Friday.' },
    ],
  },
  {
    space: 'atlas',
    daysAgo: 11,
    minutes: 34,
    turns: [
      { speaker: 'them', text: 'This is the design review for the phase two cutover.' },
      { speaker: 'you', text: 'The proposal is to keep dual-write for one full billing cycle, then delete it.' },
      { speaker: 'them', text: 'What is the rollback if entitlements go wrong after the proxy is removed?' },
      { speaker: 'you', text: 'Flip the proxy flag back. It is not a data restore, which is the point of keeping dual-write.' },
      { speaker: 'them', text: 'Agreed. Write that down — rollback is a flag flip, not a restore.' },
      { speaker: 'them', text: 'Open question nobody owns yet: entitlement cache invalidation once the proxy is gone.' },
    ],
  },
  {
    space: 'move',
    daysAgo: 4,
    minutes: 9,
    turns: [
      { speaker: 'them', text: 'Hi, it is Sam — quick update on Fenwick Road.' },
      { speaker: 'them', text: 'The seller is asking whether you could complete a week earlier, on the fifth.' },
      { speaker: 'you', text: 'I am not agreeing to a date on the phone. Send it to Ellen and I will confirm.' },
      { speaker: 'them', text: 'Understood. Also they want the fixtures list back this week.' },
      { speaker: 'them', text: 'And the boiler service is booked for the week before completion, as agreed.' },
    ],
  },
];

/**
 * Seed the demo world: one profile with a résumé, seven Spaces across five
 * activities, and five finished conversations waiting to be kept.
 *
 * Parsing + indexing run when a key is present, so retrieval works immediately.
 * Structured JD parsing runs on interview Spaces ONLY: it extracts requirements
 * and responsibilities, and running it over a standup agenda produces confident
 * nonsense (shared/activities.ts, `isInterviewSpace`).
 */
export async function loadSampleData(): Promise<{
  profileId: string;
  jobs: number;
  conversations: number;
}> {
  const hasKey = apiKeyStore.isPresent();

  const profile = profilesRepo.create({
    name: 'Alex Rivera (sample)',
    targetRole: 'Senior Software Engineer',
    targetCompany: null,
    interviewType: 'general',
    language: 'en',
    resumeText: SAMPLE_RESUME,
    jdText: null,
  });
  if (hasKey) profilesRepo.update(profile.id, { parsedResume: await parseResume(SAMPLE_RESUME) });
  await reindexProfile(profile.id);

  const spaceIds = new Map<string, string>();
  for (const s of SAMPLE_SPACES) {
    const job = jobsRepo.create({
      profileId: profile.id,
      kind: s.kind,
      title: s.title,
      company: s.company,
      jdUrl: null,
      jdText: s.jdText,
      companyUrl: null,
      notes: s.notes ?? null,
    });
    spaceIds.set(s.key, job.id);
    if (hasKey && isInterviewSpace(s.kind)) {
      jobsRepo.update(job.id, { parsedJd: await parseJobDescription(s.jdText) });
    }
    await indexJob(job.id);
  }

  const kindOf = new Map(SAMPLE_SPACES.map((s) => [s.key, s.kind]));
  let conversations = 0;
  for (const c of SAMPLE_CONVERSATIONS) {
    const packId = spaceIds.get(c.space);
    const kind = kindOf.get(c.space);
    if (!packId || !kind) continue; // a renamed key must not seed an orphan session
    seedSampleConversation(profile.id, packId, kind, c);
    conversations++;
  }

  return { profileId: profile.id, jobs: SAMPLE_SPACES.length, conversations };
}

/**
 * One finished, unkept session with its transcript.
 *
 * Written straight to the tables rather than through sessionManager: there is
 * no audio to transcribe and no model to call, and the point is only to give
 * the continuity loop something real to act on. Left `stopped` and unkept, so
 * the archive and the memory suggestions are produced by the real pipeline when
 * the user decides to keep it — not fabricated here.
 *
 * `mode` is derived through `modeFor`, never hardcoded: a project discussion and
 * a standup both run the meeting engine today, and a seeded session that
 * disagreed with the catalog would be a fixture quietly asserting a mapping the
 * app does not use.
 */
function seedSampleConversation(
  profileId: string,
  packId: string,
  kind: ContextPackKind,
  c: SampleConversation,
): void {
  const id = crypto.randomUUID();
  const startedAt = Date.now() - c.daysAgo * 24 * 60 * 60 * 1000;
  const endedAt = startedAt + c.minutes * 60 * 1000;
  db()
    .insert(schema.sessions)
    .values({
      id,
      profileId,
      packId,
      activity: kind,
      mode: modeFor(kind),
      kind: 'live',
      status: 'stopped',
      startedAt,
      createdAt: startedAt,
      endedAt,
    })
    .run();
  // Spread the turns across the real duration so the archive reads in sequence
  // and the Sessions list shows a believable length.
  const step = Math.max(1, Math.floor((endedAt - startedAt) / (c.turns.length + 1)));
  c.turns.forEach((turn, i) =>
    db()
      .insert(schema.transcriptChunks)
      .values({
        id: crypto.randomUUID(),
        sessionId: id,
        speaker: turn.speaker,
        text: turn.text,
        isFinal: 1,
        createdAt: startedAt + (i + 1) * step,
      })
      .run(),
  );
}
