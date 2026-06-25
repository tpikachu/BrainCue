import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// The built app resolves Drizzle migrations relative to its bundle (out/main/drizzle).
// electron-builder copies them there when packaging; running out/main/index.js
// directly (as e2e does) doesn't — so the DB has no tables. Mirror the packaged
// layout before the suite runs.
export default function globalSetup(): void {
  const src = resolve(process.cwd(), 'drizzle');
  const dest = resolve(process.cwd(), 'out/main/drizzle');
  if (!existsSync(src)) throw new Error(`drizzle/ migrations not found at ${src}`);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}
