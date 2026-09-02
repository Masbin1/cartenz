import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A folder the portal can offer for an on-premise project.
 *
 * `path` is the absolute path the project stores and the workspace manager later
 * operates on. `isGitRepository` is reported rather than enforced, because the
 * workspace layer is the authority - this only lets the form steer people towards
 * a directory that will actually work.
 */
export interface OnPremiseFolder {
  readonly name: string;
  readonly path: string;
  readonly isGitRepository: boolean;
}

/**
 * Lists the immediate subdirectories of the configured on-premise root (ADR-028).
 *
 * A missing or unreadable root yields an empty list rather than an error: the
 * endpoint is read at project-creation time, and the workspace layer refuses a
 * bad directory with a precise message at task time anyway.
 */
export async function listOnPremiseFolders(root: string): Promise<OnPremiseFolder[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const folders: OnPremiseFolder[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const isGitRepository = await stat(join(path, '.git')).then(
      () => true,
      () => false,
    );
    folders.push({ name: entry.name, path, isGitRepository });
  }

  return folders.sort((a, b) => a.name.localeCompare(b.name));
}
