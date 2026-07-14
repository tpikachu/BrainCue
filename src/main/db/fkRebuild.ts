import type Database from 'better-sqlite3';

/** Minimal logger surface so this module stays importable without electron
 *  (it is exercised against real DB copies outside the app). */
export interface FkRebuildLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

const CHUNKS_DDL = `
CREATE TABLE chunks_new (
  \`id\` text PRIMARY KEY NOT NULL,
  \`profile_id\` text NOT NULL,
  \`source_type\` text NOT NULL,
  \`source_id\` text,
  \`ord\` integer DEFAULT 0 NOT NULL,
  \`content\` text NOT NULL,
  \`token_count\` integer DEFAULT 0 NOT NULL,
  \`created_at\` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  \`job_id\` text,
  FOREIGN KEY (\`profile_id\`) REFERENCES \`profiles\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (\`job_id\`) REFERENCES \`jobs\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
INSERT INTO chunks_new (id, profile_id, source_type, source_id, ord, content, token_count, created_at, job_id)
  SELECT id, profile_id, source_type, source_id, ord, content, token_count, created_at, job_id FROM chunks;
DROP TABLE chunks;
ALTER TABLE chunks_new RENAME TO chunks;
CREATE INDEX \`chunks_profile_idx\` ON \`chunks\` (\`profile_id\`);
`;

const SESSIONS_DDL = `
CREATE TABLE sessions_new (
  \`id\` text PRIMARY KEY NOT NULL,
  \`profile_id\` text NOT NULL,
  \`interview_type\` text DEFAULT 'general' NOT NULL,
  \`status\` text DEFAULT 'idle' NOT NULL,
  \`started_at\` integer,
  \`ended_at\` integer,
  \`created_at\` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  \`job_id\` text,
  \`kind\` text DEFAULT 'live' NOT NULL,
  FOREIGN KEY (\`profile_id\`) REFERENCES \`profiles\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (\`job_id\`) REFERENCES \`jobs\`(\`id\`) ON UPDATE no action ON DELETE set null
);
INSERT INTO sessions_new (id, profile_id, interview_type, status, started_at, ended_at, created_at, job_id, kind)
  SELECT id, profile_id, interview_type, status, started_at, ended_at, created_at, job_id, kind FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX \`sessions_profile_idx\` ON \`sessions\` (\`profile_id\`);
`;

/**
 * Migration 0001 added `chunks.job_id` / `sessions.job_id` with a bare
 * `REFERENCES jobs(id)` — ON DELETE "no action" — while schema.ts promises
 * CASCADE / SET NULL. With `PRAGMA foreign_keys = ON`, deleting a job that still
 * has chunks/sessions then hard-fails instead of cascading/nulling as designed.
 *
 * SQLite cannot ALTER an FK action, and `DROP TABLE` with foreign_keys ON runs
 * an implicit `DELETE FROM` first (which would cascade-wipe `embeddings`), so
 * the fix is the documented table-rebuild dance with FK enforcement OFF:
 * create-copy-drop-rename inside one transaction, then `foreign_key_check`.
 *
 * Idempotent: keyed off the live PRAGMA state, it runs at most once per DB.
 * Runs AFTER migrations (the rebuilt `sessions` includes the v1.5 `kind`
 * column). Returns true when a rebuild was performed.
 */
export function fixLegacyFkActions(sqlite: Database.Database, log: FkRebuildLog = console): boolean {
  const jobFkAction = (table: string): string | null => {
    const fks = sqlite.pragma(`foreign_key_list(${table})`) as { from: string; on_delete: string }[];
    return fks.find((f) => f.from === 'job_id')?.on_delete ?? null;
  };
  const chunksOk = jobFkAction('chunks') === 'CASCADE';
  const sessionsOk = jobFkAction('sessions') === 'SET NULL';
  if (chunksOk && sessionsOk) return false;

  log.info(`db: rebuilding legacy FK actions (chunks ok: ${chunksOk}, sessions ok: ${sessionsOk})`);
  sqlite.pragma('foreign_keys = OFF'); // must be outside the transaction (no-op inside)
  try {
    sqlite.transaction(() => {
      if (!chunksOk) sqlite.exec(CHUNKS_DDL);
      if (!sessionsOk) sqlite.exec(SESSIONS_DDL);
    })();
    const violations = sqlite.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      // Pre-existing orphans surfaced by the rebuild — report, don't crash.
      log.warn(`db: foreign_key_check found ${violations.length} orphaned row(s) after FK rebuild`);
    }
    log.info('db: FK actions rebuilt (chunks.job_id → CASCADE, sessions.job_id → SET NULL)');
    return true;
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
}
