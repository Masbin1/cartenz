/**
 * Guards on repository writes (ADR-022).
 *
 * Written after the first run against a real customer repository, where
 * `update_file` replaced a 1101-line module with a 68-line stub: the whole-file
 * contract means any caller that does not reproduce the file exactly deletes the
 * rest of it. The workspace was thrown away and pushing was refused, so nothing
 * reached the repository — but the platform had already produced a change that
 * would have destroyed a day's work if a person had approved it in a hurry.
 *
 * The guard here bounds that failure. `edit_file` removes it. Both exist because
 * the guard protects against callers that have not been changed yet, including
 * any future model, and a bound is worth having even once the better tool is
 * available.
 */

/**
 * Below this a file is small enough that a rewrite is a plausible intention
 * rather than a mistake: a new `__init__.py`, a short manifest, a stub view.
 */
const SMALL_FILE_LINES = 40;

/**
 * Above this proportion removed, a whole-file replacement is treated as an
 * accident. Half is deliberately generous - a legitimate change that halves a
 * large file is rare, and the caller is told exactly what to use instead rather
 * than merely refused.
 */
const MAX_REMOVED_FRACTION = 0.5;

export class DestructiveRewriteError extends Error {
  constructor(
    readonly path: string,
    readonly previousLines: number,
    readonly nextLines: number,
  ) {
    const removed = previousLines - nextLines;
    super(
      `Refused to replace ${path}: the new contents are ${nextLines} lines against ` +
        `${previousLines}, which would delete ${removed} lines. update_file replaces the ` +
        'whole file, so anything not reproduced is lost. Use edit_file to change one ' +
        'region: pass the exact existing text as `find` and its replacement as `replace`. ' +
        'If the file really should be rewritten, delete_file then create_file makes that ' +
        'explicit and requires an approval.',
    );
    this.name = 'DestructiveRewriteError';
  }
}

/**
 * Refuses a whole-file replacement that deletes most of a substantial file.
 *
 * Counts lines rather than bytes: a reformatting pass can change byte count
 * greatly while keeping every line, and losing a thousand lines is the failure
 * this is about.
 */
export function assertNotDestructiveRewrite(
  path: string,
  previous: string,
  next: string,
): void {
  const previousLines = previous.split('\n').length;
  const nextLines = next.split('\n').length;

  if (previousLines <= SMALL_FILE_LINES) return;
  if (nextLines >= previousLines) return;

  const removedFraction = (previousLines - nextLines) / previousLines;
  if (removedFraction < MAX_REMOVED_FRACTION) return;

  throw new DestructiveRewriteError(path, previousLines, nextLines);
}

export class EmptyEditTargetError extends Error {
  constructor(readonly path: string) {
    super(
      `No text to find was given for ${path}. edit_file replaces an exact existing ` +
        'region, so the text being replaced must be supplied. To add a new file use ' +
        'create_file instead.',
    );
    this.name = 'EmptyEditTargetError';
  }
}

export class EditNotApplicableError extends Error {
  constructor(
    readonly path: string,
    readonly reason: 'absent' | 'ambiguous',
    readonly occurrences: number,
  ) {
    super(
      reason === 'absent'
        ? `The text to find does not appear in ${path}. Read the file again and pass an ` +
          'exact excerpt, including its indentation. Nothing was changed.'
        : `The text to find appears ${occurrences} times in ${path}, so which one to ` +
          'change is ambiguous. Extend `find` with surrounding lines until it is unique. ' +
          'Nothing was changed.',
    );
    this.name = 'EditNotApplicableError';
  }
}

export interface AppliedEdit {
  readonly content: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

/**
 * Replaces one exact occurrence of `find` with `replace`.
 *
 * Requires exactly one match. Zero is a caller error and many is ambiguous, and
 * in both cases refusing is right: an edit applied to the wrong one of three
 * similar blocks is harder to notice than an edit that did not happen.
 */
export function applyEdit(
  path: string,
  content: string,
  find: string,
  replace: string,
): AppliedEdit {
  // Guarded before the search: an empty needle matches everywhere and advances
  // the scan by nothing, so the count below would not terminate.
  if (find.length === 0) throw new EmptyEditTargetError(path);

  const first = content.indexOf(find);
  if (first === -1) throw new EditNotApplicableError(path, 'absent', 0);

  // Counted with indexOf rather than split, so an overlapping find is counted the
  // way it would be replaced.
  let occurrences = 0;
  for (let at = first; at !== -1; at = content.indexOf(find, at + find.length)) {
    occurrences += 1;
    if (occurrences > 1) throw new EditNotApplicableError(path, 'ambiguous', occurrences);
  }

  const next = content.slice(0, first) + replace + content.slice(first + find.length);

  return {
    content: next,
    linesAdded: replace.split('\n').length,
    linesRemoved: find.split('\n').length,
  };
}
