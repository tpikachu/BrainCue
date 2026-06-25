import { test, expect } from './fixtures';

// Sanity: the app launches, the dashboard renders, and core navigation works.
// No OpenAI key required.
test.describe('smoke', () => {
  test('dashboard window opens and renders the shell', async ({ dashboard }) => {
    await expect(dashboard.locator('#root')).toBeVisible();
    // The brand wordmark is always present in the sidebar.
    await expect(dashboard.getByText(/BrainCue/i).first()).toBeVisible();
  });

  test('can navigate to Settings', async ({ dashboard }) => {
    await dashboard.getByRole('link', { name: /settings/i }).first().click();
    await expect(dashboard.getByRole('heading', { name: 'OpenAI API Key' })).toBeVisible();
    await expect(dashboard.getByRole('heading', { name: 'OpenAI Models' })).toBeVisible();
  });

  test('can navigate to Interview', async ({ dashboard }) => {
    await dashboard.getByRole('link', { name: /interview/i }).first().click();
    await expect(dashboard.getByText(/Pick a profile/i)).toBeVisible();
  });
});
