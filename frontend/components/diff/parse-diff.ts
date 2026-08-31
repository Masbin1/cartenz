/**
 * Minimal unified-diff parser for display.
 *
 * Written rather than taken as a dependency because the requirement is narrow: the
 * platform's own `git diff --unified=3` output needs splitting into files, hunks
 * and typed lines so it can be rendered. A general diff library would bring
 * parsing of formats the platform never produces.
 *
 * It is a display parser, not a semantic one. It never reconstructs file content
 * and never applies anything, so a diff it misreads produces an odd-looking panel
 * rather than a wrong change.
 */

export type DiffLineKind = 'added' | 'removed' | 'context' | 'meta';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** Line number in the original file, where the line exists there. */
  readonly oldLine: number | null;
  /** Line number in the new file, where the line exists there. */
  readonly newLine: number | null;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  /** Path as shown to the reader: the new path for a rename. */
  readonly path: string;
  readonly oldPath: string | null;
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(.*)$/;

/**
 * git's "no newline at end of file" marker, which begins with a backslash.
 * Named rather than written inline: a lone backslash in a string literal is an
 * escape character, and getting it wrong is easy and invisible.
 */
const NO_NEWLINE_MARKER = String.fromCharCode(92);

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];

  let current: {
    path: string;
    oldPath: string | null;
    change: DiffFile['change'];
    binary: boolean;
    hunks: DiffHunk[];
    linesAdded: number;
    linesRemoved: number;
  } | null = null;

  let hunk: { header: string; lines: DiffLine[] } | null = null;
  let oldLine = 0;
  let newLine = 0;

  const closeHunk = () => {
    if (current && hunk) current.hunks.push({ header: hunk.header, lines: hunk.lines });
    hunk = null;
  };

  const closeFile = () => {
    closeHunk();
    if (current) files.push({ ...current });
    current = null;
  };

  for (const raw of patch.split('\n')) {
    const fileHeader = FILE_HEADER.exec(raw);
    if (fileHeader) {
      closeFile();
      current = {
        path: fileHeader[2],
        oldPath: fileHeader[1] === fileHeader[2] ? null : fileHeader[1],
        change: 'modified',
        binary: false,
        hunks: [],
        linesAdded: 0,
        linesRemoved: 0,
      };
      continue;
    }

    if (!current) continue;

    // Mode and index lines carry the change kind.
    if (raw.startsWith('new file mode')) {
      current.change = 'added';
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
      current.change = 'deleted';
      continue;
    }
    if (raw.startsWith('rename from') || raw.startsWith('rename to')) {
      current.change = 'renamed';
      continue;
    }
    if (raw.startsWith('Binary files')) {
      current.binary = true;
      continue;
    }
    if (raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      continue;
    }

    const hunkHeader = HUNK_HEADER.exec(raw);
    if (hunkHeader) {
      closeHunk();
      oldLine = Number.parseInt(hunkHeader[1], 10);
      newLine = Number.parseInt(hunkHeader[3], 10);
      hunk = { header: raw, lines: [] };
      continue;
    }

    if (!hunk) continue;

    if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'added', text: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
      current.linesAdded += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'removed', text: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
      current.linesRemoved += 1;
      continue;
    }
    if (raw.startsWith(NO_NEWLINE_MARKER)) {
      // "No newline at end of file" - shown as metadata, counted as neither.
      hunk.lines.push({ kind: 'meta', text: raw.slice(1).trim(), oldLine: null, newLine: null });
      continue;
    }

    hunk.lines.push({ kind: 'context', text: raw.slice(1), oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }

  closeFile();
  return files;
}
