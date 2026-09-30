import { join } from 'node:path';

/**
 * Where a connected project's one long-lived clone lives (ADR-063).
 *
 * Shared by the service that creates and syncs it and the workspace layer that
 * hands tasks a worktree out of it, so the two can never disagree about the
 * path: a task looking for a clone that was written somewhere else is a silent
 * fall back to a full re-clone, which is the exact cost this exists to remove.
 *
 * Layout: `<root>/<project id>/repo` is the clone; `<root>/<project id>/.cartenz`
 * beside it holds this platform's own bookkeeping (per-branch sync times), kept
 * outside the working tree so the clone never reports it as an untracked file.
 *
 * The project id rather than a name: ids are stable and are already safe as a
 * path segment, while a display name can change and a technical name exists
 * only on provisioned projects.
 */
export function checkoutPathFor(checkoutRoot: string, projectId: string): string {
  return join(checkoutRoot, projectId, 'repo');
}
