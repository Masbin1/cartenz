/**
 * Path string helpers.
 *
 * These exist because a path separator on Windows is a backslash, which is also
 * the escape character in both string and regular-expression literals. Writing
 * `split(/[/\]/)` scattered through the codebase is correct but easy to get
 * subtly wrong, and a wrong escape produces a regular expression that silently
 * matches the wrong thing rather than failing to compile.
 *
 * So the separator is named once, and the operations that need it are functions.
 */

/** A single backslash, named rather than escaped. */
export const BACKSLASH = String.fromCharCode(92);

/**
 * Splits a path on either separator.
 *
 * String separators rather than a regular expression, so there is no escaping to
 * get wrong.
 */
export function pathSegments(value: string): string[] {
  return value.split('/').flatMap((part) => part.split(BACKSLASH));
}

/** Rewrites a path to forward slashes, for display and for stable comparison. */
export function toPosixPath(value: string): string {
  return value.split(BACKSLASH).join('/');
}

/** Removes any leading path separators. */
export function stripLeadingSeparators(value: string): string {
  let index = 0;
  while (index < value.length && (value[index] === '/' || value[index] === BACKSLASH)) {
    index += 1;
  }
  return value.slice(index);
}

/** True when a segment of the path is exactly `..`. */
export function traversesUpwards(value: string): boolean {
  return pathSegments(value).includes('..');
}
