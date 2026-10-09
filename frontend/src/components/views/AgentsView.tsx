import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CircleDot,
  CalendarArrowDown,
  CalendarArrowUp,
  LayoutGrid,
  List,
  Plus,
  Search,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { ApiError, messageFor } from '../../lib/api';
import { displayName, useAuth } from '../../context/AuthContext';
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
import { MemberDrawer } from '../team/MemberDrawer';
import { getOrgSettings, type OrgSettings } from '../../utils/orgSettingsApi';
import { MemberActions, MemberCard, MemberRow } from '../team/MemberParts';

const PAGE_SIZES = PAGE_SIZE_OPTIONS;
const PAGE_SIZE_KEY = 'ep_agents_page_size';
const SEARCH_DEBOUNCE_MS = 300;
const noop = (): void => {};
const VIEW_KEY = 'ep_team_view';
/** Local times and "working now" are recomputed this often. */
const CLOCK_TICK_MS = 60_000;

type ViewMode = 'list' | 'grid';

/** The list sorts by join date only. */
type SortOrder = 'asc' | 'desc';

/** Spelled out in words, not just an arrow: which end of the timeline comes first. */
const SORT_OPTIONS: { value: SortOrder; label: string; icon: React.ReactNode }[] = [
  { value: 'desc', label: 'Newest first', icon: <CalendarArrowDown className="w-3.5 h-3.5 text-slate-400" /> },
  { value: 'asc', label: 'Oldest first', icon: <CalendarArrowUp className="w-3.5 h-3.5 text-slate-400" /> },
];

/** The value, `delay` ms after it last changed — so search does not fire per keystroke. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

/** The current time, refreshed every `ms` — for clocks that must stay roughly live. */
function useNow(ms: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
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
 * The organization's team: every user, agents and owners alike, as a grid of
 * cards or a list (remembered per browser). Each shows only name, roles,
 * status, mobile and member since, with View / Edit / Delete last; clicking a
 * member opens MemberDrawer with everything else (lead load, working hours,
 * timezone, sign-in history). Search,
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
  const [view, setView] = useState<ViewMode>(readView);
  const now = useNow(CLOCK_TICK_MS);
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<Paginated<TeamMember> | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  /** null = closed; 'new' = adding; a member = editing them. */
  const [form, setForm] = useState<TeamMember | 'new' | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** The member whose details panel is open. */
  const [openId, setOpenId] = useState<string | null>(null);
  const closeDetails = useCallback(() => setOpenId(null), []);

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

  const changeView = (next: ViewMode): void => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* the choice just will not be remembered */
    }
  };

  // A new member starts on the organization's timezone and business hours.
  const [orgDefaults, setOrgDefaults] = useState<OrgSettings | null>(null);
  const canReadOrg = can('organization.read');
  useEffect(() => {
    if (!canReadOrg) return;
    getOrgSettings()
      .then(setOrgDefaults)
      .catch(() => setOrgDefaults(null));
  }, [canReadOrg]);

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
      setOpenId(null);
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
  // Read from the loaded page, so an edit shows in the open panel as soon as the list reloads.
  const openMember = members.find((m) => m.id === openId) ?? null;


  /** Edit and Delete at the end of each row and card; the panel opens on everything else. */
  const rowActions = (member: TeamMember): React.ReactNode => (
    <MemberActions
      name={displayName(member)}
      canEdit={canUpdate && roles.length > 0}
      canDelete={canDelete && member.id !== user?.id}
      deleting={deletingId === member.id}
      onView={() => setOpenId(member.id)}
      onEdit={() => setForm(member)}
      onDelete={() => void handleDelete(member)}
    />
  );

  const currentSort = SORT_OPTIONS.find((o) => o.value === sortOrder) ?? SORT_OPTIONS[0];

  /**
   * The Member since header carries a plain arrow (↓ newest first, ↑ oldest
   * first) that flips the list's only sort; the tooltip says it in words.
   */
  const joinedHeader = (
    <th
      className="px-4 py-3 font-semibold"
      aria-sort={sortOrder === 'asc' ? 'ascending' : 'descending'}
    >
      <div className="flex items-center gap-1">
        <span className="uppercase tracking-wider whitespace-nowrap">Member since</span>
        <button
          onClick={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
          title={`Sorted ${currentSort.label.toLowerCase()} — click for ${
            sortOrder === 'desc' ? 'oldest' : 'newest'
          } first`}
          aria-label={`Sorted ${currentSort.label.toLowerCase()}`}
          className="p-0.5 rounded text-slate-400 hover:text-emerald-300 cursor-pointer transition-colors"
        >
          {sortOrder === 'desc' ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUp className="w-3.5 h-3.5" />}
        </button>
      </div>
    </th>
  );

  return (
    <div className="h-full flex flex-col text-slate-100">
      {/* Header + toolbar: fixed above the scrolling list */}
      <div className="shrink-0 px-6 pt-6 pb-4 space-y-4 max-w-7xl w-full mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md shadow-emerald-500/20 shrink-0">
              <Users className="w-5 h-5 text-on-accent" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">Team Members</h2>
              <p className="text-xs text-slate-400">
                Roles, lead capacity, working hours and timezones for everyone in your organization.
              </p>
            </div>
          </div>
          {canCreate && (
            <button
              onClick={() => setForm('new')}
              disabled={roles.length === 0}
              title={roles.length === 0 ? 'Roles could not be loaded' : undefined}
              className="h-9 px-4 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Plus className="w-4 h-4" />
              Add Member
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

            <div className="lg:ml-auto flex items-center gap-2">
              <div
                role="radiogroup"
                aria-label="Layout"
                className="hidden md:flex items-center h-9 p-0.5 bg-slate-900 border border-slate-800 rounded-lg"
              >
                {(
                  [
                    { mode: 'grid', label: 'Grid', icon: LayoutGrid },
                    { mode: 'list', label: 'List', icon: List },
                  ] as const
                ).map(({ mode, label, icon: Icon }) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={view === mode}
                    onClick={() => changeView(mode)}
                    className={`h-full px-2.5 rounded-md flex items-center gap-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                      view === mode
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
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
          ) : result === null && loading && view === 'grid' ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 space-y-4 animate-pulse">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-slate-800" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 w-32 rounded bg-slate-800" />
                      <div className="h-2.5 w-20 rounded bg-slate-800/70" />
                    </div>
                  </div>
                  <div className="h-14 rounded-lg bg-slate-800/60" />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="h-14 rounded-lg bg-slate-800/60" />
                    <div className="h-14 rounded-lg bg-slate-800/60" />
                  </div>
                  <div className="h-6 w-48 rounded bg-slate-800/60" />
                </div>
              ))}
            </div>
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
                'No team members yet. Add your first member to get started.'
              )}
            </EmptyState>
          ) : (
            <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
              {/* List: tablets and up, when chosen. Phones always get cards. */}
              {view === 'list' && (
                <div className="hidden md:block bg-slate-900/80 border border-slate-800 rounded-xl overflow-x-auto custom-scrollbar">
                  <table className="w-full text-xs min-w-[760px]">
                    <thead className="text-2xs uppercase text-slate-500 bg-slate-950/70 border-b border-slate-800">
                      <tr className="text-left">
                        <th className="px-4 py-3 font-semibold tracking-wider">Member</th>
                        <th className="px-4 py-3 font-semibold tracking-wider">Roles</th>
                        <th className="px-4 py-3 font-semibold tracking-wider">Status</th>
                        <th className="px-4 py-3 font-semibold tracking-wider whitespace-nowrap">Mobile number</th>
                        {joinedHeader}
                        <th className="px-4 py-3 font-semibold tracking-wider text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80">
                      {members.map((member) => (
                        <MemberRow
                          key={member.id}
                          member={member}
                          isSelf={member.id === user?.id}
                          onOpen={() => setOpenId(member.id)}
                          actions={rowActions(member)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Grid: always on phones; on larger screens when chosen */}
              <div
                className={`grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 ${view === 'list' ? 'md:hidden' : ''}`}
              >
                {members.map((member) => (
                  <MemberCard
                    key={member.id}
                    member={member}
                    isSelf={member.id === user?.id}
                    onOpen={() => setOpenId(member.id)}
                    actions={rowActions(member)}
                  />
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

      {openMember && (
        <MemberDrawer
          member={openMember}
          isSelf={openMember.id === user?.id}
          now={now}
          canEdit={canUpdate && roles.length > 0}
          canDelete={canDelete && openMember.id !== user?.id}
          deleting={deletingId === openMember.id}
          onEdit={() => setForm(openMember)}
          onDelete={() => void handleDelete(openMember)}
          // While the edit form is open on top, Escape belongs to the form.
          onClose={form ? noop : closeDetails}
        />
      )}

      {form && orgId && (
        <MemberFormModal
          key={form === 'new' ? 'new' : form.id}
          orgId={orgId}
          roles={roles}
          member={form === 'new' ? undefined : form}
          defaults={orgDefaults ?? undefined}
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

