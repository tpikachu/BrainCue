import { test as base, expect, type Page } from '@playwright/test';
import { calls, launchHarness, type Harness } from './harness/harness';

/**
 * M6 — readable history and truthful Keep results, on the REAL Sessions page,
 * session detail and save prompt (renderer harness: one hidden Electron
 * window, a recording fake bridge, no database, no network, no key).
 *
 *  - Opening a saved session asks main for the persisted session ONLY — no
 *    report, no model call — and shows what was said and what BrainCue
 *    suggested, marked apart. A report is an explicit action whose failure
 *    leaves the conversation readable.
 *  - Keep reports each half as it actually went (saved / off / no Space /
 *    failed with a Retry), names where the transcript goes, validates the
 *    destination wherever the picker found it, and stays open while busy.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const readiness = {
  chat: { ready: true, provider: 'anthropic', model: 'm', classifyModel: 'm', explanation: 'x' },
  transcription: { ready: true, engine: 'local' },
  retrieval: { ready: true, mode: 'lexical' },
  routes: { answer: 'anthropic', classify: 'anthropic', parsing: 'anthropic' },
  features: { parsing: { ready: true }, mock: { ready: true }, sparring: { ready: true }, tailoring: { ready: true } },
};
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  profileId: 'pA',
  jobId: 'R1',
  activity: 'job',
  mode: 'interview',
  kind: 'live',
  interviewType: 'general',
  status: 'stopped',
  startedAt: Date.UTC(2026, 10, 17, 15, 0),
  endedAt: Date.UTC(2026, 10, 17, 15, 32),
  createdAt: Date.UTC(2026, 10, 17, 15, 0) + Number(id.replace(/\D/g, '') || 0),
  jobTitle: 'Backend Engineer',
  jobCompany: 'Acme',
  profileName: 'Alex',
  typeCounts: { behavioral: 1 },
  ...over,
});
const chunk = (id: string, speaker: string, text: string, createdAt: number) => ({ id, sessionId: 'h1', speaker, text, isFinal: true, tStart: null, tEnd: null, createdAt });
const DETAIL_H1 = {
  ...item('h1'),
  transcript: [
    chunk('t1', 'interviewer', 'Tell me about a migration you led.', 10),
    chunk('t2', 'candidate', 'Sure — we moved billing from MySQL to Postgres with a dual-write window.', 20),
    chunk('t3', 'interviewer', 'How did you roll back if something broke?', 30),
  ],
  questions: [
    {
      id: 'q1', sessionId: 'h1', text: 'Tell me about a migration you led.', type: 'behavioral', confidence: 1, strategy: '', createdAt: 11, transcriptChunkId: 't1',
      answer: { id: 'a1', questionId: 'q1', directAnswer: 'Lead with the billing cut-over: dual writes, then a verified switch.', riskWarning: null, followupQuestion: null, model: 'm', tokens: null, createdAt: 12 },
    },
    {
      id: 'q2', sessionId: 'h1', text: 'How did you roll back if something broke?', type: 'behavioral', confidence: 1, strategy: '', createdAt: 31, transcriptChunkId: 't3',
      answer: { id: 'a2', questionId: 'q2', directAnswer: '', riskWarning: 'Asked while paused — not answered. Press ↻ to answer it.', followupQuestion: null, model: 'm', tokens: null, createdAt: 32 },
    },
  ],
  report: null,
  cards: [],
  spaceTitle: 'Backend Engineer',
  spaceCompany: 'Acme',
};
const DETAIL_M = {
  ...item('m1', { mode: 'meeting', activity: 'meeting', jobId: 'ST', jobTitle: 'Daily standup', jobCompany: null }),
  transcript: [chunk('mt1', 'them', 'Can we ship on Friday?', 10), chunk('mt2', 'you', 'Yes, if QA signs off.', 20)],
  questions: [],
  report: null,
  cards: [{ id: 'c1', sessionId: 'm1', kind: 'decision', status: 'completed', title: null, body: 'Ship Friday, pending QA', meta: null, sourceRefs: null, createdAt: 25, updatedAt: 25 }],
  spaceTitle: 'Daily standup',
  spaceCompany: null,
};

const DETAIL_QA = {
  ...item('qa1', { mode: 'companion', activity: null, jobId: null, jobTitle: null, jobCompany: null, typeCounts: {} }),
  transcript: [],
  questions: [],
  report: null,
  // Exactly what a saved voice quick Ask persists: one answer card, no
  // detected question, no transcript.
  cards: [{ id: 'qa-c1', sessionId: 'qa1', kind: 'answer', status: 'completed', title: 'What is a write-ahead log?', body: 'A log written before changes are applied, so a crash can replay them.', meta: { source: 'voice_quick_ask' }, sourceRefs: null, createdAt: 5, updatedAt: 5 }],
  spaceTitle: null,
  spaceCompany: null,
};
const role = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, profileId: 'pA', kind: 'job', title, company: 'Acme', memoryEnabled: true, updatedAt: 1, ...over });
const FIXTURE = {
  profiles: [{ id: 'pA', name: 'Alex', parsedResume: { skills: ['TS'] }, resumeText: 'x' }],
  readiness,
  history: {
    pA: [item('h1'), item('m1', { mode: 'meeting', activity: 'meeting', jobId: 'ST', jobTitle: 'Daily standup', jobCompany: null }), ...Array.from({ length: 12 }, (_, i) => item(`old${i}`, { createdAt: 1000 + i }))],
  },
  details: { h1: DETAIL_H1, m1: DETAIL_M },
  roles: [role('R1', 'Backend Engineer'), role('OLD', 'Staff Engineer (2024)'), role('OFF', 'Private Space', { memoryEnabled: false })],
};

let harness: Harness;
base.beforeAll(async () => {
  harness = await launchHarness(FIXTURE);
});
base.afterAll(async () => harness?.close());

const test = base.extend<{ sessions: Page; save: Page }>({
  sessions: async ({}, use) => use(await harness.load('sessions')),
  save: async ({}, use) => use(await harness.load('savePrompt')),
});
const reply = (page: Page, path: string, value: unknown) =>
  page.evaluate(([p, v]) => ((window as any).__fake.replies[p as string] = v), [path, value] as const);
const argsOf = (page: Page, path: string) =>
  page.evaluate((p) => (window as any).__fake.args.filter((a: any) => a.path === p).map((a: any) => a.args), path);

// ---------------------------------------------------------------- history ----

test('opening a saved interview shows its transcript and suggestions from this machine — no report, no model call', async ({ sessions: page }) => {
  await page.getByRole('button', { name: 'Open' }).first().click();
  const d = page.getByRole('dialog');
  const conv = d.getByRole('region', { name: 'Conversation' }).or(d.locator('section[aria-label="Conversation"]'));
  await expect(conv).toContainText('Tell me about a migration you led.');
  await expect(conv).toContainText('we moved billing from MySQL to Postgres');
  // What was said and what was generated are marked apart.
  await expect(conv.getByText('Suggested by BrainCue — not said')).toHaveCount(1);
  await expect(conv).toContainText('Lead with the billing cut-over');
  await expect(conv).toContainText('Not answered — Asked while paused');
  await expect(conv.getByText('Interviewer').first()).toBeVisible();
  await expect(conv.getByText('You', { exact: true })).toBeVisible();
  // The only session requests: the page, and this session's persisted record.
  const sessionCalls = (await calls(page)).filter((c) => c.startsWith('session.'));
  expect([...new Set(sessionCalls)]).toEqual(['session.page', 'session.get']);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name))).toEqual([]);
  // Coaching is offered, explicitly, with where it would go.
  await expect(d.locator('section[aria-label="Coaching report"]')).toContainText('Writing one sends the transcript to Anthropic');
});

test('a coaching report is an explicit action — and its failure leaves the conversation readable', async ({ sessions: page }) => {
  await reply(page, 'session.generateReport', { throw: 'No Anthropic API key' });
  await page.getByRole('button', { name: 'Open' }).first().click();
  const d = page.getByRole('dialog');
  await expect(d.locator('section[aria-label="Conversation"]')).toContainText('Tell me about a migration you led.');
  await d.getByRole('button', { name: 'Write a coaching report' }).click();
  await expect(d.getByRole('alert')).toContainText('The report could not be written (No Anthropic API key). The conversation above is unaffected.');
  await expect(d.locator('section[aria-label="Conversation"]')).toContainText('dual-write window');
});

test("a meeting opens with its cards; its report is generated only when asked for", async ({ sessions: page }) => {
  await page.getByRole('button', { name: 'Open' }).nth(1).click();
  const d = page.getByRole('dialog');
  await expect(d.locator('section[aria-label="Conversation"]')).toContainText('Can we ship on Friday?');
  await expect(d.locator('section[aria-label="Conversation"]')).toContainText('Ship Friday, pending QA');
  await expect(d.locator('section[aria-label="Conversation"]')).toContainText('decision · generated');
  expect(await calls(page)).not.toContain('session.meetingReport');
});

test('a saved voice quick Ask opens with what was asked and its answer, marked generated — no report, no model call', async ({ sessions: page }) => {
  await reply(page, 'session.get', DETAIL_QA);
  await page.getByRole('button', { name: 'Open' }).first().click();
  const conv = page.getByRole('dialog').locator('section[aria-label="Conversation"]');
  await expect(conv).toContainText('You asked: What is a write-ahead log?'); // asked, not detected
  await expect(conv).toContainText('A log written before changes are applied');
  await expect(conv.getByText('Suggested by BrainCue — not said')).toHaveCount(1);
  expect([...new Set((await calls(page)).filter((c) => c.startsWith('session.')))]).toEqual(['session.page', 'session.get']);
});

test('history pages on the server: page 2 asks for the next 12, the total comes from main', async ({ sessions: page }) => {
  await expect(page.getByRole('button', { name: 'Open' })).toHaveCount(12);
  expect((await argsOf(page, 'session.page'))[0]).toEqual(['pA', '', 12, 0]);
  await page.getByRole('button', { name: /Next/ }).click();
  await expect.poll(async () => (await argsOf(page, 'session.page')).at(-1)).toEqual(['pA', '', 12, 12]);
  await expect(page.getByRole('button', { name: 'Open' })).toHaveCount(2);
});

test('deleting from the detail asks first', async ({ sessions: page }) => {
  await page.getByRole('button', { name: 'Open' }).first().click();
  const d = page.getByRole('dialog');
  await d.getByRole('button', { name: 'Delete…' }).click();
  await expect(d.getByRole('alertdialog')).toContainText('This cannot be undone');
  expect(await calls(page)).not.toContain('session.delete');
  await d.getByRole('button', { name: 'Delete it' }).click();
  await expect.poll(() => calls(page)).toContain('session.delete');
});

// ------------------------------------------------------------ save prompt ----

const PROMPT = { sessionId: 'h1', mode: 'interview', activity: 'job', profileId: 'pA', packId: 'R1', interviewType: 'general', jobTitle: 'Backend Engineer', questionCount: 2, turnCount: 12 };
const result = (summary: string, memory = 'off', extra: Record<string, unknown> = {}) => ({
  kept: true,
  packId: 'R1',
  summary: { status: summary, count: summary === 'done' ? 3 : 0, ...(summary === 'failed' ? { error: 'No Anthropic API key' } : {}) },
  memory: { status: memory, count: 0 },
  provider: summary === 'no-space' ? null : 'anthropic',
  archived: 0,
  memories: 0,
  ...extra,
});
const open = (page: Page, p: Record<string, unknown> = PROMPT) => page.evaluate((x) => (window as any).__harness.prompt(x), p);
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Interview ended' });

test('before Keep: says the transcript stays here and names who it is sent to, for what', async ({ save: page }) => {
  await open(page);
  const d = dialog(page);
  const what = d.getByRole('list', { name: 'What Keep does' });
  await expect(what).toContainText('The transcript stays on this machine, readable in Sessions.');
  await expect(what).toContainText('The transcript is sent to Anthropic to make a short summary, filed into “Backend Engineer”.');
  await expect(what).toContainText('Memory suggestions are off');
  await expect(d).not.toContainText('Everything stays on this machine');
});

test('Keep → success: each half reported as itself; Done closes', async ({ save: page }) => {
  await reply(page, 'session.remember', result('done', 'off'));
  await open(page);
  await dialog(page).getByRole('button', { name: 'Keep it' }).click();
  const r = dialog(page).getByRole('list', { name: 'What was kept' });
  await expect(r).toContainText('Kept — the transcript is on this machine, readable in Sessions.');
  await expect(r).toContainText('Summary saved to “Backend Engineer” (made by Anthropic)');
  await expect(r).toContainText('Memory suggestions are off');
  expect((await argsOf(page, 'session.remember'))[0]).toEqual(['h1', 'R1']);
  await dialog(page).getByRole('button', { name: 'Done' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('Keep → processing fails: the reason, the transcript kept, and a Retry that works', async ({ save: page }) => {
  await reply(page, 'session.remember', [result('failed', 'off'), result('done', 'off')]);
  await open(page);
  await dialog(page).getByRole('button', { name: 'Keep it' }).click();
  const r = dialog(page).getByRole('list', { name: 'What was kept' });
  await expect(r).toContainText('The summary failed (No Anthropic API key).');
  await expect(r).toContainText('The transcript is kept either way.');
  await dialog(page).getByRole('button', { name: 'Retry' }).click();
  await expect(r).toContainText('Summary saved to “Backend Engineer”');
  await expect(dialog(page).getByRole('button', { name: 'Retry' })).toHaveCount(0);
  // The retry re-runs only the half that failed, at the same destination.
  expect(await argsOf(page, 'session.remember')).toEqual([['h1', 'R1'], ['h1', 'R1', ['summary']]]);
});

test('no Space: says nothing is sent, and reports exactly that', async ({ save: page }) => {
  await reply(page, 'session.remember', result('no-space', 'no-space', { packId: null }));
  await open(page, { ...PROMPT, packId: null, jobTitle: null });
  const d = dialog(page);
  await expect(d.getByRole('list', { name: 'What Keep does' })).toContainText('No Space: nothing is summarised or suggested, and nothing is sent anywhere.');
  await d.getByRole('button', { name: 'Keep it' }).click();
  await expect(d.getByRole('list', { name: 'What was kept' })).toContainText('No Space, so nothing was summarised or sent.');
  expect((await argsOf(page, 'session.remember'))[0]).toEqual(['h1', null]);
});

test('an older Space, not on the picker page, stays the destination; a deleted one is refused before anything is filed', async ({ save: page }) => {
  // The picker's page holds only the newest Space; the session ran in OLD.
  await reply(page, 'jobs.page', { items: [FIXTURE.roles[0]], total: 101 });
  await reply(page, 'jobs.get', [FIXTURE.roles[1], null]); // read on open, gone at Keep
  await open(page, { ...PROMPT, packId: 'OLD', jobTitle: 'Staff Engineer (2024)' });
  const d = dialog(page);
  await expect(d.locator('button[aria-haspopup="listbox"]')).toContainText('Staff Engineer (2024)');
  await expect(d.getByRole('textbox', { name: 'Search Spaces' })).toBeVisible(); // older ones are searchable
  await d.getByRole('button', { name: 'Keep it' }).click();
  await expect(d.getByRole('alert')).toContainText('That Space no longer exists');
  expect(await calls(page)).not.toContain('session.remember');
  // Not silently "No Space": the user chooses again before anything is filed.
  await expect(d.locator('button[aria-haspopup="listbox"]')).toContainText('Choose where to file it…');
  await expect(d.getByRole('button', { name: 'Keep it' })).toBeDisabled();
});

test('Keep waits for the Space it ran in to be read — a quick Keep never files it out of that Space', async ({ save: page }) => {
  await page.evaluate(() => (window as any).__fake.hold('R1'));
  await reply(page, 'session.remember', result('done', 'off'));
  await open(page);
  const keep = dialog(page).getByRole('button', { name: 'Keep it' });
  await expect(keep).toBeDisabled();
  await page.evaluate(() => (window as any).__fake.release('R1'));
  await expect(keep).toBeEnabled();
  await keep.click();
  await expect.poll(async () => (await argsOf(page, 'session.remember'))[0]).toEqual(['h1', 'R1']);
});

test('a late read of the Space it ran in never replaces a Space picked meanwhile', async ({ save: page }) => {
  await page.evaluate(() => (window as any).__fake.hold('R1'));
  await reply(page, 'session.remember', result('no-space', 'no-space', { packId: null }));
  await open(page);
  const d = dialog(page);
  await d.locator('button[aria-haspopup="listbox"]').click();
  await page.locator('ul[role="listbox"] li[role="option"]').filter({ hasText: 'No Space' }).click();
  await page.evaluate(() => (window as any).__fake.release('R1'));
  await page.waitForTimeout(300);
  await expect(d.locator('button[aria-haspopup="listbox"]')).toContainText('No Space');
  await d.getByRole('button', { name: 'Keep it' }).click();
  await expect.poll(async () => (await argsOf(page, 'session.remember'))[0]).toEqual(['h1', null]);
});

test("a refusal from main (another profile's Space) is shown, and nothing is claimed", async ({ save: page }) => {
  await reply(page, 'session.remember', { throw: 'That Space belongs to another profile — choose one of this profile’s.' });
  await open(page);
  await dialog(page).getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('belongs to another profile');
  await expect(dialog(page).getByRole('list', { name: 'What was kept' })).toHaveCount(0);
});

test('while Keep is running, Escape does not close it — and says why', async ({ save: page }) => {
  await reply(page, 'session.remember', { hold: true });
  await open(page);
  await dialog(page).getByRole('button', { name: 'Keep it' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('status')).toContainText('Keeping it — this stays open until it finishes');
  expect(await page.evaluate(() => !!(window as any).__harness.pendingSave())).toBe(true);
});

test('Discard asks first; a failed delete is said, and the prompt stays', async ({ save: page }) => {
  await reply(page, 'session.delete', { throw: 'database is locked' });
  await open(page);
  const d = dialog(page);
  await d.getByRole('button', { name: 'Discard…' }).click();
  await expect(d.getByRole('alertdialog')).toContainText('Delete this session, its transcript and anything it suggested?');
  expect(await calls(page)).not.toContain('session.delete');
  await d.getByRole('button', { name: 'Delete it' }).click();
  await expect(d.getByRole('alert')).toContainText('It was not deleted (database is locked)');
  await expect(d).toBeVisible();
});

// ---------------------------------------- M6 review: destination & Retry ----

test('a failed read of the Space it ran in leaves the destination UNKNOWN — Keep waits; Try again recovers it', async ({ save: page }) => {
  await reply(page, 'jobs.get', [{ throw: 'database is locked' }, FIXTURE.roles[0]]);
  await reply(page, 'session.remember', result('done', 'off'));
  await open(page);
  const d = dialog(page);
  await expect(d.getByRole('alert')).toContainText('Couldn’t check the Space it ran in (database is locked). It may still exist');
  await expect(d.locator('button[aria-haspopup="listbox"]')).toContainText('Choose where to file it…');
  await expect(d.getByRole('button', { name: 'Keep it' })).toBeDisabled();
  expect(await calls(page)).not.toContain('session.remember');
  await d.getByRole('button', { name: 'Try again' }).click();
  await expect(d.locator('button[aria-haspopup="listbox"]')).toContainText('Backend Engineer');
  await d.getByRole('button', { name: 'Keep it' }).click();
  await expect.poll(async () => (await argsOf(page, 'session.remember'))[0]).toEqual(['h1', 'R1']);
});

test('after a failed read, filing it without a Space is an explicit choice', async ({ save: page }) => {
  await reply(page, 'jobs.get', { throw: 'database is locked' });
  await reply(page, 'session.remember', result('no-space', 'no-space', { packId: null }));
  await open(page);
  const d = dialog(page);
  await expect(d.getByRole('button', { name: 'Keep it' })).toBeDisabled();
  await d.locator('button[aria-haspopup="listbox"]').click();
  await page.locator('ul[role="listbox"] li[role="option"]').filter({ hasText: 'No Space' }).click();
  await d.getByRole('button', { name: 'Keep it' }).click();
  await expect.poll(async () => (await argsOf(page, 'session.remember'))[0]).toEqual(['h1', null]);
});

test("a Retry's own failure is shown on the result view — and the confirmed half stands", async ({ save: page }) => {
  await reply(page, 'session.remember', [
    result('failed', 'done', { memory: { status: 'done', count: 2 } }),
    { throw: 'The request timed out' },
    result('done', 'not-run'),
  ]);
  await open(page);
  const d = dialog(page);
  await d.getByRole('button', { name: 'Keep it' }).click();
  const r = d.getByRole('list', { name: 'What was kept' });
  await expect(r).toContainText('The summary failed (No Anthropic API key).');
  await expect(r).toContainText('2 memory suggestions waiting for your review');
  await d.getByRole('button', { name: 'Retry' }).click();
  await expect(d.getByRole('alert')).toContainText('The request timed out');
  await expect(r).toContainText('2 memory suggestions waiting for your review'); // still confirmed
  await d.getByRole('button', { name: 'Retry' }).click();
  await expect(r).toContainText('Summary saved to “Backend Engineer”');
  await expect(r).toContainText('2 memory suggestions waiting for your review'); // not redone, not lost
  await expect(d.getByRole('alert')).toHaveCount(0);
  expect(await argsOf(page, 'session.remember')).toEqual([['h1', 'R1'], ['h1', 'R1', ['summary']], ['h1', 'R1', ['summary']]]);
});

test('Retry after the Space was deleted: the result view says so and asks where to file it — nothing is sent until chosen', async ({ save: page }) => {
  // Read on open, still there at Keep, gone at Retry.
  await reply(page, 'jobs.get', [FIXTURE.roles[0], FIXTURE.roles[0], null]);
  await reply(page, 'session.remember', [result('failed', 'off'), result('no-space', 'no-space', { packId: null })]);
  await open(page);
  const d = dialog(page);
  await d.getByRole('button', { name: 'Keep it' }).click();
  await expect(d.getByRole('list', { name: 'What was kept' })).toContainText('The summary failed');
  await d.getByRole('button', { name: 'Retry' }).click();
  await expect(d.getByRole('alert')).toContainText('That Space no longer exists — choose another, or keep it without one.');
  await expect(d.locator('button[aria-haspopup="listbox"]')).toContainText('Choose where to file it…');
  await expect(d.getByRole('button', { name: 'Retry' })).toBeDisabled();
  expect(await argsOf(page, 'session.remember')).toHaveLength(1);
  await d.locator('button[aria-haspopup="listbox"]').click();
  await page.locator('ul[role="listbox"] li[role="option"]').filter({ hasText: 'No Space' }).click();
  await expect(d).toContainText('Retry files it without a Space and runs both halves there.');
  await d.getByRole('button', { name: 'Retry' }).click();
  await expect(d.getByRole('list', { name: 'What was kept' })).toContainText('No Space, so nothing was summarised or sent.');
  // A new destination runs both halves there (no "only").
  expect((await argsOf(page, 'session.remember')).at(-1)).toEqual(['h1', null]);
});

test('Retry refused by main (the Space was deleted in between) asks where to file it, on the result view', async ({ save: page }) => {
  await reply(page, 'session.remember', [result('failed', 'off'), { throw: 'That Space no longer exists — choose another, or keep it without one.' }]);
  await open(page);
  const d = dialog(page);
  await d.getByRole('button', { name: 'Keep it' }).click();
  await d.getByRole('button', { name: 'Retry' }).click();
  await expect(d.getByRole('alert')).toContainText('That Space no longer exists');
  await expect(d.locator('button[aria-haspopup="listbox"]')).toContainText('Choose where to file it…');
  await expect(d.getByRole('button', { name: 'Retry' })).toBeDisabled();
});
