import { test as base, expect, type Page } from '@playwright/test';
import { calls, launchHarness, type Harness } from './harness/harness';

/**
 * M6 — the live Cue Card, the REAL Overlay component driven by the same
 * events main broadcasts (renderer harness: hidden Electron window, fake
 * bridge, no audio, no network). The current question and its answer are the
 * dominant content; missed questions stay visible with their reason and a
 * retry; earlier cards, the full transcript, sources and extra controls are
 * one tap away; a Stop that could not be confirmed is said here too.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const FIXTURE = {
  profiles: [{ id: 'pA', name: 'Alex' }],
  readiness: {
    chat: { ready: true, provider: 'anthropic', model: 'm', classifyModel: 'm', explanation: 'x' },
    transcription: { ready: true, engine: 'local' },
    retrieval: { ready: true, mode: 'lexical' },
    routes: { answer: 'anthropic', classify: 'anthropic', parsing: 'anthropic' },
    features: {},
  },
};

let harness: Harness;
base.beforeAll(async () => {
  harness = await launchHarness(FIXTURE);
});
base.afterAll(async () => harness?.close());
const test = base.extend<{ cue: Page }>({ cue: async ({}, use) => use(await harness.load('overlay')) });

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([e, p]) => (window as any).__fake.emit(e, p), [event, payload] as const);

/** A live interview with one answered question, one missed while paused and
 *  one streaming now — as main would broadcast it. */
export async function liveInterview(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__fake.listening('onSessionState') > 0);
  await emit(page, 'onSessionState', { status: 'live', paused: false });
  await emit(page, 'onClientInfo', { company: 'Acme', title: 'Backend Engineer', notes: null, profileName: 'Alex', hasResume: true, hasJd: true, hasCompany: false });
  await emit(page, 'onCaptureStatus', { system: true, mic: true, wantsSystem: true });
  await emit(page, 'onTranscriptDelta', { text: 'Tell me about a migration you led.', speaker: 'interviewer', isFinal: true });
  await emit(page, 'onContributionOpen', { contributionId: 'q1', kind: 'answer', title: 'Tell me about a migration you led.' });
  await emit(page, 'onContributionDelta', { contributionId: 'q1', token: 'Lead with the **billing cut-over**: dual writes, then a verified switch.' });
  await emit(page, 'onContributionDone', { contributionId: 'q1' });
  await emit(page, 'onContributionOpen', { contributionId: 'q2', kind: 'answer', title: 'What was the hardest bug?' });
  await emit(page, 'onContributionPatch', { contributionId: 'q2', meta: { questionId: 'q2', riskWarning: 'Asked while paused — not answered. Press ↻ to answer it.', missed: 'paused' } });
  await emit(page, 'onContributionDone', { contributionId: 'q2' });
  await emit(page, 'onTranscriptDelta', { text: 'How did you roll it back if something broke?', speaker: 'interviewer', isFinal: true });
  await emit(page, 'onContributionOpen', { contributionId: 'q3', kind: 'answer', title: 'How did you roll it back if something broke?' });
  await emit(page, 'onContributionPatch', {
    contributionId: 'q3',
    context: { questionId: 'q3', question: 'How did you roll it back?', chunks: [{ id: 'k1', sourceType: 'resume', score: 0.81, content: 'Led the billing migration to Postgres with a dual-write window.' }] },
  });
  await emit(page, 'onContributionDelta', { contributionId: 'q3', token: 'Feature flags per tenant, and the dual-write window meant a rollback was a flag flip.' });
}

test('the current question and answer dominate; extra controls are one tap away', async ({ cue: page }) => {
  await liveInterview(page);
  const current = page.locator('.cue-current');
  await expect(current).toContainText('How did you roll it back if something broke?');
  await expect(current).toContainText('a rollback was a flag flip');
  // Header: status + the few live controls.
  await expect(page.getByRole('status').first()).toContainText('Answering');
  await expect(page.getByRole('button', { name: '⏸ Pause' })).toBeVisible();
  await expect(page.getByRole('button', { name: '■ Stop' })).toBeVisible();
  // Not competing for a glance until asked for.
  await expect(page.getByRole('button', { name: 'General' })).toHaveCount(0);
  await expect(page.getByLabel('More controls')).toHaveCount(0);
  await page.getByRole('button', { name: /More: answer style/ }).click();
  await expect(page.getByLabel('More controls')).toContainText('Style');
  await expect(page.getByLabel('More controls')).toContainText('Solve clipboard');
  await expect(page.getByLabel('More controls')).toContainText('JD ✓');
});

test('a missed question stays visible with its reason and a retry; it never displaces the answer', async ({ cue: page }) => {
  await liveInterview(page);
  const missed = page.getByRole('list', { name: 'Missed questions' });
  await expect(missed).toContainText('Asked while paused: What was the hardest bug?');
  await expect(page.locator('.cue-current')).not.toContainText('hardest bug');
  await missed.getByRole('button', { name: 'Answer it' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).__fake.args)).filter((a: any) => a.path === 'session.regenerate').map((a: any) => a.args[0])).toEqual(['q2']);
  // Main re-streams it on the same card: it becomes the current one.
  await emit(page, 'onContributionDone', { contributionId: 'q3' });
  await emit(page, 'onContributionReset', { contributionId: 'q2' });
  await emit(page, 'onContributionDelta', { contributionId: 'q2', token: 'The off-by-one in the ledger replay.' });
  await expect(page.locator('.cue-current')).toContainText('What was the hardest bug?');
  await expect(missed).toHaveCount(0);
});

test('earlier answers are kept, in arrival order, behind one toggle', async ({ cue: page }) => {
  await liveInterview(page);
  const toggle = page.getByRole('button', { name: /Earlier \(1\)/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('billing cut-over')).toHaveCount(0);
  await toggle.click();
  await expect(page.getByRole('button', { name: /Tell me about a migration you led/ })).toBeVisible();
});

test('sources name the provider they were sent to — never an assumed OpenAI', async ({ cue: page }) => {
  await liveInterview(page);
  const sources = page.getByRole('button', { name: /Sources sent to Anthropic \(1\)/ });
  await expect(sources).toBeVisible();
  await expect(page.getByText(/Data sent to OpenAI/)).toHaveCount(0);
  await sources.click();
  await expect(page.getByText('Led the billing migration to Postgres')).toBeVisible();
});

test('a missing capture stream is said, with what it costs', async ({ cue: page }) => {
  await liveInterview(page);
  await emit(page, 'onCaptureStatus', { system: false, mic: true, wantsSystem: true });
  await expect(page.getByText(/Call audio is not captured/)).toBeVisible();
});

test('paused: the header says so, and nothing claims to be listening', async ({ cue: page }) => {
  await page.waitForFunction(() => (window as any).__fake.listening('onSessionState') > 0);
  await emit(page, 'onSessionState', { status: 'live', paused: true });
  await expect(page.getByRole('status').first()).toContainText('Paused');
  await expect(page.getByRole('button', { name: '▶ Resume' })).toBeVisible();
  await expect(page.getByText('Paused — nothing is being heard')).toBeVisible();
});

test("Stop after a failed startup rollback: main's held rollback is retried; an unconfirmed stop is said here", async ({ cue: page }) => {
  await page.waitForFunction(() => (window as any).__fake.listening('onSessionState') > 0);
  await emit(page, 'onSessionState', { status: 'live', paused: false });
  await page.evaluate(() => {
    (window as any).__fake.replies['session.stopActive'] = { stopped: false, rollback: { sessionId: 's1', stopped: false, error: 'database is locked' } };
  });
  await page.getByRole('button', { name: '■ Stop' }).click();
  await expect(page.getByText('Stopping the session failed (database is locked) — it may still be running. Press Stop to try again.')).toBeVisible();
  expect(await calls(page)).toContain('session.stopActive');
  // The dashboard's own retry, settled by main, reaches this window too.
  await emit(page, 'onSessionRollback', { sessionId: 's1', stopped: true, removed: false, error: 'disk full' });
  await expect(page.getByText(/its empty record couldn't be removed \(disk full\)/)).toBeVisible();
});
