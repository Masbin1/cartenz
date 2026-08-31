import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { toPosixPath } from '../../core/path-utils';

/**
 * Bounded directory traversal, shared by the analysis and search tools.
 *
 * Implemented rather than delegated to a library or to `find`, for two reasons.
 * A shelled-out `find` would be a second process-spawning path, and ADR-019 keeps
 * that to one chokepoint. And traversal of a hostile tree needs specific
 * behaviour that a general utility does not give: symbolic links are never
 * followed, so a link to `/` cannot make the walk unbounded; the visited-inode set
 * stops a directory hard-link cycle; and the file and depth caps stop a
 * pathological tree from becoming a denial of service.
 */

/** Directories never worth walking, and expensive to walk. */
export const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'dist',
  'build',
  '.next',
  '.idea',
  '.vscode',
  '.tox',
  'coverage',
  'htmlcov',
]);

/** Extensions the platform treats as source it may read. */
export const SOURCE_EXTENSIONS = new Set([
  '.py',
  '.xml',
  '.csv',
  '.js',
  '.ts',
  '.scss',
  '.css',
  '.md',
  '.rst',
  '.txt',
  '.yml',
  '.yaml',
  '.json',
  '.cfg',
  '.conf',
  '.toml',
  '.po',
  '.pot',
  '.sql',
  '.html',
]);

export interface WalkedFile {
  /** Path relative to the walk root, using forward slashes. */
  readonly path: string;
  readonly absolutePath: string;
  readonly bytes: number;
  readonly extension: string;
}

export interface WalkOptions {
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  readonly maxFileBytes?: number;
  /** When set, only these extensions are returned. */
  readonly extensions?: ReadonlySet<string>;
}

export interface WalkResult {
  readonly files: readonly WalkedFile[];
  /** True when a cap stopped the walk before the tree was exhausted. */
  readonly truncated: boolean;
  readonly directoriesVisited: number;
  readonly symlinksSkipped: number;
}

const DEFAULT_MAX_FILES = 20000;
const DEFAULT_MAX_DEPTH = 20;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Extension of a path, lower-cased, including the dot. Empty when there is none. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Walks a directory tree, returning the files that pass the filters.
 *
 * Symbolic links are skipped rather than followed. That is the important
 * property: a link is the mechanism by which a repository could otherwise make
 * the walk leave the workspace or run forever.
 */
export async function walkRepository(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const files: WalkedFile[] = [];
  // Guards against a cycle formed by hard-linked directories, which a symlink
  // check alone would not catch.
  const visitedDirectories = new Set<string>();
  let truncated = false;
  let directoriesVisited = 0;
  let symlinksSkipped = 0;

  const walk = async (current: string, depth: number): Promise<void> => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      truncated = true;
      return;
    }

    const info = await stat(current).catch(() => null);
    if (!info) return;

    const inode = `${info.dev}:${info.ino}`;
    if (visitedDirectories.has(inode)) return;
    visitedDirectories.add(inode);
    directoriesVisited += 1;

    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }

      if (entry.isSymbolicLink()) {
        symlinksSkipped += 1;
        continue;
      }

      const absolutePath = join(current, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(absolutePath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = extensionOf(entry.name);
      if (options.extensions && !options.extensions.has(extension)) continue;

      const fileInfo = await stat(absolutePath).catch(() => null);
      if (!fileInfo) continue;
      if (fileInfo.size > maxFileBytes) continue;

      files.push({
        path: toPosixPath(relative(root, absolutePath)),
        absolutePath,
        bytes: fileInfo.size,
        extension,
      });
    }
  };

  await walk(root, 0);

  return { files, truncated, directoriesVisited, symlinksSkipped };
}
