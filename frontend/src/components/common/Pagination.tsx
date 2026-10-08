import React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { FilterDropdown } from './FilterDropdown';

/** The `meta` block of every paginated list response. */
export interface PaginationMeta {
  page: number;
  limit: number;
  count: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

interface PaginationProps {
  meta: PaginationMeta;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  /** What a row is, for "Showing 1–10 of 42 agents". */
  itemLabel?: string;
  /** Disables navigation while a page is loading. */
  disabled?: boolean;
  pageSizes?: readonly number[];
}

/** [1, '…', 4, 5, 6, '…', 12]: first, last, and the current page's neighbours. */
export function pageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [...new Set([1, total, current - 1, current, current + 1])]
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  pages.forEach((page, i) => {
    if (i > 0 && page - pages[i - 1] > 1) out.push('…');
    out.push(page);
  });
  return out;
}

/**
 * The bar under a paginated list: where you are ("Showing 11–20 of 42"), how
 * many rows a page holds, and page navigation. Built to sit pinned at the
 * bottom of a view, so the rows-per-page menu opens upwards.
 */
export const Pagination: React.FC<PaginationProps> = ({
  meta,
  onPageChange,
  onPageSizeChange,
  itemLabel,
  disabled = false,
  pageSizes = PAGE_SIZE_OPTIONS,
}) => {
  const first = meta.count > 0 ? (meta.page - 1) * meta.limit + 1 : 0;
  const last = meta.count > 0 ? first + meta.count - 1 : 0;

  return (
    <div className="flex flex-col-reverse sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
      <p aria-live="polite" className="tabular-nums">
        {meta.total === 0 ? (
          'No results'
        ) : (
          <>
            Showing <span className="font-semibold text-slate-100">{first}</span>
            {last !== first && (
              <>
                –<span className="font-semibold text-slate-100">{last}</span>
              </>
            )}{' '}
            of <span className="font-semibold text-slate-100">{meta.total}</span>
            {itemLabel && <> {itemLabel}</>}
          </>
        )}
      </p>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-slate-500">Rows per page</span>
          <FilterDropdown
            variant="compact"
            placement="top"
            align="right"
            label="Rows per page"
            options={pageSizes.map((size) => ({ value: String(size), label: String(size) }))}
            value={String(meta.limit)}
            onChange={(value) => onPageSizeChange(Number(value))}
          />
        </div>

        {meta.totalPages > 1 && (
          <>
            <span className="hidden sm:block w-px h-5 bg-slate-800" aria-hidden />
            <nav className="flex items-center gap-1" aria-label="Pagination">
              <PageButton onClick={() => onPageChange(1)} disabled={disabled || !meta.hasPrevPage} label="First page" hideOnMobile>
                <ChevronsLeft className="w-3.5 h-3.5" />
              </PageButton>
              <PageButton onClick={() => onPageChange(meta.page - 1)} disabled={disabled || !meta.hasPrevPage} label="Previous page">
                <ChevronLeft className="w-3.5 h-3.5" />
              </PageButton>

              {/* Numbers on wider screens; "3 / 12" on phones. */}
              <div className="hidden sm:flex items-center gap-1">
                {pageNumbers(meta.page, meta.totalPages).map((item, i) =>
                  item === '…' ? (
                    <span key={`gap-${i}`} className="w-6 text-center text-slate-600" aria-hidden>
                      …
                    </span>
                  ) : (
                    <PageButton
                      key={item}
                      onClick={() => onPageChange(item)}
                      disabled={disabled}
                      active={item === meta.page}
                      label={`Page ${item}`}
                    >
                      {item}
                    </PageButton>
                  ),
                )}
              </div>
              <span className="sm:hidden px-2 font-semibold text-slate-200 tabular-nums">
                {meta.page} / {meta.totalPages}
              </span>

              <PageButton onClick={() => onPageChange(meta.page + 1)} disabled={disabled || !meta.hasNextPage} label="Next page">
                <ChevronRight className="w-3.5 h-3.5" />
              </PageButton>
              <PageButton onClick={() => onPageChange(meta.totalPages)} disabled={disabled || !meta.hasNextPage} label="Last page" hideOnMobile>
                <ChevronsRight className="w-3.5 h-3.5" />
              </PageButton>
            </nav>
          </>
        )}
      </div>
    </div>
  );
};

const PageButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  hideOnMobile?: boolean;
  label: string;
  children: React.ReactNode;
}> = ({ onClick, disabled, active, hideOnMobile, label, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled || active}
    aria-label={label}
    aria-current={active ? 'page' : undefined}
    className={`${hideOnMobile ? 'hidden sm:flex' : 'flex'} min-w-8 h-8 px-2 rounded-lg border text-xs font-semibold items-center justify-center tabular-nums transition-colors ${
      active
        ? 'bg-emerald-600 border-emerald-600 text-on-accent cursor-default shadow-sm shadow-emerald-900/40'
        : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-600 hover:text-white cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:border-slate-800 disabled:hover:text-slate-300'
    }`}
  >
    {children}
  </button>
);
