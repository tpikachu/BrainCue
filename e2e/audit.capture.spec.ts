import { test } from './fixtures';

// Opt-in diagnostic (E2E_CAPTURE=1). Drives the app to surface RUNTIME issues that
// static review can't: console/page errors per route, and first-run/empty states.
// Doesn't assert — it logs findings to the run output. No OpenAI key needed.
/* eslint-disable @typescript-eslint/no-explicit-any */
test('@audit runtime errors + empty states', async ({ dashboard }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  dashboard.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  dashboard.on('pageerror', (e) => pageErrors.push(e.message));

  const routes = ['Profiles', 'Interview', 'Mock Interview', 'Reports', 'Settings'];
  for (const name of routes) {
    await dashboard.getByRole('link', { name: new RegExp(name, 'i') }).first().click();
    await dashboard.waitForTimeout(600);
  }

  const snippet = async (linkRe: RegExp) => {
    await dashboard.getByRole('link', { name: linkRe }).first().click();
    await dashboard.waitForTimeout(500);
    return (await dashboard.locator('main, #root').first().innerText()).replace(/\s+/g, ' ').slice(0, 280);
  };
  const reports = await snippet(/reports/i);
  const interview = await snippet(/interview/i);
  const profiles = await snippet(/profiles/i);

  // Surface anything the renderer logs at warn level too (deprecations, React warnings).
  console.log('\n===== AUDIT RESULTS =====');
  console.log('CONSOLE_ERRORS(' + consoleErrors.length + '):', JSON.stringify(consoleErrors.slice(0, 25)));
  console.log('PAGE_ERRORS(' + pageErrors.length + '):', JSON.stringify(pageErrors.slice(0, 25)));
  console.log('REPORTS_EMPTY:', reports);
  console.log('INTERVIEW_NOPROFILE:', interview);
  console.log('PROFILES_EMPTY:', profiles);
  console.log('===== END AUDIT =====\n');
});
