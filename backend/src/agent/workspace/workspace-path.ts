import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  pathSegments,
  stripLeadingSeparators,
  traversesUpwards,
} from '../../core/path-utils';

/**
 * Path containment for every filesystem operation a tool performs (ADR-019).
 *
 * The naive check - reject a path containing `..` - is not sufficient, and the
 * reason is worth stating because it is the whole point of this module. A
 * repository the platform clones can contain a symbolic link:
 *
 *     ln -s /etc/passwd config/settings.conf
 *
 * The path `config/settings.conf` contains no `..` and looks entirely ordinary,
 * but reading it reads a host file. Worse, a link to `/home/user/.ssh/id_rsa` or
 * to another task's workspace would be equally invisible to a string check.
 *
 * So containment is decided against the *resolved* path. `realpath` follows every
 * link in the chain, and the result must still be inside the workspace root -
 * which is itself resolved once, so a link in the root's own path does not
 * produce a false refusal.
 *
 * Two functions, because reads and writes need different handling: a file being
 * created does not exist yet, so its own path cannot be resolved, and the parent
 * directory is what must be checked.
 */

export class PathEscapeError extends Error {
  constructor(requested: string, reason: string) {
    super(`Refused the path "${requested}": ${reason}`);
    this.name = 'PathEscapeError';
  }
}

/** True when `candidate` is the root itself or lies beneath it. */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Rejects a requested path on its face, before the filesystem is touched.
 *
 * These checks do not replace the resolved check below; they refuse input that is
 * clearly hostile with a message that says so, rather than producing a confusing
 * failure further in.
 */
function assertPlausibleRelativePath(requested: string): void {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new PathEscapeError(String(requested), 'it is empty');
  }
  if (requested.length > 1024) {
    throw new PathEscapeError(requested, 'it is longer than 1024 characters');
  }
  if (requested.includes('\0')) {
    throw new PathEscapeError(requested, 'it contains a NUL byte');
  }
  if (isAbsolute(requested)) {
    throw new PathEscapeError(requested, 'it is absolute; paths are relative to the workspace');
  }
  // Windows-style absolute paths, which isAbsolute does not catch on POSIX.
  if (/^[A-Za-z]:/.test(requested)) {
    throw new PathEscapeError(requested, 'it is a drive-qualified absolute path');
  }
  if (traversesUpwards(requested)) {
    throw new PathEscapeError(requested, 'it traverses upwards');
  }
  // The platform never has a reason to read or write inside .git through a file
  // tool: git operations go through the git service, which is auditable.
  if (pathSegments(requested)[0] === '.git') {
    throw new PathEscapeError(requested, 'the .git directory is not reachable through a file tool');
  }
}

/**
 * Resolves a path for reading, refusing anything that resolves outside the root.
 *
 * The file must exist. A symbolic link is followed and the target is what is
 * checked, so a link out of the workspace is refused however innocuous its own
 * path looks.
 */
export async function resolveExistingPath(root: string, requested: string): Promise<string> {
  assertPlausibleRelativePath(requested);

  const realRoot = await realpath(resolve(root));
  const joined = join(realRoot, requested);

  let resolved: string;
  try {
    resolved = await realpath(joined);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new PathEscapeError(requested, 'it does not exist');
    }
    if (code === 'ELOOP') {
      throw new PathEscapeError(requested, 'it is a circular symbolic link');
    }
    throw error;
  }

  if (!isInside(realRoot, resolved)) {
    // The target is named in the log but not returned to the caller: where a
    // link points is information about the host.
    throw new PathEscapeError(
      requested,
      'it resolves outside the workspace, which means it is a link out of the repository',
    );
  }

  return resolved;
}

/**
 * Resolves a path for writing, whether or not it already exists.
 *
 * The parent directory is resolved instead, because a file being created has no
 * path of its own to resolve. If the file does exist, it is additionally checked
 * as an existing path, so an attempt to write *through* an existing symlink out
 * of the workspace is refused rather than following the link.
 */
export async function resolveWritablePath(root: string, requested: string): Promise<string> {
  assertPlausibleRelativePath(requested);

  const realRoot = await realpath(resolve(root));
  const joined = join(realRoot, requested);

  // Walk up to the nearest existing ancestor and resolve that. Directories that
  // do not exist yet will be created beneath a verified parent.
  let ancestor = joined;
  let realAncestor: string | null = null;
  while (realAncestor === null) {
    const parent = resolve(ancestor, '..');
    if (parent === ancestor) break;
    try {
      realAncestor = await realpath(parent);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      ancestor = parent;
    }
  }

  if (realAncestor === null || !isInside(realRoot, realAncestor)) {
    throw new PathEscapeError(requested, 'its parent directory resolves outside the workspace');
  }

  // If the target itself exists, it must also resolve inside: writing through an
  // existing link would otherwise escape even though the parent is contained.
  try {
    const existing = await realpath(joined);
    if (!isInside(realRoot, existing)) {
      throw new PathEscapeError(
        requested,
        'it is an existing link whose target is outside the workspace',
      );
    }
    return existing;
  } catch (error) {
    if (error instanceof PathEscapeError) throw error;
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }

  return joined;
}

/**
 * The workspace-relative form of an absolute path, for display and for the audit
 * record. Absolute paths disclose the platform's filesystem layout and are never
 * returned to a caller.
 */
export async function toWorkspaceRelative(root: string, absolute: string): Promise<string> {
  const realRoot = await realpath(resolve(root));
  if (!isInside(realRoot, absolute)) return absolute;
  return stripLeadingSeparators(absolute.slice(realRoot.length));
}
