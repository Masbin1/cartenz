'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import type { ProjectAccessMember } from '@/lib/types';

/**
 * Who may open this project (ADR-043, ADR-044).
 *
 * The whole user directory is listed, not only the people with a grant: the
 * question is "who can open this", and an administrator missing from the list
 * while being able to open it would read as a bug rather than as the flag rule.
 *
 * Anyone in by the admin flag or by having created the project gets a label and
 * no toggle, because clearing a toggle that cannot revoke anything is a promise
 * the panel cannot keep.
 *
 * Renders only the list: the page that hosts it supplies the heading and the
 * explanation, so it sits in the same layout as the page's other settings.
 */

const SOURCE_LABEL: Record<ProjectAccessMember['source'], string> = {
  admin: 'Administrator',
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

  const withAccess = members?.filter((member) => member.hasAccess).length ?? 0;

  return (
    <div className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="panel overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-surface-border px-5 py-3.5 sm:px-6">
          <p className="text-callout font-medium text-content">People</p>
          {members === null ? (
            <Skeleton className="h-3.5 w-20" />
          ) : (
            <p className="text-meta text-content-subtle">{withAccess} with access</p>
          )}
        </div>

        {members === null ? (
          <SkeletonRows rows={3} className="px-1 py-1 sm:px-2" />
        ) : (
          <ul className="divide-y divide-surface-border/70">
            {members.map((member) => {
              const rowBusy = busyUserId === member.userId;
              const toggleable = member.revocable || member.source === 'none';

              return (
                <li
                  key={member.userId}
                  className="flex items-center gap-4 px-5 py-3.5 sm:px-6"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-callout font-medium text-content">
                      {member.name || member.email}
                    </p>
                    <p className="mt-0.5 truncate text-meta text-content-subtle">
                      <span className="hidden sm:inline">{member.email} · </span>
                      {member.isAdmin ? 'Admin' : 'Member'}
                      <span className="sm:hidden"> · {SOURCE_LABEL[member.source]}</span>
                    </p>
                  </div>

                  <span
                    className={`hidden shrink-0 text-meta sm:inline ${
                      member.hasAccess ? 'text-content-muted' : 'text-content-subtle'
                    }`}
                  >
                    {SOURCE_LABEL[member.source]}
                  </span>

                  {toggleable ? (
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => void toggle(member)}
                      className={`btn-sm w-[4.5rem] shrink-0 ${
                        member.source === 'grant' ? 'btn-ghost' : 'btn-secondary'
                      }`}
                    >
                      {rowBusy ? (
                        <Spinner className="h-3.5 w-3.5" />
                      ) : member.source === 'grant' ? (
                        'Revoke'
                      ) : (
                        'Grant'
                      )}
                    </button>
                  ) : (
                    // Keeps the column aligned where a row has no toggle to offer.
                    <span className="hidden w-[4.5rem] shrink-0 sm:block" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
