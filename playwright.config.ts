import { defineConfig } from '@playwright/test';
import 'dotenv/config'; // .env is loaded, but the OFFLINE fixture strips every *_API_KEY

// The DEFAULT tier is OFFLINE: every real-app test runs with no provider key,
// every outbound request refused and capture refused (e2e/offline-guard.cjs,
// loaded by e2e/fixtures.ts), in an isolated data dir; the renderer-harness
// specs (e2e/harness) bundle real components against a fake bridge. Nothing
// here needs a key, the network, a microphone or a screen.
//
// The LIVE tier (real providers) is a separate config: playwright.live.config.ts
// (`npm run test:e2e:live`). README/marketing capture is opt-in (E2E_CAPTURE=1).
//
// E2E runs against the BUILT Electron app (out/main/index.js); `npm run test:e2e`
// builds first.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts', // mirror migrations into out/main/drizzle
  testIgnore: ['**/live-*.spec.ts', ...(process.env.E2E_CAPTURE ? [] : ['**/*.capture.spec.ts'])],
  fullyParallel: false, // each test launches its own Electron instance on one CDP port
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
});
