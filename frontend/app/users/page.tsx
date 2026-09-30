'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { KeyRound, Pencil, Trash2, UserPlus, Users as UsersIcon } from 'lucide-react';
import { AppShell } from '@/components/ui/app-shell';
import { PageHeader } from '@/components/ui/page';
import { Alert } from '@/components/ui/alert';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/action-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { StatusDot } from '@/components/ui/status-dot';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { USER_REGIONS, USER_REGION_LABELS, type UserRegion, type UserRow } from '@/lib/types';

const MINIMUM_PASSWORD_LENGTH = 12;

/** The account being edited, reset or deleted. */
interface EditingUser {
  id: string;
  email: string;
  name: string;
  region: UserRegion;
  isAdmin: boolean;
  isActive: boolean;
}

/** The create form: an email and password only make sense when adding. */
interface CreateForm {
  name: string;
  email: string;
  region: UserRegion;
  isAdmin: boolean;
  password: string;
}

function emptyCreate(): CreateForm {
  return { name: '', email: '', region: 'indonesia', isAdmin: false, password: '' };
}

export default function UsersPage() {
  const { loading, user } = useRequireAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingUser | null>(null);
  const [adding, setAdding] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreate());
  const [deleting, setDeleting] = useState<EditingUser | null>(null);
  const [resetting, setResetting] = useState<EditingUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers(await api.users.list());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The users could not be loaded.');
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.users.update(editing.id, {
        name: editing.name,
        region: editing.region,
        isAdmin: editing.isAdmin,
        isActive: editing.isActive,
      });
      setNotice(`${editing.name || editing.email} was updated.`);
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The user could not be updated.');
    } finally {
      setSaving(false);
    }
  };

  const saveCreate = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.users.create({
        name: createForm.name,
        email: createForm.email,
        region: createForm.region,
        isAdmin: createForm.isAdmin,
        password: createForm.password,
      });
      setNotice(`${createForm.name || createForm.email} was created.`);
      setAdding(false);
      setCreateForm(emptyCreate());
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The account could not be created.');
    } finally {
      setSaving(false);
    }
  };

  const confirmReset = async () => {
    if (!resetting) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.users.resetPassword(resetting.id, resetPassword);
      setNotice(
        `Password for ${resetting.name || resetting.email} was reset. Their sessions were signed out — hand the new password over directly.`,
      );
      setResetting(null);
      setResetPassword('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The password could not be reset.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.users.remove(deleting.id);
      setNotice(`${deleting.name || deleting.email} was deleted.`);
      setDeleting(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The user could not be deleted.');
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !user) return <PageLoading label="Loading users" />;

  const canEdit = user.isAdmin;

  /** The row's editable snapshot, shared by the edit, reset and delete flows. */
  const snapshot = (row: UserRow): EditingUser => ({
    id: row.id,
    email: row.email,
    name: row.name,
    region: row.region,
    isAdmin: row.isAdmin,
    isActive: row.isActive,
  });

  /**
   * One menu per row. An administrator cannot reset or delete their own
   * account from here, so for their own row the menu holds only Edit.
   */
  const rowActions = (row: UserRow): ActionMenuItem[] => {
    const isSelf = row.id === user.id;
    const items: ActionMenuItem[] = [
      { label: 'Edit', icon: Pencil, onSelect: () => setEditing(snapshot(row)) },
    ];
    if (!isSelf) {
      items.push(
        {
          label: 'Reset password',
          icon: KeyRound,
          onSelect: () => {
            setResetPassword('');
            setResetting(snapshot(row));
          },
        },
        {
          label: 'Delete',
          icon: Trash2,
          tone: 'danger',
          separated: true,
          onSelect: () => setDeleting(snapshot(row)),
        },
      );
    }
    return items;
  };

  const openCreate = () => {
    setError(null);
    setAdding(true);
  };

  return (
    <AppShell>
      <div className="page">
        <PageHeader
          title="Users"
          description="Everyone with an account. A region decides which projects a person sees; administrators see every region."
          meta={
            users !== null ? (
              <span className="meta">
                {users.length === 1 ? '1 account' : `${users.length} accounts`}
                {!canEdit ? ' · Only an administrator can change these' : ''}
              </span>
            ) : null
          }
          actions={
            canEdit ? (
              <button type="button" onClick={openCreate} className="btn-primary">
                <UserPlus className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
                Add user
              </button>
            ) : null
          }
        />

        <div className="space-y-12">
          {error || notice ? (
            <div className="space-y-3">
              {error ? <Alert tone="error">{error}</Alert> : null}
              {notice ? <Alert tone="success">{notice}</Alert> : null}
            </div>
          ) : null}

          {/* Create form: an inline panel above the list, so the list stays in view. */}
          {adding ? (
            <FormPanel
              title="Add user"
              description="Set a temporary password and share it with the new owner directly."
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <label htmlFor="new-name" className="field-label">
                    Name
                  </label>
                  <input
                    id="new-name"
                    value={createForm.name}
                    onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })}
                    disabled={saving}
                    className="field-input"
                  />
                </div>

                <div>
                  <label htmlFor="new-email" className="field-label">
                    Email address
                  </label>
                  <input
                    id="new-email"
                    type="email"
                    value={createForm.email}
                    onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })}
                    disabled={saving}
                    className="field-input"
                  />
                </div>

                <div>
                  <label htmlFor="new-region" className="field-label">
                    Region
                  </label>
                  <select
                    id="new-region"
                    value={createForm.region}
                    onChange={(event) =>
                      setCreateForm({ ...createForm, region: event.target.value as UserRegion })
                    }
                    disabled={saving}
                    className="field-input"
                  >
                    {USER_REGIONS.map((region) => (
                      <option key={region} value={region}>
                        {USER_REGION_LABELS[region]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="new-password" className="field-label">
                    Temporary password
                  </label>
                  <input
                    id="new-password"
                    type="password"
                    value={createForm.password}
                    onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })}
                    disabled={saving}
                    className="field-input"
                  />
                  <p className="field-hint">
                    At least {MINIMUM_PASSWORD_LENGTH} characters. Share it with the new owner.
                  </p>
                </div>
              </div>

              <Checkbox
                checked={createForm.isAdmin}
                onChange={(checked) => setCreateForm({ ...createForm, isAdmin: checked })}
                disabled={saving}
                label="Administrator"
                hint="Sees every region."
              />

              <FormActions
                onCancel={() => setAdding(false)}
                onSave={() => void saveCreate()}
                saving={saving}
                saveLabel="Create user"
              />
            </FormPanel>
          ) : null}

          {/* Edit form: the same calm panel, naming the account being changed. */}
          {editing ? (
            <FormPanel title={`Edit ${editing.name || editing.email}`} description={editing.email}>
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <label htmlFor="user-name" className="field-label">
                    Name
                  </label>
                  <input
                    id="user-name"
                    value={editing.name}
                    onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                    disabled={saving}
                    className="field-input"
                  />
                </div>

                <div>
                  <label htmlFor="user-region" className="field-label">
                    Region
                  </label>
                  <select
                    id="user-region"
                    value={editing.region}
                    onChange={(event) =>
                      setEditing({ ...editing, region: event.target.value as UserRegion })
                    }
                    disabled={saving}
                    className="field-input"
                  >
                    {USER_REGIONS.map((region) => (
                      <option key={region} value={region}>
                        {USER_REGION_LABELS[region]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-3">
                <Checkbox
                  checked={editing.isAdmin}
                  onChange={(checked) => setEditing({ ...editing, isAdmin: checked })}
                  disabled={saving}
                  label="Administrator"
                  hint="Sees every region."
                />
                <Checkbox
                  checked={editing.isActive}
                  onChange={(checked) => setEditing({ ...editing, isActive: checked })}
                  disabled={saving}
                  label="Active"
                  hint="Can sign in."
                />
              </div>

              <FormActions
                onCancel={() => setEditing(null)}
                onSave={() => void saveEdit()}
                saving={saving}
                saveLabel="Save changes"
              />
            </FormPanel>
          ) : null}

          <section aria-label="All accounts">
            {users === null ? (
              error ? null : <SkeletonRows rows={5} className="-mx-4" />
            ) : users.length === 0 ? (
              <EmptyState
                icon={UsersIcon}
                title="No users yet"
                description="Add the people who will work on projects in this deployment."
                action={
                  canEdit ? (
                    <button type="button" onClick={openCreate} className="btn-primary">
                      Add user
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <>
                {/* Desktop: a readable table. */}
                <table className="data-table hidden md:table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Region</th>
                      <th scope="col">Role</th>
                      <th scope="col">Status</th>
                      {canEdit ? (
                        <th scope="col" className="w-12">
                          <span className="sr-only">Actions</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((row) => (
                      <tr key={row.id} className="transition-colors hover:bg-surface-overlay/50">
                        <td className="max-w-0 w-1/2">
                          <UserIdentity row={row} isSelf={row.id === user.id} />
                        </td>
                        <td className="text-content-muted">{USER_REGION_LABELS[row.region]}</td>
                        <td className="text-content-muted">{row.isAdmin ? 'Administrator' : 'Member'}</td>
                        <td>
                          <UserStatus active={row.isActive} />
                        </td>
                        {canEdit ? (
                          <td className="text-right">
                            <ActionMenu items={rowActions(row)} label={`Actions for ${row.name || row.email}`} />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Mobile: stacked rows, the facts on one quiet line. */}
                <ul className="-mx-4 space-y-1 md:hidden">
                  {users.map((row) => (
                    <li key={row.id} className="list-row items-start">
                      <div className="min-w-0 flex-1">
                        <UserIdentity row={row} isSelf={row.id === user.id} />
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <UserStatus active={row.isActive} />
                          <span className="meta">
                            {USER_REGION_LABELS[row.region]} · {row.isAdmin ? 'Administrator' : 'Member'}
                          </span>
                        </div>
                      </div>
                      {canEdit ? (
                        <ActionMenu items={rowActions(row)} label={`Actions for ${row.name || row.email}`} />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      </div>

      {/* Reset password */}
      {resetting ? (
        <Modal
          title="Reset password"
          onDismiss={() => {
            setResetting(null);
            setResetPassword('');
          }}
          disabled={saving}
        >
          <p className="mt-1 truncate text-meta text-content-subtle">
            {resetting.name || resetting.email} · {resetting.email}
          </p>

          <div className="mt-6">
            <label htmlFor="reset-password" className="field-label">
              New password
            </label>
            <input
              id="reset-password"
              type="text"
              value={resetPassword}
              onChange={(event) => setResetPassword(event.target.value)}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              placeholder="At least 12 characters"
              className="field-input font-mono"
            />
            <p className="field-hint">
              Shown in plain text on purpose, so you can read it back. No email is sent: this window
              is the only place it appears.
            </p>
          </div>

          <div className="mt-5">
            <Alert tone="warning">
              Every session for this account is signed out. Ask them to change the password once
              they are back in.
            </Alert>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => {
                setResetting(null);
                setResetPassword('');
              }}
              disabled={saving}
              className="btn-ghost"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmReset()}
              disabled={saving || resetPassword.length < MINIMUM_PASSWORD_LENGTH}
              className="btn-primary"
            >
              {saving ? <Spinner /> : null}
              {saving ? 'Resetting' : 'Reset password'}
            </button>
          </div>
        </Modal>
      ) : null}

      {/* Delete confirmation */}
      {deleting ? (
        <Modal
          title={`Delete ${deleting.name || deleting.email}?`}
          onDismiss={() => setDeleting(null)}
          disabled={saving}
        >
          <p className="mt-2 text-callout text-content-muted">
            This removes the account, its project grants and its access requests. Their projects
            stay, marked as having no creator. This cannot be undone.
          </p>

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setDeleting(null)}
              disabled={saving}
              className="btn-ghost"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={saving}
              className="btn-danger"
            >
              {saving ? <Spinner /> : null}
              {saving ? 'Deleting' : 'Delete user'}
            </button>
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}

/** Name over email; the email recedes, and "You" marks the signed-in account. */
function UserIdentity({ row, isSelf }: { row: UserRow; isSelf: boolean }) {
  return (
    <div className="min-w-0">
      <p className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-body font-medium text-content">{row.name || row.email}</span>
        {isSelf ? <span className="shrink-0 text-meta text-content-subtle">You</span> : null}
      </p>
      <p className="truncate text-meta text-content-subtle">{row.email}</p>
    </div>
  );
}

/** Whether the account can sign in. Inactive is inert rather than an error. */
function UserStatus({ active }: { active: boolean }) {
  return (
    <StatusDot tone={active ? 'success' : 'idle'} size="small">
      {active ? 'Active' : 'Inactive'}
    </StatusDot>
  );
}

/** A contained form above the list: a headline, one line of context, then fields. */
function FormPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel animate-rise-in">
      <div className="panel-header flex-col items-start gap-1">
        <h2 className="text-headline text-content">{title}</h2>
        {description ? <p className="truncate text-callout text-content-muted">{description}</p> : null}
      </div>
      <div className="panel-body space-y-6 pt-3">{children}</div>
    </section>
  );
}

/** A checkbox with its label and a quiet line saying what it means. */
function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="mt-1 h-4 w-4 shrink-0"
      />
      <span>
        <span className="block text-callout font-medium text-content">{label}</span>
        {hint ? <span className="block text-meta text-content-subtle">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Backdrop and card shared by the two confirmation dialogs. */
function Modal({
  title,
  children,
  onDismiss,
  disabled,
}: {
  title: string;
  children: React.ReactNode;
  onDismiss: () => void;
  disabled: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-black/30 px-4 pb-4 backdrop-blur-[2px] sm:items-center sm:pb-0"
      onClick={() => !disabled && onDismiss()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md animate-rise-in rounded-card border border-surface-border bg-surface-raised p-6 shadow-float"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-headline text-content">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** One primary action at the end of a form; cancel stays quiet. */
function FormActions({
  onCancel,
  onSave,
  saving,
  saveLabel,
}: {
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  saveLabel: string;
}) {
  return (
    <div className="flex flex-col-reverse gap-2 border-t border-surface-border pt-5 sm:flex-row sm:items-center">
      <button type="button" onClick={onCancel} disabled={saving} className="btn-ghost">
        Cancel
      </button>
      <button type="button" onClick={onSave} disabled={saving} className="btn-primary sm:order-first">
        {saving ? <Spinner /> : null}
        {saving ? 'Saving' : saveLabel}
      </button>
    </div>
  );
}
