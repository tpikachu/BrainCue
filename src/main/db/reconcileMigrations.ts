import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * Let migrations get past a change that is ALREADY in the database.
 *
 * Drizzle decides what to run by one number: the largest `created_at` in
 * `__drizzle_migrations`. Everything in the journal with a later `when` is
 * applied, in a SINGLE transaction. So one statement that cannot run — because
 * its effect is already there — rolls back every migration behind it, forever.
 * The app then keeps starting, logs one line, and every feature that needs a
 * newer column fails with a bare SQLite error somewhere else entirely.
 *
 * That is not hypothetical. Two branches added the same memory columns under
 * different migration filenames; a database that had run the other branch met
 * `duplicate column name: fact_key`, which then blocked the unrelated migration
 * behind it and left a Space unable to store a tailored résumé. The symptom
 * ("table jobs has no column named tailored_resume") named neither cause.
 *
 * So before migrating: walk the pending entries in order and, for any whose
 * every statement is demonstrably already true, record it as applied without
 * running it. Stop at the first one that is not — drizzle works off the MAXIMUM
 * timestamp, so recording out of order would skip real work.
 *
 * Deliberately narrow. Only two statement shapes are recognised, both additive
 * and both checkable exactly:
 *   ALTER TABLE t ADD c …   → is column c on table t?
 *   CREATE INDEX i …        → does index i exist?
 * Anything else — a table create, a data backfill, a drop — makes the migration
 * un-analysable, and it is left to drizzle to run and to fail loudly if it must.
 * This can only ever skip work that is already done; it can never invent a
 * schema change or decide a migration was unnecessary.
 */

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const ADD_COLUMN = /^\s*ALTER\s+TABLE\s+[`"[]?(\w+)[`"\]]?\s+ADD\s+(?:COLUMN\s+)?[`"[]?(\w+)[`"\]]?/i;
const CREATE_INDEX = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)[`"\]]?/i;

function columnExists(sqlite: BetterSqlite3.Database, table: string, column: string): boolean {
  const row = sqlite
    .prepare(`SELECT count(*) AS n FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

function indexExists(sqlite: BetterSqlite3.Database, name: string): boolean {
  const row = sqlite
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/** True when every statement in this migration is already reflected in the DB. */
function alreadySatisfied(sqlite: BetterSqlite3.Database, sql: string): boolean {
  const statements = sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length === 0) return false;

  for (const stmt of statements) {
    const add = ADD_COLUMN.exec(stmt);
    if (add) {
      if (!columnExists(sqlite, add[1], add[2])) return false;
      continue;
    }
    const idx = CREATE_INDEX.exec(stmt);
    if (idx) {
      if (!indexExists(sqlite, idx[1])) return false;
      continue;
    }
    return false; // a shape we cannot verify — do not claim it is done
  }
  return true;
}

export interface ReconcileResult {
  /** Migration tags recorded as applied without being run. */
  reconciled: string[];
}

export function reconcileAlreadyApplied(
  sqlite: BetterSqlite3.Database,
  migrationsFolder: string,
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): ReconcileResult {
  const reconciled: string[] = [];
  try {
    const bookkeeping = (
      sqlite
        .prepare(
          `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`,
        )
        .get() as { n: number }
    ).n;
    if (bookkeeping === 0) return { reconciled }; // fresh DB — nothing to reconcile

    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] };

    for (const entry of [...journal.entries].sort((a, b) => a.when - b.when)) {
      // Re-read each round: recording one entry moves the high-water mark.
      const last =
        (
          sqlite
            .prepare(`SELECT max(created_at) AS m FROM "__drizzle_migrations"`)
            .get() as { m: number | null }
        ).m ?? 0;
      if (entry.when <= last) continue; // drizzle considers this applied

      const file = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
      if (!alreadySatisfied(sqlite, file)) break; // leave this and everything after to drizzle

      sqlite
        .prepare(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`)
        .run(crypto.createHash('sha256').update(file).digest('hex'), entry.when);
      reconciled.push(entry.tag);
    }

    if (reconciled.length > 0) {
      log.info(
        `db: ${reconciled.length} migration(s) were already applied by another branch or a ` +
          `partial run — recorded without re-running: ${reconciled.join(', ')}`,
      );
    }
  } catch (e) {
    // Never block startup: worst case drizzle fails as it did before, loudly.
    log.warn('db: migration reconciliation skipped', e);
  }
  return { reconciled };
}
