import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  KeyRound,
  Loader2,
  Lock,
  Minus,
  Plus,
  RotateCcw,
  Save,
  Shield,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { ApiError, messageFor } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import {
  createRole,
  deleteRole,
  listPermissionGroups,
  listRoles,
  updateRole,
  type PermissionGroup,
  type Role,
} from '../../utils/usersApi';

/** What the editor holds: a role being edited, or a new one (`id` null). */
interface Draft {
  id: string | null;
  name: string;
  description: string;
  permissions: string[];
}

const NEW = 'new';

const field =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-600/30 disabled:opacity-60';

const draftFor = (role: Role | null): Draft => ({
  id: role?.id ?? null,
  name: role?.name ?? '',
  description: role?.description ?? '',
  permissions: role ? [...role.permissions] : [],
});

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((p) => b.includes(p));

/**
 * In every module the "view" permission (`<module>.read`) is what the others
 * build on: you cannot edit users you cannot see. Granting any other permission
 * of a module grants its read too, and revoking read revokes the module.
 */
const readKeyOf = (group: PermissionGroup): string | undefined =>
  group.permissions.find((p) => p.key.endsWith('.read'))?.key;

/**
 * Roles & permissions: the owner creates roles and chooses, module by module,
 * what each one may do. The Owner role is the system role — every permission,
 * never editable — and is shown locked at the top of the list.
 *
 * Controls follow role.create / role.update / role.delete; the server checks
 * each of them regardless.
 */
export const RolesView: React.FC = () => {
  const { can, refreshSession, roles: myRoles } = useAuth();
  const canCreate = can('role.create');
  const canUpdate = can('role.update');
  const canDelete = can('role.delete');

  const [roles, setRoles] = useState<Role[]>([]);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** A role id, NEW, or null before anything is chosen. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFor(null));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Phones show one pane at a time. */
  const [mobileEditor, setMobileEditor] = useState(false);

  const load = useCallback(async (): Promise<Role[]> => {
    try {
      const [nextRoles, nextGroups] = await Promise.all([listRoles(), listPermissionGroups()]);
      setRoles(nextRoles);
      setGroups(nextGroups);
      setForbidden(false);
      setLoadError(null);
      return nextRoles;
    } catch (e) {
      const isForbidden = e instanceof ApiError && e.code === 'FORBIDDEN';
      setForbidden(isForbidden);
      setLoadError(isForbidden ? null : messageFor(e));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load().then((loaded) => {
      // Open the first editable role, else the Owner role, so the page is never blank.
      const first = loaded.find((r) => !r.isSystem) ?? loaded[0];
      if (first) {
        setSelectedId(first.id);
        setDraft(draftFor(first));
      }
    });
  }, [load]);

  // A short-lived "Saved" confirmation.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const selected = selectedId && selectedId !== NEW ? roles.find((r) => r.id === selectedId) ?? null : null;
  const isNew = selectedId === NEW;
  const isOwnerRole = selected?.isSystem ?? false;
  const readOnly = isOwnerRole || (isNew ? !canCreate : !canUpdate);

  const allKeys = useMemo(() => groups.flatMap((g) => g.permissions.map((p) => p.key)), [groups]);

  /** The Owner role stores no permissions: it simply has them all. */
  const shownPermissions = isOwnerRole ? allKeys : draft.permissions;

  const dirty = isNew
    ? Boolean(draft.name.trim() || draft.description.trim() || draft.permissions.length)
    : selected !== null &&
      !isOwnerRole &&
      (draft.name.trim() !== selected.name ||
        draft.description.trim() !== (selected.description ?? '') ||
        !sameSet(draft.permissions, selected.permissions));

  const confirmDiscard = (): boolean =>
    !dirty || window.confirm('You have unsaved changes to this role. Discard them?');

  const select = (role: Role): void => {
    if (role.id === selectedId) {
      setMobileEditor(true);
      return;
    }
    if (!confirmDiscard()) return;
    setSelectedId(role.id);
    setDraft(draftFor(role));
    setError(null);
    setMobileEditor(true);
  };

  const startNew = (): void => {
    if (!confirmDiscard()) return;
    setSelectedId(NEW);
    setDraft(draftFor(null));
    setError(null);
    setMobileEditor(true);
  };

  const discard = (): void => {
    setDraft(draftFor(selected));
    setError(null);
  };

  const setPermissions = (next: string[]): void => setDraft((d) => ({ ...d, permissions: next }));

  const togglePermission = (group: PermissionGroup, key: string): void => {
    const has = draft.permissions.includes(key);
    const readKey = readKeyOf(group);
    const moduleKeys = group.permissions.map((p) => p.key);
    if (has) {
      // Revoking read takes the whole module with it.
      setPermissions(
        key === readKey
          ? draft.permissions.filter((p) => !moduleKeys.includes(p))
          : draft.permissions.filter((p) => p !== key),
      );
    } else {
      const add = readKey && key !== readKey && !draft.permissions.includes(readKey) ? [key, readKey] : [key];
      setPermissions([...draft.permissions, ...add]);
    }
  };

  const toggleGroup = (group: PermissionGroup): void => {
    const moduleKeys = group.permissions.map((p) => p.key);
    const all = moduleKeys.every((k) => draft.permissions.includes(k));
    setPermissions(
      all
        ? draft.permissions.filter((p) => !moduleKeys.includes(p))
        : [...new Set([...draft.permissions, ...moduleKeys])],
    );
  };

  const handleSave = async (): Promise<void> => {
    const name = draft.name.trim();
    if (!name) {
      setError('Give the role a name.');
      return;
    }
    if (roles.some((r) => r.id !== draft.id && r.name.toLowerCase() === name.toLowerCase())) {
      setError(`A role named "${name}" already exists.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const description = draft.description.trim();
      const saved = isNew
        ? await createRole({ name, description: description || undefined, permissions: draft.permissions })
        : await updateRole(draft.id!, { name, description, permissions: draft.permissions });
      await load();
      setSelectedId(saved.id);
      setDraft(draftFor(saved));
      setNotice(isNew ? `Role "${saved.name}" created` : 'Changes saved');
      // Editing your own role changes what you may do right now.
      if (myRoles.some((r) => r.id === saved.id)) void refreshSession();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!selected) return;
    if (!window.confirm(`Delete the "${selected.name}" role? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteRole(selected.id);
      const loaded = await load();
      const next = loaded.find((r) => !r.isSystem) ?? loaded[0] ?? null;
      setSelectedId(next?.id ?? null);
      setDraft(draftFor(next));
      setNotice(`Role "${selected.name}" deleted`);
      setMobileEditor(false);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setDeleting(false);
    }
  };

  const busy = saving || deleting;
  const total = allKeys.length;
  const granted = shownPermissions.filter((p) => allKeys.includes(p)).length;

  if (forbidden) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <Header canCreate={false} onNew={startNew} />
        <div className="mt-4 bg-slate-900/80 border border-slate-800 rounded-xl p-10 text-center space-y-3">
          <ShieldCheck className="w-6 h-6 text-slate-600 mx-auto" />
          <p className="text-xs text-slate-400">
            Your role does not include viewing roles. Ask your organization owner if you need access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col text-slate-100">
      <div className="shrink-0 px-6 pt-6 pb-4 max-w-7xl w-full mx-auto space-y-4">
        <Header canCreate={canCreate && !loading} onNew={startNew} />
        {loadError && (
          <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
            <div className="text-xs text-rose-200 flex-1">{loadError}</div>
            <button onClick={() => void load()} className="text-xs font-semibold text-rose-200 hover:text-white cursor-pointer">
              Retry
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 px-6 pb-6 max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-4">
        {/* Role list */}
        <aside
          className={`${mobileEditor ? 'hidden lg:flex' : 'flex'} flex-col min-h-0 bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden`}
        >
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wider text-slate-500">Roles</span>
            <span className="text-2xs text-slate-500">{roles.length}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2 space-y-1">
            {loading
              ? Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="p-3 rounded-lg animate-pulse space-y-2">
                    <div className="h-3 w-28 rounded bg-slate-800" />
                    <div className="h-2.5 w-40 rounded bg-slate-800/70" />
                  </div>
                ))
              : roles.map((role) => (
                  <RoleListItem
                    key={role.id}
                    role={role}
                    total={total}
                    active={role.id === selectedId}
                    onClick={() => select(role)}
                  />
                ))}
            {isNew && (
              <div className="w-full flex items-center gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                <div className="w-8 h-8 rounded-lg bg-emerald-600/20 text-emerald-300 flex items-center justify-center shrink-0">
                  <Plus className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-emerald-200 truncate">{draft.name.trim() || 'New role'}</div>
                  <div className="text-2xs text-emerald-300/70">Not saved yet</div>
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* Editor */}
        <section
          className={`${mobileEditor ? 'flex' : 'hidden lg:flex'} flex-col min-h-0 bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden`}
        >
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-5 h-5 text-slate-500 animate-spin" />
            </div>
          ) : !selected && !isNew ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-10 text-center">
              <Shield className="w-7 h-7 text-slate-600" />
              <p className="text-xs text-slate-400 max-w-xs">
                Choose a role to see its permissions{canCreate ? ', or create a new one.' : '.'}
              </p>
            </div>
          ) : (
            <>
              {/* Identity */}
              <div className="shrink-0 p-5 border-b border-slate-800 bg-slate-950/40 space-y-4">
                <button
                  onClick={() => {
                    if (isNew && !confirmDiscard()) return;
                    setMobileEditor(false);
                  }}
                  className="lg:hidden inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  All roles
                </button>

                {isOwnerRole && (
                  <div className="bg-emerald-500/10 border border-emerald-500/25 rounded-lg p-3 flex items-start gap-2.5">
                    <Lock className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-emerald-100/90 leading-relaxed">
                      The <span className="font-semibold">Owner</span> role always has every permission, including
                      ones added in the future. It cannot be edited or deleted.
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
                  <div>
                    <label htmlFor="role-name" className="block text-xs font-semibold text-slate-300 mb-1">
                      Role name
                    </label>
                    <input
                      id="role-name"
                      className={field}
                      value={draft.name}
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      placeholder="e.g. Team Lead"
                      maxLength={100}
                      disabled={readOnly || busy}
                      autoFocus={isNew}
                    />
                  </div>
                  <div>
                    <label htmlFor="role-description" className="block text-xs font-semibold text-slate-300 mb-1">
                      Description <span className="font-normal text-slate-500">(optional)</span>
                    </label>
                    <input
                      id="role-description"
                      className={field}
                      value={draft.description}
                      onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                      placeholder="What is this role for?"
                      maxLength={500}
                      disabled={readOnly || busy}
                    />
                  </div>
                </div>

                {/* Coverage */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between text-2xs mb-1.5">
                      <span className="font-semibold text-slate-300 inline-flex items-center gap-1.5">
                        <KeyRound className="w-3 h-3 text-slate-500" />
                        {granted} of {total} permissions
                      </span>
                      {selected && (
                        <span className="text-slate-500 inline-flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {selected._count.users} {selected._count.users === 1 ? 'member' : 'members'}
                        </span>
                      )}
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-teal-400 transition-all duration-300"
                        style={{ width: total ? `${(granted / total) * 100}%` : '0%' }}
                      />
                    </div>
                  </div>
                  {!readOnly && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => setPermissions([...allKeys])}
                        disabled={busy || granted === total}
                        className="h-8 px-3 rounded-lg text-2xs font-semibold bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Select all
                      </button>
                      <button
                        onClick={() => setPermissions([])}
                        disabled={busy || granted === 0}
                        className="h-8 px-3 rounded-lg text-2xs font-semibold bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Clear
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Permission matrix */}
              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-5 space-y-3">
                {error && (
                  <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                    <div className="text-xs text-rose-200 leading-relaxed flex-1">{error}</div>
                    <button onClick={() => setError(null)} aria-label="Dismiss" className="text-rose-300 hover:text-rose-100 cursor-pointer">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                {groups.map((group) => (
                  <PermissionGroupCard
                    key={group.module}
                    group={group}
                    granted={shownPermissions}
                    disabled={readOnly || busy}
                    onToggle={(key) => togglePermission(group, key)}
                    onToggleAll={() => toggleGroup(group)}
                  />
                ))}
              </div>

              {/* Actions */}
              {!isOwnerRole && (
                <div className="shrink-0 px-5 py-3 border-t border-slate-800 bg-slate-950/60 flex items-center gap-2">
                  {selected && canDelete && (
                    <button
                      onClick={() => void handleDelete()}
                      disabled={busy || selected._count.users > 0}
                      title={
                        selected._count.users > 0
                          ? `Assigned to ${selected._count.users} member(s) — remove it from them first`
                          : 'Delete this role'
                      }
                      className="h-9 px-3 rounded-lg text-xs font-semibold text-rose-300 hover:bg-rose-600/15 flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      <span className="hidden sm:inline">Delete role</span>
                    </button>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {notice && !dirty && (
                      <span className="text-xs text-emerald-300 inline-flex items-center gap-1 animate-in fade-in">
                        <Check className="w-3.5 h-3.5" />
                        {notice}
                      </span>
                    )}
                    {dirty && !isNew && <span className="hidden sm:inline text-2xs text-amber-300">Unsaved changes</span>}
                    {!readOnly && (
                      <>
                        {!isNew && (
                          <button
                            onClick={discard}
                            disabled={busy || !dirty}
                            className="h-9 px-3 rounded-lg text-xs font-semibold bg-slate-800 text-slate-200 hover:bg-slate-700 flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Discard
                          </button>
                        )}
                        <button
                          onClick={() => void handleSave()}
                          disabled={busy || !dirty || !draft.name.trim()}
                          className="h-9 px-4 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-on-accent flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          {isNew ? 'Create role' : 'Save changes'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
};

const Header: React.FC<{ canCreate: boolean; onNew: () => void }> = ({ canCreate, onNew }) => (
  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
    <div>
      <h2 className="text-xl font-bold text-white tracking-tight">Roles & Permissions</h2>
      <p className="text-xs text-slate-400">Create roles and decide exactly what each one can see and do.</p>
    </div>
    {canCreate && (
      <button
        onClick={onNew}
        className="h-9 px-4 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
      >
        <Plus className="w-4 h-4" />
        New Role
      </button>
    )}
  </div>
);

const RoleListItem: React.FC<{ role: Role; total: number; active: boolean; onClick: () => void }> = ({
  role,
  total,
  active,
  onClick,
}) => (
  <button
    onClick={onClick}
    aria-current={active ? 'true' : undefined}
    className={`w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors cursor-pointer border ${
      active ? 'bg-emerald-500/10 border-emerald-500/30' : 'border-transparent hover:bg-slate-800/60'
    }`}
  >
    <div
      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
        role.isSystem ? 'bg-emerald-600/20 text-emerald-300' : 'bg-slate-800 text-slate-400'
      }`}
    >
      {role.isSystem ? <ShieldCheck className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
    </div>
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1.5">
        <span className={`text-sm font-semibold truncate ${active ? 'text-emerald-200' : 'text-slate-100'}`}>
          {role.name}
        </span>
        {role.isSystem && <Lock className="w-3 h-3 text-slate-500 shrink-0" />}
      </div>
      <div className="text-2xs text-slate-500 truncate">
        {role.isSystem ? 'Full access' : `${role.permissions.length} of ${total} permissions`} ·{' '}
        {role._count.users} {role._count.users === 1 ? 'member' : 'members'}
      </div>
    </div>
    <ChevronRight className={`w-4 h-4 shrink-0 ${active ? 'text-emerald-400' : 'text-slate-600'}`} />
  </button>
);

const PermissionGroupCard: React.FC<{
  group: PermissionGroup;
  granted: string[];
  disabled: boolean;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
}> = ({ group, granted, disabled, onToggle, onToggleAll }) => {
  const count = group.permissions.filter((p) => granted.includes(p.key)).length;
  const all = count === group.permissions.length;
  const some = count > 0 && !all;
  const readKey = readKeyOf(group);

  return (
    <div className="border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-slate-950/50 border-b border-slate-800">
        <button
          role="checkbox"
          aria-checked={some ? 'mixed' : all}
          aria-label={`All ${group.label} permissions`}
          onClick={onToggleAll}
          disabled={disabled}
          className={`w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center transition-colors shrink-0 ${
            all || some ? 'bg-emerald-600 border-emerald-500 text-on-accent' : 'border-slate-600 bg-slate-900'
          } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-emerald-500'}`}
        >
          {all ? <Check className="w-3 h-3" strokeWidth={3} /> : some ? <Minus className="w-3 h-3" strokeWidth={3} /> : null}
        </button>
        <span className="text-sm font-semibold text-slate-100 flex-1">{group.label}</span>
        <span
          className={`text-2xs font-semibold px-2 py-0.5 rounded-full ${
            count ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-500'
          }`}
        >
          {count}/{group.permissions.length}
        </span>
      </div>
      <div className="divide-y divide-slate-800/70">
        {group.permissions.map((permission) => {
          const on = granted.includes(permission.key);
          const needsRead = readKey && permission.key !== readKey;
          return (
            <label
              key={permission.key}
              className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${
                disabled ? 'cursor-default' : 'cursor-pointer hover:bg-slate-800/30'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-medium ${on ? 'text-slate-100' : 'text-slate-400'}`}>{permission.label}</div>
                <div className="text-2xs text-slate-600 font-mono truncate">
                  {permission.key}
                  {needsRead && <span className="font-sans"> · includes view</span>}
                </div>
              </div>
              <Switch checked={on} disabled={disabled} onChange={() => onToggle(permission.key)} label={permission.label} />
            </label>
          );
        })}
      </div>
    </div>
  );
};

const Switch: React.FC<{ checked: boolean; disabled: boolean; onChange: () => void; label: string }> = ({
  checked,
  disabled,
  onChange,
  label,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={onChange}
    disabled={disabled}
    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
      checked ? 'bg-emerald-600' : 'bg-slate-700'
    } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
  >
    <span
      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
        checked ? 'translate-x-4' : ''
      }`}
    />
  </button>
);
