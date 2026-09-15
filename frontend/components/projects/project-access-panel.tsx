'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import type { ProjectAccessMember } from '@/lib/types';

/**
 * Who may open this project (ADR-043).
 *
 * Every member of the organisation is listed, not only the granted ones: the
 * question is "who can open this", and an admin missing from the list while
 * being able to open it would read as a bug rather than as the rank rule.
 *
 * Members who are in by rank or by having created the project get a label and no
 * toggle, because clearing a toggle that cannot revoke anything is a promise the
 * panel cannot keep.
 */

const SOURCE_LABEL: Record<ProjectAccessMember['source'], string> = {
  role: 'By role',
  creator: 'Created it',
  grant: 'Granted',
  none: 'No access',
};

export function ProjectAccessPanel({ projectId }: { projectId: string }) {
  const [members, setMembers] = useState<ProjectAccessMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMembers(await api.access.members(projectId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Access could not be loaded.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (member: ProjectAccessMember) => {
    setBusyUserId(member.userId);
    setError(null);
    try {
      if (member.source === 'grant') {
        await api.access.revoke(projectId, member.userId);
      } else {
        await api.access.grant(projectId, member.userId);
      }
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The change could not be saved.');
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <section className="panel mt-5">
      <div className="panel-header">
        <h2 className="panel-title">Project access</h2>
        <span className="text-2xs text-content-subtle">
          {members?.filter((member) => member.hasAccess).length ?? 0} with access
        </span>
      </div>

      <div className="space-y-4 px-4 py-4">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <p className="text-xs text-content-muted">
          Owners and admins reach every project. Everyone else needs to be given access here.
        </p>

        {members === null ? (
          <div className="flex items-center gap-2 text-2xs text-content-subtle">
            <Spinner /> Loading access
          </div>
        ) : (
          <ul className="divide-y divide-surface-border rounded border border-surface-border">
            {members.map((member) => {
              const rowBusy = busyUserId === member.userId;
              const toggleable = member.revocable || member.source === 'none';

              return (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{member.name || member.email}</p>
                    <p className="truncate text-2xs text-content-subtle">
                      {member.email} · {member.role}
                    </p>
                  </div>

                  <span className="rounded border border-surface-border px-2 py-0.5 text-2xs uppercase tracking-wide text-content-subtle">
                    {SOURCE_LABEL[member.source]}
                  </span>

                  {toggleable ? (
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => void toggle(member)}
                      className="text-2xs text-content-subtle underline hover:text-content disabled:opacity-40"
                    >
                      {rowBusy ? <Spinner /> : member.source === 'grant' ? 'Revoke' : 'Grant'}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
