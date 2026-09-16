'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { Alert } from '@/components/ui/alert';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { USER_REGIONS, USER_REGION_LABELS, type UserRegion, type UserRow } from '@/lib/types';

const MINIMUM_PASSWORD_LENGTH = 12;

/** The account being edited in the modal. */
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

  return (
    <AppShell>
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Users</h1>
          <p className="mt-1 text-xs text-content-muted">
            Everyone with an account. A region decides which projects a person sees; an administrator
            sees every region.
          </p>
        </div>

        {canEdit ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
            className="btn-secondary"
          >
            + Add user
          </button>
        ) : null}
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">All accounts</h2>
          <span className="text-2xs text-content-subtle">{users?.length ?? 0}</span>
        </div>

        <div className="space-y-3 px-4 py-4">
          {users === null ? (
            <div className="flex items-center gap-2 text-2xs text-content-subtle">
              <Spinner /> Loading users
            </div>
          ) : users.length === 0 ? (
            <p className="text-2xs text-content-subtle">No users yet.</p>
          ) : (
            <ul className="divide-y divide-surface-border rounded border border-surface-border">
              {users.map((row) => {
                const isSelf = row.id === user.id;

                return (
                  <li key={row.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-xs font-medium">
                        <span className="truncate">{row.name || row.email}</span>
                        {isSelf ? (
                          <span className="rounded border border-surface-border px-1.5 py-0.5 text-2xs uppercase tracking-wide text-content-subtle">
                            you
                          </span>
                        ) : null}
                        {!row.isActive ? (
                          <span className="rounded border border-state-failure/30 bg-state-failure/10 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-state-failure">
                            inactive
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-2xs text-content-subtle">{row.email}</p>
                    </div>

                    <span className="rounded border border-surface-border px-2 py-0.5 text-2xs text-content-subtle">
                      {USER_REGION_LABELS[row.region]}
                    </span>

                    {row.isAdmin ? (
                      <span className="rounded border border-surface-border px-2 py-0.5 text-2xs uppercase tracking-wide text-content-subtle">
                        Admin
                      </span>
                    ) : null}

                    {canEdit ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setEditing({
                              id: row.id,
                              email: row.email,
                              name: row.name,
                              region: row.region,
                              isAdmin: row.isAdmin,
                              isActive: row.isActive,
                            })
                          }
                          className="btn-secondary px-2.5 py-1 text-xs"
                        >
                          Edit
                        </button>
                        {!isSelf ? (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setResetPassword('');
                                setResetting({
                                  id: row.id,
                                  email: row.email,
                                  name: row.name,
                                  region: row.region,
                                  isAdmin: row.isAdmin,
                                  isActive: row.isActive,
                                });
                              }}
                              className="text-2xs text-content-subtle underline hover:text-content"
                            >
                              Reset password
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setDeleting({
                                  id: row.id,
                                  email: row.email,
                                  name: row.name,
                                  region: row.region,
                                  isAdmin: row.isAdmin,
                                  isActive: row.isActive,
                                })
                              }
                              className="text-2xs text-content-subtle underline hover:text-state-failure"
                            >
                              Delete
                            </button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {!canEdit ? (
            <p className="text-2xs text-content-subtle">Only an administrator can change these.</p>
          ) : null}
        </div>
      </section>

      {/* Edit modal */}
      {editing ? (
        <Modal onDismiss={() => setEditing(null)} disabled={saving}>
          <div className="mb-4">
            <p className="text-sm font-medium">{editing.name || editing.email}</p>
            <p className="truncate text-2xs text-content-subtle">{editing.email}</p>
          </div>

          <div className="space-y-4">
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

            <label className="flex items-center gap-2 text-xs text-content-muted">
              <input
                type="checkbox"
                checked={editing.isAdmin}
                onChange={(event) => setEditing({ ...editing, isAdmin: event.target.checked })}
                disabled={saving}
                className="mt-px"
              />
              Administrator (sees every region)
            </label>

            <label className="flex items-center gap-2 text-xs text-content-muted">
              <input
                type="checkbox"
                checked={editing.isActive}
                onChange={(event) => setEditing({ ...editing, isActive: event.target.checked })}
                disabled={saving}
                className="mt-px"
              />
              Active (can sign in)
            </label>
          </div>

          <ModalActions onCancel={() => setEditing(null)} onSave={() => void saveEdit()} saving={saving} />
        </Modal>
      ) : null}

      {/* Create modal */}
      {adding ? (
        <Modal onDismiss={() => setAdding(false)} disabled={saving}>
          <p className="mb-4 text-sm font-medium">Add account</p>

          <div className="space-y-4">
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
              <p className="mt-1.5 text-2xs text-content-subtle">
                At least {MINIMUM_PASSWORD_LENGTH} characters. Share it with the new owner.
              </p>
            </div>

            <label className="flex items-center gap-2 text-xs text-content-muted">
              <input
                type="checkbox"
                checked={createForm.isAdmin}
                onChange={(event) =>
                  setCreateForm({ ...createForm, isAdmin: event.target.checked })
                }
                disabled={saving}
                className="mt-px"
              />
              Administrator
            </label>
          </div>

          <ModalActions onCancel={() => setAdding(false)} onSave={() => void saveCreate()} saving={saving} />
        </Modal>
      ) : null}

      {/* Reset password */}
      {resetting ? (
        <Modal
          onDismiss={() => {
            setResetting(null);
            setResetPassword('');
          }}
          disabled={saving}
        >
          <p className="text-sm font-medium">Reset password</p>
          <p className="mt-1 truncate text-2xs text-content-subtle">
            {resetting.name || resetting.email} · {resetting.email}
          </p>

          <div className="mt-4">
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
              className="field-input font-mono text-xs"
            />
            <p className="mt-1.5 text-2xs text-content-subtle">
              Shown as plain text on purpose: you have to read it back to hand it over. There is no
              email being sent, so this window is the only place it appears.
            </p>
          </div>

          <div className="mt-4 rounded-md border border-surface-border bg-surface-raised px-3 py-2">
            <p className="text-2xs text-content-muted">
              Every session belonging to this account is signed out. Tell them to change it once
              they are back in.
            </p>
          </div>

          <div className="mt-6 flex items-center justify-end gap-2">
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
        <Modal onDismiss={() => setDeleting(null)} disabled={saving}>
          <p className="text-sm font-medium">Delete {deleting.name || deleting.email}?</p>
          <p className="mt-2 text-xs text-content-muted">
            This removes the account and their project grants and access requests. Their projects
            stay, marked as having no creator. This cannot be undone.
          </p>

          <div className="mt-6 flex items-center justify-end gap-2">
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
              {saving ? 'Deleting' : 'Delete'}
            </button>
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}

/** Backdrop + card shared by the three dialogs. */
function Modal({
  children,
  onDismiss,
  disabled,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  disabled: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={() => !disabled && onDismiss()}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-surface-border bg-surface p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ModalActions({
  onCancel,
  onSave,
  saving,
}: {
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="mt-6 flex items-center justify-end gap-2">
      <button type="button" onClick={onCancel} disabled={saving} className="btn-ghost">
        Cancel
      </button>
      <button type="button" onClick={onSave} disabled={saving} className="btn-primary">
        {saving ? <Spinner /> : null}
        {saving ? 'Saving' : 'Save'}
      </button>
    </div>
  );
}
