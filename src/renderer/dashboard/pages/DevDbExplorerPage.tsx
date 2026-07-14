import type React from 'react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Badge, Page, Pager, SearchInput } from '../../components/ui';

const PAGE = 25;

// Columns known to hold JSON — pretty-printed in the expanded detail.
const JSON_COLS = new Set([
  'parsedResume',
  'parsedJd',
  'parsedCompany',
  'star',
  'tokens',
]);

type Table = { name: string; rows: number };
type RowsResult = { columns: string[]; rows: Record<string, unknown>[]; total: number };

/** DEV-ONLY: browse the local SQLite DB — including how grounded/parsed resume,
 *  JD, and company data are stored. Only routed in unpackaged builds. */
export default function DevDbExplorerPage() {
  const [tables, setTables] = useState<Table[]>([]);
  const [active, setActive] = useState<string>('');
  const [filter, setFilter] = useState('');
  const [data, setData] = useState<RowsResult | null>(null);
  const [page, setPage] = useState(0);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.dev
      .tables()
      .then((t) => {
        setTables(t);
        if (t.length) setActive((a) => a || t[0].name);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (!active) return;
    setOpenRow(null);
    setError(null);
    void api.dev
      .rows(active, PAGE, page * PAGE)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [active, page]);

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE));
  const shownTables = filter.trim()
    ? tables.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : tables;

  return (
    <Page
      title="DB Explorer"
      subtitle="Dev-only — read-only view of the local SQLite database."
      width="max-w-6xl"
    >
      {error && <p className="mb-3 text-sm text-red-300">{error}</p>}

      <div className="mb-3">
        <SearchInput
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables…"
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {shownTables.map((t) => (
          <button
            key={t.name}
            onClick={() => {
              setActive(t.name);
              setPage(0);
            }}
            className={`rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
              active === t.name
                ? 'bg-indigo-600 text-white'
                : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
            }`}
          >
            {t.name} <span className="opacity-60">{t.rows}</span>
          </button>
        ))}
      </div>

      {data && (
        <>
          <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
            <span className="font-mono">
              {active} · {data.total} row{data.total === 1 ? '' : 's'} · {data.columns.length} cols
            </span>
            <span>click a row to expand</span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-white/5">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/5 bg-neutral-900/60 text-[10px] uppercase tracking-wide text-neutral-500">
                  {data.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-2 py-1.5 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={data.columns.length}
                      className="px-2 py-6 text-center text-neutral-500"
                    >
                      No rows.
                    </td>
                  </tr>
                )}
                {data.rows.map((row, i) => {
                  const open = openRow === i;
                  return (
                    <tr key={i} className="border-b border-white/5 last:border-0 align-top">
                      <td colSpan={data.columns.length} className="p-0">
                        <button
                          type="button"
                          onClick={() => setOpenRow(open ? null : i)}
                          className="block w-full cursor-pointer text-left hover:bg-white/5"
                        >
                          <span className="flex">
                            {data.columns.map((c) => (
                              <span
                                key={c}
                                className="max-w-[220px] flex-1 truncate px-2 py-1.5 font-mono text-neutral-300"
                                title={cellText(row[c])}
                              >
                                {preview(row[c])}
                              </span>
                            ))}
                          </span>
                        </button>
                        {open && (
                          <dl className="space-y-2 border-t border-white/5 bg-neutral-950/40 p-3">
                            {data.columns.map((c) => (
                              <div key={c} className="grid grid-cols-[10rem_1fr] gap-2">
                                <dt className="truncate font-mono text-[11px] font-medium text-neutral-500">
                                  {c}
                                </dt>
                                <dd className="min-w-0">
                                  <CellValue col={c} value={row[c]} />
                                </dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pager page={page} totalPages={totalPages} onPage={setPage} />
        </>
      )}
    </Page>
  );
}

/** True for SQLite blob values (vectors etc.) once they cross IPC. */
function isBlob(v: unknown): boolean {
  return ArrayBuffer.isView(v) || v instanceof ArrayBuffer;
}
function blobLen(v: unknown): number {
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  return 0;
}

/** Full text of a value (for the title tooltip). */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (isBlob(v)) return `<blob ${blobLen(v)} bytes>`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** A short cell preview for the table grid. */
function preview(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <span className="text-neutral-600">null</span>;
  if (isBlob(v)) return <span className="text-neutral-500">{`<blob ${blobLen(v)} b>`}</span>;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** Full value in the expanded detail — pretty-prints JSON. */
function CellValue({ col, value }: { col: string; value: unknown }) {
  if (value === null || value === undefined) return <span className="text-neutral-600">null</span>;
  if (isBlob(value))
    return <span className="text-neutral-500">{`<blob ${blobLen(value)} bytes>`}</span>;
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (JSON_COLS.has(col) || (str.length > 1 && (str[0] === '{' || str[0] === '['))) {
    try {
      const pretty = JSON.stringify(JSON.parse(str), null, 2);
      return (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-neutral-950/70 p-2 font-mono text-[11px] leading-relaxed text-neutral-300">
          {pretty}
        </pre>
      );
    } catch {
      /* not JSON — fall through */
    }
  }
  return <span className="whitespace-pre-wrap break-words text-neutral-300">{str}</span>;
}
