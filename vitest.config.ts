import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const r = (p: string) => resolve(process.cwd(), p);

// Unit tests cover pure + lightly-mocked logic (electron/db/network are mocked per
// test — see *.test.ts). The path aliases mirror tsconfig so modules that import
// from `@shared`/`@main`/`@renderer` (value imports, e.g. EVENTS) resolve here too.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': r('src/shared'),
      '@main': r('src/main'),
      '@renderer': r('src/renderer'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
