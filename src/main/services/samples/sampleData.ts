import { db, schema } from '../../db';
import { profilesRepo } from '../../db/repositories/profiles.repo';
import { jobsRepo } from '../../db/repositories/jobs.repo';
import { parseResume, parseJobDescription } from '../openai/parsing';
import { reindexProfile, indexJob } from '../rag/indexProfile';
import { apiKeyStore } from '../security/apiKey';
import { isInterviewSpace } from '@shared/activities';
import type { ContextPackKind } from '@shared/types';

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

interface SampleJob {
  title: string;
  company: string;
  jdText: string;
  notes?: string;
  /** What this Space IS (shared/activities.ts). Defaults to `job` for the
   *  interview samples below. */
  kind?: ContextPackKind;
}

/**
 * The recurring meeting — deliberately FIRST, and deliberately not an
 * interview.
 *
 * Sample data is the first thing a new user sees, and it used to be three job
 * Spaces and nothing else, which said "this is an interview tool" before they
 * had done anything. It is also the only Space here that can demonstrate what
 * BrainCue is actually for: something you sit in on every week, that accumulates.
 */
const SAMPLE_MEETING: SampleJob = {
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
};

/** A finished conversation in that Space, so the "keep it → summarise → suggest
 *  a memory" loop can be seen without waiting to have a real meeting first.
 *  Left UNKEPT on purpose: pressing Keep is the user's decision, and watching
 *  it run is the point. */
const SAMPLE_TRANSCRIPT: { speaker: string; text: string }[] = [
  { speaker: 'them', text: 'Morning everyone — quick standup on the Atlas migration.' },
  { speaker: 'them', text: 'Phase two is still blocked on the renewal pricing sign-off from legal.' },
  { speaker: 'them', text: 'Keep updates concise please, under a minute each.' },
  { speaker: 'you', text: 'I can take the legal chase, but I want to see the September budget first.' },
  { speaker: 'them', text: 'Fine. Sam, can you pull the budget before Thursday?' },
  { speaker: 'them', text: 'And we commit to nothing before Friday.' },
];

/** A few realistic interview scenarios for common SWE targets. */
const SAMPLE_JOBS: SampleJob[] = [
  {
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
];

/**
 * Seed a sample profile (résumé), a recurring meeting Space with one finished
 * conversation in it, and a few realistic interview scenarios — parsing +
 * indexing them when a key is present so the user can try the full flow
 * immediately.
 *
 * Structured JD parsing runs on interview Spaces ONLY: it extracts requirements
 * and responsibilities, and running it over a standup agenda produces confident
 * nonsense (shared/activities.ts, `isInterviewSpace`).
 */
export async function loadSampleData(): Promise<{ profileId: string; jobs: number }> {
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

  const spaces = [SAMPLE_MEETING, ...SAMPLE_JOBS];
  let meetingSpaceId: string | null = null;
  for (const j of spaces) {
    const kind = j.kind ?? 'job';
    const job = jobsRepo.create({
      profileId: profile.id,
      kind,
      title: j.title,
      company: j.company,
      jdUrl: null,
      jdText: j.jdText,
      companyUrl: null,
      notes: j.notes ?? null,
    });
    if (kind === 'meeting') meetingSpaceId = job.id;
    if (hasKey && isInterviewSpace(kind)) {
      jobsRepo.update(job.id, { parsedJd: await parseJobDescription(j.jdText) });
    }
    await indexJob(job.id);
  }

  if (meetingSpaceId) seedSampleConversation(profile.id, meetingSpaceId);

  return { profileId: profile.id, jobs: spaces.length };
}

/**
 * A finished, unkept session in the sample meeting Space.
 *
 * Written straight to the tables rather than through sessionManager: there is
 * no audio to transcribe and no model to call, and the point is only to give
 * the continuity loop something real to act on. Left `stopped` and unkept, so
 * the archive and the memory suggestions are produced by the real pipeline when
 * the user decides to keep it — not fabricated here.
 */
function seedSampleConversation(profileId: string, packId: string): void {
  const id = crypto.randomUUID();
  const startedAt = Date.now() - 7 * 24 * 60 * 60 * 1000; // "last Tuesday"
  db()
    .insert(schema.sessions)
    .values({
      id,
      profileId,
      packId,
      activity: 'meeting',
      mode: 'meeting',
      kind: 'live',
      status: 'stopped',
      createdAt: startedAt,
      endedAt: startedAt + 11 * 60 * 1000,
    })
    .run();
  SAMPLE_TRANSCRIPT.forEach((turn, i) =>
    db()
      .insert(schema.transcriptChunks)
      .values({
        id: crypto.randomUUID(),
        sessionId: id,
        speaker: turn.speaker,
        text: turn.text,
        isFinal: 1,
        createdAt: startedAt + i * 30_000, // ordered, so the archive reads in sequence
      })
      .run(),
  );
}
