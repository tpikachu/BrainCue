import type React from 'react';
import { Pager, SearchInput, Spinner } from './ui';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  /** Extra classes for the cell + header (width/alignment). */
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;

  // Server-side pagination — the parent fetches the current page; we just render.
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;

  // Search (debounced by the parent if it likes).
  query: string;
  onQuery: (q: string) => void;
  searchPlaceholder?: string;

  onRowClick?: (row: T) => void;
  isSelected?: (row: T) => boolean;
  loading?: boolean;
  empty?: React.ReactNode;
  /** Toolbar content shown to the right of the search box (e.g. a "New" button). */
  actions?: React.ReactNode;
}

/**
 * Reusable, server-paginated table. Generic over the row type — pass `columns`
 * with a `render` per cell. The parent owns the data: it fetches a page whenever
 * `page`/`query` change and supplies `rows` + `total`. Used for the jobs table and
 * intended to back other lists (e.g. Reports) too.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  total,
  page,
  pageSize,
  onPage,
  query,
  onQuery,
  searchPlaceholder,
  onRowClick,
  isSelected,
  loading,
  empty,
  actions,
}: DataTableProps<T>) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <SearchInput
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={searchPlaceholder ?? 'Search…'}
          />
        </div>
        {actions}
      </div>

      <div className="overflow-hidden rounded-xl border border-white/5">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 bg-neutral-900/60 text-left text-xs uppercase tracking-wide text-neutral-500">
              {columns.map((c) => (
                <th key={c.key} className={`px-3 py-2 font-medium ${c.className ?? ''}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-neutral-500">
                  <Spinner className="mr-2 inline-block h-4 w-4" />
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-neutral-500">
                  {empty ?? 'Nothing here yet.'}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`border-b border-white/5 last:border-0 ${
                    onRowClick ? 'cursor-pointer' : ''
                  } ${isSelected?.(row) ? 'bg-indigo-500/10' : 'hover:bg-white/5'}`}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2 align-middle ${c.className ?? ''}`}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>{total} total</span>
        <Pager page={page} totalPages={totalPages} onPage={onPage} />
      </div>
    </div>
  );
}
