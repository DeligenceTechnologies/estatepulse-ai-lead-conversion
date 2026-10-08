import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CircleDot,
  CalendarArrowDown,
  CalendarArrowUp,
  CalendarDays,
  Loader2,
  Pencil,
  Phone,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { ApiError, messageFor } from '../../lib/api';
import { displayName, initialsFor, useAuth } from '../../context/AuthContext';
import {
  deleteMember,
  listMembers,
  listRoles,
  type Paginated,
  type Role,
  type TeamMember,
  type UserStatus,
} from '../../utils/usersApi';
import { FilterDropdown } from '../common/FilterDropdown';
import { PAGE_SIZE_OPTIONS, Pagination } from '../common/Pagination';
import { MemberFormModal } from '../modals/MemberFormModal';

const PAGE_SIZES = PAGE_SIZE_OPTIONS;
const PAGE_SIZE_KEY = 'ep_agents_page_size';
const SEARCH_DEBOUNCE_MS = 300;

/** The list sorts by join date only. */
type SortOrder = 'asc' | 'desc';

/** Spelled out in words, not just an arrow: which end of the timeline comes first. */
const SORT_OPTIONS: { value: SortOrder; label: string; short: string; icon: React.ReactNode }[] = [
  { value: 'desc', label: 'Newest first', short: 'Newest', icon: <CalendarArrowDown className="w-3.5 h-3.5 text-slate-400" /> },
  { value: 'asc', label: 'Oldest first', short: 'Oldest', icon: <CalendarArrowUp className="w-3.5 h-3.5 text-slate-400" /> },
];

const STATUS_STYLES: Record<UserStatus, string> = {
  active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  inactive: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
};

const formatDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** The value, `delay` ms after it last changed — so search does not fire per keystroke. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** The remembered rows-per-page, or the smallest size. */
function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return (PAGE_SIZES as readonly number[]).includes(stored) ? stored : PAGE_SIZES[0];
  } catch {
    return PAGE_SIZES[0];
  }
}

/**
 * The organization's team: every user, agents and owners alike. Search,
 * filters, sorting and pagination all happen server-side. The list scrolls
 * between a fixed header and a fixed pagination bar.
 *
 * Controls follow the caller's permissions (user.create / user.update /
 * user.delete). That is a courtesy: the server checks every one of them.
 */
export const AgentsView: React.FC = () => {
  const { user, organization, can, refreshSession } = useAuth();
  const orgId = organization?.id;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, SEARCH_DEBOUNCE_MS);
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<UserStatus | ''>('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [pageSize, setPageSize] = useState(readPageSize);
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<Paginated<TeamMember> | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  /** null = closed; 'new' = adding; a member = editing them. */
  const [form, setForm] = useState<TeamMember | 'new' | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Any change to what is being asked for starts again from page one.
  useEffect(() => setPage(1), [debouncedSearch, roleFilter, statusFilter, sortOrder, pageSize]);

  /** Only the newest request may update the screen; an older, slower one is dropped. */
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!orgId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const next = await listMembers({
        page,
        limit: pageSize,
        search: debouncedSearch,
        roleIds: roleFilter ? [roleFilter] : undefined,
        status: statusFilter || undefined,
        sortOrder,
      });
      if (seq !== requestSeq.current) return;
      // Deleting the last row of the last page leaves that page empty: step back.
      if (next.data.length === 0 && page > 1 && next.meta.total > 0) {
        setPage(Math.max(1, next.meta.totalPages));
        return;
      }
      setResult(next);
      setError(null);
      setForbidden(false);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      // A 403 is the answer for someone without user.read, not a failure.
      const isForbidden = e instanceof ApiError && e.code === 'FORBIDDEN';
      setForbidden(isForbidden);
      setError(isForbidden ? null : messageFor(e));
      setResult(null);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [orgId, page, pageSize, debouncedSearch, roleFilter, statusFilter, sortOrder]);

  useEffect(() => {
    void load();
  }, [load]);

  // Roles feed the filter and the add/edit form. Without role.read the list
  // still works; only the role picker is empty.
  useEffect(() => {
    listRoles()
      .then(setRoles)
      .catch(() => setRoles([]));
  }, []);

  const changePageSize = (size: number): void => {
    setPageSize(size);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      /* the choice just will not be remembered */
    }
  };

  const clearFilters = (): void => {
    setSearch('');
    setRoleFilter('');
    setStatusFilter('');
  };

  const handleDelete = async (member: TeamMember): Promise<void> => {
    if (
      !window.confirm(
        `Delete ${displayName(member)}? Their account is removed and they are signed out immediately. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingId(member.id);
    setError(null);
    try {
      await deleteMember(member.id);
      await load();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setDeletingId(null);
    }
  };

  const canCreate = can('user.create');
  const canUpdate = can('user.update');
  const canDelete = can('user.delete');
  const hasFilters = Boolean(search || roleFilter || statusFilter);
  const members = result?.data ?? [];
  const meta = result?.meta;


  const actions = (member: TeamMember): React.ReactNode => {
    const isSelf = member.id === user?.id;
    const deleting = deletingId === member.id;
    if (!canUpdate && !(canDelete && !isSelf)) return null;
    return (
      <div className="flex items-center justify-end gap-1">
        {canUpdate && (
          <button
            onClick={() => setForm(member)}
            disabled={deleting || roles.length === 0}
            title="Edit"
            aria-label={`Edit ${displayName(member)}`}
            className="p-2 rounded-lg text-slate-400 hover:text-emerald-300 hover:bg-emerald-600/15 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        {canDelete && !isSelf && (
          <button
            onClick={() => void handleDelete(member)}
            disabled={deleting}
            title="Delete"
            aria-label={`Delete ${displayName(member)}`}
            className="p-2 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-rose-600/15 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    );
  };

  const identity = (member: TeamMember): React.ReactNode => (
    <div className="flex items-center gap-3 min-w-0">
      <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-bold text-slate-300 shrink-0">
        {initialsFor(member)}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-100 truncate">
          {displayName(member)}
          {member.id === user?.id && <span className="ml-1.5 text-2xs font-medium text-slate-500">(you)</span>}
        </div>
        <div className="text-xs text-slate-500 truncate">{member.email}</div>
      </div>
    </div>
  );

  const roleBadge = (member: TeamMember): React.ReactNode => (
    <span
      className={`inline-flex items-center gap-1 text-2xs font-semibold px-2 py-0.5 rounded-full border ${
        member.role.isSystem
          ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
          : 'bg-slate-800 text-slate-300 border-slate-700'
      }`}
    >
      {member.role.isSystem && <ShieldCheck className="w-3 h-3" />}
      {member.role.name}
    </span>
  );

  const statusBadge = (member: TeamMember): React.ReactNode => (
    <span className={`inline-flex items-center gap-1.5 text-2xs font-semibold px-2 py-0.5 rounded-full border capitalize ${STATUS_STYLES[member.status]}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {member.status}
    </span>
  );

  const currentSort = SORT_OPTIONS.find((o) => o.value === sortOrder) ?? SORT_OPTIONS[0];

  /**
   * The Joined column header says in words how the list is ordered ("Newest ↓")
   * and flips it on click — the list's only sort.
   */
  const joinedHeader = (
    <th
      className="px-4 py-3 font-semibold hidden md:table-cell"
      aria-sort={sortOrder === 'asc' ? 'ascending' : 'descending'}
    >
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wider">Joined</span>
        <button
          onClick={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
          title={`Sorted ${currentSort.label.toLowerCase()} — click for ${
            sortOrder === 'desc' ? 'oldest' : 'newest'
          } first`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-2xs font-semibold normal-case tracking-normal hover:bg-emerald-500/20 cursor-pointer transition-colors"
        >
          {currentSort.short}
          {sortOrder === 'desc' ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />}
        </button>
      </div>
    </th>
  );

  return (
    <div className="h-full flex flex-col text-slate-100">
      {/* Header + toolbar: fixed above the scrolling list */}
      <div className="shrink-0 px-6 pt-6 pb-4 space-y-4 max-w-7xl w-full mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">Agents</h2>
            <p className="text-xs text-slate-400">Everyone in your organization, their role and contact details.</p>
          </div>
          {canCreate && (
            <button
              onClick={() => setForm('new')}
              disabled={roles.length === 0}
              title={roles.length === 0 ? 'Roles could not be loaded' : undefined}
              className="h-9 px-4 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Plus className="w-4 h-4" />
              Add Agent
            </button>
          )}
        </div>

        {!forbidden && (
          <div className="flex flex-col lg:flex-row lg:items-center gap-2">
            <div className="relative w-full lg:max-w-sm">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or email"
                maxLength={100}
                aria-label="Search members"
                className="h-9 w-full bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-8 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-500 hover:text-slate-200 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <FilterDropdown
                label="Role"
                icon={<ShieldCheck className="w-3.5 h-3.5" />}
                allLabel="All roles"
                options={roles.map((role) => ({ value: role.id, label: role.name }))}
                value={roleFilter}
                onChange={setRoleFilter}
              />
              <FilterDropdown
                label="Status"
                icon={<CircleDot className="w-3.5 h-3.5" />}
                allLabel="Any status"
                options={[
                  { value: 'active', label: 'Active', icon: <span className="w-2 h-2 rounded-full bg-emerald-400" /> },
                  { value: 'inactive', label: 'Inactive', icon: <span className="w-2 h-2 rounded-full bg-amber-400" /> },
                ]}
                value={statusFilter}
                onChange={(v) => setStatusFilter(v as UserStatus | '')}
              />
              {/* Phones have no column headers to click. */}
              {hasFilters && (
                <button
                  onClick={clearFilters}
                  className="h-9 px-2.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-rose-300 transition-colors cursor-pointer flex items-center gap-1"
                >
                  <X className="w-3.5 h-3.5" />
                  Clear all
                </button>
              )}
            </div>

            <div className="lg:ml-auto">
              <FilterDropdown
                label="Sort"
                icon={currentSort.icon}
                options={SORT_OPTIONS.map(({ value, label, icon }) => ({ value, label, icon }))}
                value={sortOrder}
                onChange={(value) => setSortOrder(value as SortOrder)}
                align="right"
              />
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
            <div className="text-xs text-rose-200 leading-relaxed flex-1">{error}</div>
            <button onClick={() => setError(null)} aria-label="Dismiss" className="text-rose-300 hover:text-rose-100 cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* The list: the only part that scrolls */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        <div className="px-6 pb-4 max-w-7xl w-full mx-auto">
          {forbidden ? (
            <EmptyState icon={<ShieldCheck className="w-6 h-6 text-slate-600" />}>
              Your role does not include viewing team members. Ask your organization owner if you need access.
            </EmptyState>
          ) : result === null && loading ? (
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl divide-y divide-slate-800">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3.5 animate-pulse">
                  <div className="w-9 h-9 rounded-full bg-slate-800" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-40 rounded bg-slate-800" />
                    <div className="h-2.5 w-56 rounded bg-slate-800/70" />
                  </div>
                  <div className="h-5 w-16 rounded-full bg-slate-800" />
                </div>
              ))}
            </div>
          ) : members.length === 0 ? (
            <EmptyState icon={<Users className="w-6 h-6 text-slate-600" />}>
              {hasFilters ? (
                <>
                  No members match these filters.{' '}
                  <button onClick={clearFilters} className="text-emerald-400 hover:text-emerald-300 font-semibold cursor-pointer">
                    Clear filters
                  </button>
                </>
              ) : (
                'No agents yet. Add your first agent to get started.'
              )}
            </EmptyState>
          ) : (
            <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
              {/* Table: tablets and up */}
              <div className="hidden md:block bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="text-2xs uppercase text-slate-500 bg-slate-950/70 border-b border-slate-800">
                    <tr className="text-left">
                      <th className="px-4 py-3 font-semibold tracking-wider">Member</th>
                      <th className="px-4 py-3 font-semibold tracking-wider">Role</th>
                      <th className="px-4 py-3 font-semibold tracking-wider">Phone</th>
                      <th className="px-4 py-3 font-semibold tracking-wider">Status</th>
                      <th className="px-4 py-3 font-semibold tracking-wider hidden lg:table-cell">Last sign-in</th>
                      {joinedHeader}
                      <th className="px-4 py-3 w-24">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {members.map((member) => (
                      <tr key={member.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="px-4 py-3 max-w-xs">{identity(member)}</td>
                        <td className="px-4 py-3">{roleBadge(member)}</td>
                        <td className="px-4 py-3 font-mono text-slate-300 whitespace-nowrap">{member.phone || '—'}</td>
                        <td className="px-4 py-3">{statusBadge(member)}</td>
                        <td className="px-4 py-3 text-slate-400 whitespace-nowrap hidden lg:table-cell">{formatDate(member.lastLoginAt)}</td>
                        <td className="px-4 py-3 text-slate-400 whitespace-nowrap hidden md:table-cell">{formatDate(member.createdAt)}</td>
                        <td className="px-4 py-3">{actions(member)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Cards: phones */}
              <div className="md:hidden space-y-3">
                {members.map((member) => (
                  <div key={member.id} className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      {identity(member)}
                      {statusBadge(member)}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-400">
                      {roleBadge(member)}
                      <span className="inline-flex items-center gap-1.5 font-mono">
                        <Phone className="w-3 h-3" />
                        {member.phone || '—'}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarDays className="w-3 h-3" />
                        Joined {formatDate(member.createdAt)}
                      </span>
                    </div>
                    {actions(member) && <div className="pt-2 border-t border-slate-800">{actions(member)}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Pagination: always pinned to the bottom */}
      {!forbidden && meta && (
        <div className="shrink-0 border-t border-slate-800 bg-slate-900/95 backdrop-blur">
          <div className="px-6 py-3 max-w-7xl w-full mx-auto">
            <Pagination
              meta={meta}
              itemLabel={meta.total === 1 ? 'member' : 'members'}
              disabled={loading}
              onPageChange={setPage}
              onPageSizeChange={changePageSize}
              pageSizes={PAGE_SIZES}
            />
          </div>
        </div>
      )}

      {form && orgId && (
        <MemberFormModal
          key={form === 'new' ? 'new' : form.id}
          orgId={orgId}
          roles={roles}
          member={form === 'new' ? undefined : form}
          currentUserId={user?.id}
          onClose={() => setForm(null)}
          onSaved={(saved) => {
            void load();
            // Editing yourself changes the name and role the sidebar shows.
            if (saved.id === user?.id) void refreshSession();
          }}
        />
      )}
    </div>
  );
};

const EmptyState: React.FC<{ icon: React.ReactNode; children: React.ReactNode }> = ({ icon, children }) => (
  <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-10 text-center space-y-3">
    <div className="flex justify-center">{icon}</div>
    <div className="text-xs text-slate-400 leading-relaxed max-w-md mx-auto">{children}</div>
  </div>
);
