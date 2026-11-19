import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchHarness, type Harness } from './harness/harness';
import { FIXTURE } from './harness/aiFixture';

// The real Cue Card, fake session only. No app data, provider or device capture.
/* eslint-disable @typescript-eslint/no-explicit-any */
let harness: Harness;
test.beforeAll(async () => { harness = await launchHarness(FIXTURE); });
test.afterAll(async () => harness?.close());

async function interview(width: number, height = 462) {
  const page = await harness.load('overlay');
  await page.setViewportSize({ width, height });
  await page.waitForFunction(() => (window as any).__fake.listening('onSessionState') > 0);
  await page.evaluate(() => {
    const f = (window as any).__fake;
    f.emit('onSessionState', { status: 'live', paused: false });
    f.emit('onCaptureStatus', { system: true, mic: true, wantsSystem: true });
    f.emit('onClientInfo', { profileName: 'Alex', company: 'Acme · Platform engineering', title: 'Senior Software Engineer', hasResume: true, hasJd: true, hasCompany: false });
    f.emit('onTranscript', { text: 'Tell me about a project you led.', speaker: 'interviewer', isFinal: true });
    f.emit('onContributionOpen', { contributionId: 'q1', kind: 'answer', title: 'Tell me about a project you led.' });
    f.emit('onContributionDelta', { contributionId: 'q1', token: 'I led our billing migration, from planning through rollout.\n\n- Moved 40 services to the new platform.\n- Used a phased rollout with feature flags.\n- Cut processing time by 35%, with no downtime.' });
    f.emit('onContributionPatch', { contributionId: 'q1', meta: { questionId: 'q1', answeredBy: { provider: 'anthropic', model: 'claude-sonnet-5-5' } } });
    f.emit('onContributionDone', { contributionId: 'q1' });
  });
  await expect(page.locator('.cue-current')).toContainText('billing migration');
  return page;
}

async function inside(page: Page) {
  const geometry = await page.evaluate(() => {
    const header = document.querySelector('[data-cue-toolbar]')!;
    const footer = document.querySelector('[data-cue-askbar]')!;
    const rect = (e: Element) => { const r = e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height}; };
    return { width:innerWidth,height:innerHeight,header:rect(header),footer:rect(footer),buttons:[...header.querySelectorAll('button')].map(rect) };
  });
  for (const r of [geometry.header,geometry.footer,...geometry.buttons]) {
    expect(r.left).toBeGreaterThanOrEqual(8);
    expect(r.right).toBeLessThanOrEqual(geometry.width - 8);
    expect(r.top).toBeGreaterThanOrEqual(8);
    expect(r.bottom).toBeLessThanOrEqual(geometry.height - 8);
  }
  for (const b of geometry.buttons) expect(b.height).toBeGreaterThanOrEqual(28);
}

async function preview(page: Page, name: string) {
  if (!process.env.UI_PREVIEW_DIR || !process.env.HARNESS_CAPTURE_PORT) return;
  await page.mouse.move(1, page.viewportSize()!.height - 10);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await mkdir(process.env.UI_PREVIEW_DIR, {recursive:true});
  const response = await page.request.get(`http://127.0.0.1:${process.env.HARNESS_CAPTURE_PORT}/`);
  expect(response.ok()).toBe(true);
  await writeFile(join(process.env.UI_PREVIEW_DIR, `${name}.png`), await response.body());
}

for (const width of [360,467]) test(`session and manual-answer controls fit ${width}px, including the minimum window height`, async () => {
  const page = await interview(width);
  await inside(page);
  await preview(page, `cue-toolbar-${width}`);
  await page.getByRole('textbox', {name:'Ask a question'}).fill('How did you measure the impact?');
  await page.getByRole('textbox', {name:'Ask a question'}).press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__fake.args.filter((a:any) => a.path === 'session.askActive').map((a:any) => a.args[0]))).toEqual(['How did you measure the impact?']);
  await page.getByRole('button', {name:'⏸ Pause',exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fake.calls)).toContain('session.togglePauseActive');
  await page.evaluate(() => (window as any).__fake.emit('onSessionState', { status:'live',paused:true }));
  await expect(page.getByRole('button',{name:'▶ Resume',exact:true})).toBeVisible();
  await page.setViewportSize({width,height:240});
  await inside(page);
});

test('secondary controls have space at compact widths and keep their existing actions', async () => {
  const page = await interview(360);
  await page.getByRole('button',{name:/More: answer style/}).click();
  const tray = page.getByLabel('More controls');
  await expect(tray.getByRole('combobox',{name:'Interview answers model'})).toBeVisible();
  await expect(tray.getByRole('button',{name:'Settings',exact:true})).toBeVisible();
  await inside(page);
  await preview(page, 'cue-toolbar-more-360');
  await tray.getByRole('button',{name:'Technical',exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fake.args.filter((a:any) => a.path === 'session.setAnswerPrefs').map((a:any) => a.args[0].format))).toContain('technical');
  await tray.getByRole('button',{name:'Solve clipboard',exact:true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fake.calls)).toContain('capture.quickSolve');
  await page.keyboard.press('Escape');
  await expect(tray).toHaveCount(0);
  await expect(page.locator('.cue-current')).toContainText('billing migration');
});

test('coding controls keep the manual answer bar reachable in a compact window', async () => {
  const page = await interview(360);
  await page.evaluate(() => (window as any).__fake.emit('onAnswerPrefs', {interviewType:'coding',format:'general',pronunciation:false}));
  await page.getByRole('button',{name:/More: answer style/}).click();
  await expect(page.getByRole('combobox',{name:'Coding solver model'})).toBeVisible();
  await inside(page);
  await preview(page, 'cue-toolbar-coding-360');
  await page.setViewportSize({width:360,height:240});
  await inside(page);
  const model = page.getByRole('combobox',{name:'Interview answers model'});
  await model.click();
  const box = (await page.getByRole('listbox').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(7);
  expect(box.x + box.width).toBeLessThanOrEqual(353);
  expect(box.y).toBeGreaterThanOrEqual(7);
  expect(box.y + box.height).toBeLessThanOrEqual(233);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});
