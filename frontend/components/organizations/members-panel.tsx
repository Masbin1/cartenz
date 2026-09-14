'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import type { OrganizationMember, OrganizationRole } from '@/lib/types';

/**
 * Manage the people in an organisation (ADR-015 membership model).
 *
 * The backend already owns every rule this surface must respect: only an
 * owner/admin may change membership, an admin may not grant a role above their
 * own, and the last owner cannot be demoted or removed. So this panel does not
 * re-implement those checks — it renders the server's refusal and keeps the
 * obvious foot-guns (removing yourself, granting above your rank) out of reach
 * in the UI, then lets the server be the authority.
 */

const ASSIGNABLE_ROLES: OrganizationRole[] = ['owner', 'admin', 'developer', 'viewer'];

const ROLE_RANK: Record<OrganizationRole, number> = {
  owner: 4,
  admin: 3,
  developer: 2,
  viewer: 1,
};

const ROLE_HINT: Record<OrganizationRole, string> = {
  owner: 'Full control, including billing and ownership transfer.',
  admin: 'Manage members, providers and Odoo settings.',
  developer: 'Create projects and run development tasks.',
  viewer: 'Read-only access to projects and tasks.',
};

export function MembersPanel({
  organizationId,
  currentUserId,
  viewerRole,
}: {
  organizationId: string;
  currentUserId: string;
  viewerRole: OrganizationRole;
}) {
  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrganizationRole>('developer');
  const [inviting, setInviting] = useState(false);

  // Only an owner or admin may change membership; anyone else sees the list
  // read-only, matching what the server would allow.
  const canManage = viewerRole === 'owner' || viewerRole === 'admin';
  const viewerRank = ROLE_RANK[viewerRole];

  const load = useCallback(async () => {
    setError(null);
    try {
      setMembers(await api.organizations.members(organizationId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The members could not be loaded.');
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Roles this viewer is allowed to hand out: never above their own rank.
  const grantableRoles = ASSIGNABLE_ROLES.filter((role) => ROLE_RANK[role] <= viewerRank);
  const ownerCount = members?.filter((member) => member.role === 'owner').length ?? 0;

  const invite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email) {
      setError('Enter the email address of an existing account.');
      return;
    }
    setInviting(true);
    setError(null);
    setNotice(null);
    try {
      await api.organizations.addMember(organizationId, { email, role: inviteRole });
      setInviteEmail('');
      setInviteRole('developer');
      setNotice(`${email} was added as ${inviteRole}.`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The person could not be added.');
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (member: OrganizationMember, role: OrganizationRole) => {
    if (role === member.role) return;
    setBusyUserId(member.userId);
    setError(null);
    setNotice(null);
    try {
      await api.organizations.updateMemberRole(organizationId, member.userId, role);
      setNotice(`${member.name || member.email} is now ${role}.`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The role could not be changed.');
      await load();
    } finally {
      setBusyUserId(null);
    }
  };

  const remove = async (member: OrganizationMember) => {
    const label = member.name || member.email;
    if (!window.confirm(`Remove ${label} from this organisation?`)) return;
    setBusyUserId(member.userId);
    setError(null);
    setNotice(null);
    try {
      await api.organizations.removeMember(organizationId, member.userId);
      setNotice(`${label} was removed.`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The person could not be removed.');
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <section className="panel mt-5">
      <div className="panel-header">
        <h2 className="panel-title">Members</h2>
        <span className="text-2xs text-content-subtle">{members?.length ?? 0}</span>
      </div>

      <div className="space-y-4 px-4 py-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}

        <p className="text-xs text-content-muted">
          People who can sign in to this organisation. A role decides what each person may do.
          {canManage
            ? ' You may not grant a role above your own, and the last owner cannot be removed.'
            : ' Only an owner or admin can change membership.'}
        </p>

        {members === null ? (
          <div className="flex items-center gap-2 text-2xs text-content-subtle">
            <Spinner /> Loading members
          </div>
        ) : members.length === 0 ? (
          <p className="text-2xs text-content-subtle">No members yet.</p>
        ) : (
          <ul className="divide-y divide-surface-border rounded border border-surface-border">
            {members.map((member) => {
              const isSelf = member.userId === currentUserId;
              const isLastOwner = member.role === 'owner' && ownerCount <= 1;
              // The server is the authority; the UI only disables what it can
              // already know will be refused, to avoid a pointless round-trip.
              const mayEditThisMember =
                canManage && ROLE_RANK[member.role] <= viewerRank && !(isSelf && isLastOwner);
              const rowBusy = busyUserId === member.userId;

              return (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-xs font-medium">
                      <span className="truncate">{member.name || member.email}</span>
                      {isSelf ? (
                        <span className="rounded border border-surface-border px-1.5 py-0.5 text-2xs uppercase tracking-wide text-content-subtle">
                          you
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-2xs text-content-subtle">{member.email}</p>
                  </div>

                  {mayEditThisMember ? (
                    <select
                      value={member.role}
                      onChange={(event) =>
                        void changeRole(member, event.target.value as OrganizationRole)
                      }
                      disabled={rowBusy}
                      aria-label={`Role for ${member.email}`}
                      className="input w-auto py-1 text-xs"
                    >
                      {grantableRoles.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="rounded border border-surface-border px-2 py-0.5 text-2xs uppercase tracking-wide text-content-subtle">
                      {member.role}
                    </span>
                  )}

                  {mayEditThisMember && !isSelf ? (
                    <button
                      type="button"
                      onClick={() => void remove(member)}
                      disabled={rowBusy}
                      className="text-2xs text-content-subtle hover:text-state-failure disabled:opacity-40"
                    >
                      {rowBusy ? <Spinner /> : 'Remove'}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {canManage ? (
          <div className="space-y-2 border-t border-surface-border pt-4">
            <p className="text-2xs font-medium text-content-subtle">Add a member</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor="invite-email" className="text-2xs text-content-muted">
                  Email of an existing account
                </label>
                <input
                  id="invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="person@company.com"
                  className="input w-full text-xs"
                  disabled={inviting}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="invite-role" className="text-2xs text-content-muted">
                  Role
                </label>
                <select
                  id="invite-role"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value as OrganizationRole)}
                  disabled={inviting}
                  className="input w-auto py-1.5 text-xs"
                >
                  {grantableRoles.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => void invite()}
                disabled={inviting}
                className="btn-primary"
              >
                {inviting ? <Spinner /> : null}
                {inviting ? 'Adding' : 'Add member'}
              </button>
            </div>
            <p className="text-2xs text-content-muted">
              {ROLE_HINT[inviteRole]} The person must already have a LinkedERP account.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
