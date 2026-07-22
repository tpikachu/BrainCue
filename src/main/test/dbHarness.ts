import { createRequire } from 'node:module';
import path from 'node:path';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { drizzle, type SQLJsDatabase } from 'drizzle-orm/sql-js';
import { migrate } from 'drizzle-orm/sql-js/migrator';
import * as schema from '../db/schema';

/**
 * In-memory SQLite for unit tests, with the REAL drizzle migrations applied.
 *
 * The app's better-sqlite3 is rebuilt for Electron's ABI (postinstall), so it
 * cannot load under plain Node/vitest — which is why no test touched the DB
 * before v2. sql.js (WASM SQLite, dev-only) runs anywhere, letting parity tests
 * exercise the real repositories + schema instead of mocking persistence.
 * Prompt-2's migration-fixture tests build on this same harness
 * (`new SQL.Database(fixtureBytes)` loads a committed pre-migration DB image).
 */
export type TestDb = SQLJsDatabase<typeof schema>;

// createRequire against the repo root lets us locate sql.js's wasm without
// relying on import.meta (kept out so the file compiles under any module mode).
const require_ = createRequire(path.join(process.cwd(), 'package.json'));

export async function createTestDb(
  fixture?: Uint8Array,
): Promise<{ db: TestDb; sqlite: SqlJsDatabase }> {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require_.resolve('sql.js')), file),
  });
  const sqlite = new SQL.Database(fixture);
  sqlite.run('PRAGMA foreign_keys = ON;');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  return { db, sqlite };
}
