import { defineConfig } from '@playwright/test';
import 'dotenv/config'; // OPENAI_API_KEY from .env

// The LIVE tier: real provider calls (parsing, embeddings) through the real
// app, with the key from .env. Kept apart from the offline default
// (playwright.config.ts) so an offline run can never depend on a provider
// succeeding. It sends sample data to the provider and costs money — run it
// on purpose: `npm run test:e2e:live`. Each spec skips without a key.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  testMatch: ['**/live-*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { live: true } as Record<string, unknown>,
});
