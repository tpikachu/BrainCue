import { describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { Database as SqlJsDatabase } from 'sql.js';
import { createTestDb } from '../test/dbHarness';
import { fixLegacyFkActions } from './fkRebuild';

/**
 * The FK rebuild is a create-copy-drop-rename: it recreates `sessions` and
 * `chunks` from a hardcoded DDL. That means it silently DISCARDS any column the
 * DDL doesn't name — and because it runs after migrations, a migration that
 * adds a column without updating fkRebuild.ts destroys that column on every DB
 * the rebuild still applies to (i.e. every fresh install).
 *
 * That is not hypothetical: migration 0008 added `sessions.mode`, the DDL was
 * not updated, and fresh databases came up with the column missing — the app
 * then failed on `session:list` with "no such column: sessions.mode". These
 * tests pin the invariant so it cannot happen again.
 */

/** better-sqlite3's surface, over sql.js — just what fixLegacyFkActions uses. */
function shim(sqlite: SqlJsDatabase): BetterSqlite3.Database {
  return {
    pragma(stmt: string) {
      const res = sqlite.exec(`PRAGMA ${stmt}`);
      if (!res[0]) return [];
      const { columns, values } = res[0];
      return values.map((row) => Object.fromEntries(row.map((v, i) => [columns[i], v])));
    },
    exec(sql: string) {
      sqlite.exec(sql);
    },
    transaction(fn: () => void) {
      return () => {
        sqlite.exec('BEGIN');
        try {
          fn();
          sqlite.exec('COMMIT');
        } catch (e) {
          sqlite.exec('ROLLBACK');
          throw e;
        }
      };
    },
  } as unknown as BetterSqlite3.Database;
}

const columnsOf = (sqlite: SqlJsDatabase, table: string): string[] =>
  sqlite.exec(`PRAGMA table_info(${table})`)[0].values.map((r) => String(r[1]));

const jobFkAction = (sqlite: SqlJsDatabase, table: string): string | null => {
  const res = sqlite.exec(`PRAGMA foreign_key_list(${table})`);
  if (!res[0]) return null;
  const { columns, values } = res[0];
  const row = values.find((r) => String(r[columns.indexOf('from')]) === 'job_id');
  return row ? String(row[columns.indexOf('on_delete')]) : null;
};

describe('fixLegacyFkActions on a freshly migrated database', () => {
  it('still needs to run (this IS the fresh-install path)', async () => {
    const { sqlite } = await createTestDb();
    expect(fixLegacyFkActions(shim(sqlite), { info: () => {}, warn: () => {} })).toBe(true);
  });

  it('loses no column from sessions or chunks — the rot guard', async () => {
    const { sqlite } = await createTestDb();
    const before = {
      sessions: columnsOf(sqlite, 'sessions'),
      chunks: columnsOf(sqlite, 'chunks'),
    };
    // Sanity: the migrated schema really does carry the column that was lost.
    expect(before.sessions).toContain('mode');

    fixLegacyFkActions(shim(sqlite), { info: () => {}, warn: () => {} });

    expect(columnsOf(sqlite, 'sessions')).toEqual(before.sessions);
    expect(columnsOf(sqlite, 'chunks')).toEqual(before.chunks);
  });

  it('actually corrects the FK actions it exists to fix', async () => {
    const { sqlite } = await createTestDb();
    fixLegacyFkActions(shim(sqlite), { info: () => {}, warn: () => {} });
    expect(jobFkAction(sqlite, 'chunks')).toBe('CASCADE');
    expect(jobFkAction(sqlite, 'sessions')).toBe('SET NULL');
  });

  it('carries session rows across the rebuild with their mode intact', async () => {
    const { sqlite } = await createTestDb();
    sqlite.run("INSERT INTO profiles (id, name) VALUES ('p1', 'Ada')");
    sqlite.run(
      "INSERT INTO sessions (id, profile_id, kind, mode) VALUES ('s1', 'p1', 'live', 'companion')",
    );

    fixLegacyFkActions(shim(sqlite), { info: () => {}, warn: () => {} });

    const rows = sqlite.exec("SELECT id, mode FROM sessions WHERE id = 's1'")[0].values;
    expect(rows).toEqual([['s1', 'companion']]);
  });

  it('is idempotent — a second pass is a no-op', async () => {
    const { sqlite } = await createTestDb();
    expect(fixLegacyFkActions(shim(sqlite), { info: () => {}, warn: () => {} })).toBe(true);
    expect(fixLegacyFkActions(shim(sqlite), { info: () => {}, warn: () => {} })).toBe(false);
  });
});
