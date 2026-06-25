import { defineConfig } from '@playwright/test';
import 'dotenv/config'; // loads .env → process.env (incl. OPENAI_API_KEY for the live tier)

// E2E runs against the BUILT Electron app (out/main/index.js), launched per-test via
// Playwright's _electron (see e2e/fixtures.ts). `npm run test:e2e` builds first.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts', // mirror migrations into out/main/drizzle
  fullyParallel: false, // each test launches its own Electron instance + shares one local DB
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
});
