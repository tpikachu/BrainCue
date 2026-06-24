import { z } from 'zod';
import { app } from 'electron';
import { IPC } from '@shared/ipc';
import { handle, NoInput } from './helpers';
import { rawDb } from '../db';

/**
 * DEV-ONLY DB explorer (registered only when the app is NOT packaged). Lets a
 * developer browse the local SQLite DB — including how parsed/grounded resume,
 * JD, and company data are stored — without external tools. Read-only.
 */
export function registerDevIpc(): void {
  if (app.isPackaged) return; // never expose in production builds

  // List user tables (excludes sqlite internal + drizzle migration bookkeeping)
  // with their row counts.
  handle(IPC.dev.tables, NoInput, () => {
    const sqlite = rawDb();
    const names = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    return names.map(({ name }) => {
      const { c } = sqlite.prepare(`SELECT count(*) AS c FROM "${name}"`).get() as { c: number };
      return { name, rows: c };
    });
  });

  // Read a page of rows from one table (newest first when a createdAt column
  // exists). The table name is validated against the live table list, so the
  // interpolation can't be abused.
  handle(
    IPC.dev.rows,
    z.object({
      table: z.string().min(1),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    ({ table, limit, offset }) => {
      const sqlite = rawDb();
      const valid = (
        sqlite
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
          .all(table) as { name: string }[]
      ).length;
      if (!valid) throw new Error(`Unknown table: ${table}`);

      const cols = (
        sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
      ).map((c) => c.name);
      const hasCreated = cols.includes('createdAt');
      const order = hasCreated ? 'ORDER BY createdAt DESC' : '';
      const { c: total } = sqlite.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as {
        c: number;
      };
      const rows = sqlite
        .prepare(`SELECT * FROM "${table}" ${order} LIMIT ? OFFSET ?`)
        .all(limit, offset) as Record<string, unknown>[];
      return { columns: cols, rows, total };
    },
  );
}
