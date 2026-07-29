import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import { reconcileAlreadyApplied } from './reconcileMigrations';

/**
 * The scenario that produced this module, reproduced exactly.
 *
 * Two branches added the same columns under different migration filenames. A
 * database that had run the other branch's file then met "duplicate column
 * name" on ours — and because drizzle runs every pending migration in ONE
 * transaction, that rolled back the unrelated migration behind it. Permanently:
 * the same failure repeats on every launch, so the newer column never arrives
 * and the app fails somewhere else entirely, naming neither cause.
 */

const require_ = createRequire(join(process.cwd(), 'package.json'));

/** better-sqlite3's surface over sql.js — only what the module uses. */
function shim(sqlite: SqlJsDatabase): BetterSqlite3.Database {
  return {
    prepare(sql: string) {
      return {
        get(...params: unknown[]) {
          const st = sqlite.prepare(sql);
          st.bind(params as never);
          const row = st.step() ? st.getAsObject() : undefined;
          st.free();
          return row;
        },
        run(...params: unknown[]) {
          const st = sqlite.prepare(sql);
          st.bind(params as never);
          st.step();
          st.free();
        },
      };
    },
  } as unknown as BetterSqlite3.Database;
}

const quiet = { info: () => {}, warn: () => {} };

let folder: string | null = null;
afterEach(() => {
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = null;
});

/** A migrations folder on disk with the given `tag → sql`, in order. */
function makeFolder(files: { tag: string; when: number; sql: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'recon-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '6',
      dialect: 'sqlite',
      entries: files.map((f, i) => ({ idx: i, version: '6', when: f.when, tag: f.tag, breakpoints: true })),
    }),
  );
  for (const f of files) writeFileSync(join(dir, `${f.tag}.sql`), f.sql);
  folder = dir;
  return dir;
}

async function db(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs({
    locateFile: (f) => join(require_.resolve('sql.js'), '..', f),
  });
  const d = new SQL.Database();
  d.run(`CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
  d.run(`CREATE TABLE memories (id text primary key)`);
  d.run(`CREATE TABLE jobs (id text primary key)`);
  return d;
}

const applied = (d: SqlJsDatabase) =>
  (d.exec(`SELECT count(*) FROM "__drizzle_migrations"`)[0]?.values[0][0] as number) ?? 0;
const maxWhen = (d: SqlJsDatabase) =>
  (d.exec(`SELECT max(created_at) FROM "__drizzle_migrations"`)[0]?.values[0][0] as number) ?? 0;

describe('reconcileAlreadyApplied', () => {
  it('records a migration whose columns another branch already added, unblocking the one behind it', async () => {
    const d = await db();
    // The other branch's file ran here: same columns, different tag, and its
    // bookkeeping row carries ITS timestamp.
    d.run(`ALTER TABLE memories ADD fact_key text`);
    d.run(`ALTER TABLE memories ADD revision integer DEFAULT 1 NOT NULL`);
    d.run(`CREATE INDEX memories_fact_key_idx ON memories (fact_key)`);
    d.run(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ('other', 1000)`);

    const dir = makeFolder([
      {
        tag: '0015_ours',
        when: 2000,
        sql:
          'ALTER TABLE `memories` ADD `fact_key` text;--> statement-breakpoint\n' +
          'ALTER TABLE `memories` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint\n' +
          'CREATE INDEX `memories_fact_key_idx` ON `memories` (`fact_key`);',
      },
      { tag: '0016_next', when: 3000, sql: 'ALTER TABLE `jobs` ADD `tailored_resume` text;' },
    ]);

    const { reconciled } = reconcileAlreadyApplied(shim(d), dir, quiet);

    // 0015 is recorded (its effect is already there) — 0016 is NOT, because it
    // has real work to do and belongs to drizzle.
    expect(reconciled).toEqual(['0015_ours']);
    expect(maxWhen(d)).toBe(2000);
    expect(applied(d)).toBe(2);
  });

  it('leaves a migration alone when its change is genuinely missing', async () => {
    const d = await db();
    d.run(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ('base', 1000)`);
    const dir = makeFolder([
      { tag: '0015_ours', when: 2000, sql: 'ALTER TABLE `memories` ADD `fact_key` text;' },
    ]);

    expect(reconcileAlreadyApplied(shim(d), dir, quiet).reconciled).toEqual([]);
    expect(maxWhen(d)).toBe(1000); // untouched — drizzle still has to run it
  });

  it('stops at the first migration it cannot verify, rather than skipping past it', async () => {
    // Recording out of order would be catastrophic: drizzle works off the
    // MAXIMUM timestamp, so marking a later migration applied silently skips
    // every unapplied one before it.
    const d = await db();
    d.run(`ALTER TABLE jobs ADD tailored_resume text`);
    d.run(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ('base', 1000)`);
    const dir = makeFolder([
      { tag: '0015_real_work', when: 2000, sql: 'ALTER TABLE `memories` ADD `fact_key` text;' },
      { tag: '0016_already_done', when: 3000, sql: 'ALTER TABLE `jobs` ADD `tailored_resume` text;' },
    ]);

    expect(reconcileAlreadyApplied(shim(d), dir, quiet).reconciled).toEqual([]);
    expect(maxWhen(d)).toBe(1000);
  });

  it('refuses any statement shape it cannot check', async () => {
    const d = await db();
    d.run(`ALTER TABLE memories ADD fact_key text`);
    d.run(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ('base', 1000)`);
    const dir = makeFolder([
      {
        tag: '0015_mixed',
        when: 2000,
        // The ALTER is satisfied; the UPDATE is a data backfill that may not be.
        sql:
          'ALTER TABLE `memories` ADD `fact_key` text;--> statement-breakpoint\n' +
          "UPDATE `memories` SET `fact_key` = 'x';",
      },
    ]);

    expect(reconcileAlreadyApplied(shim(d), dir, quiet).reconciled).toEqual([]);
  });

  it('does nothing on a fresh database', async () => {
    const SQL = await initSqlJs({ locateFile: (f) => join(require_.resolve('sql.js'), '..', f) });
    const d = new SQL.Database(); // no bookkeeping table at all
    const dir = makeFolder([
      { tag: '0000_init', when: 1000, sql: 'ALTER TABLE `memories` ADD `x` text;' },
    ]);
    expect(reconcileAlreadyApplied(shim(d), dir, quiet).reconciled).toEqual([]);
  });
});
