import { readFile } from 'node:fs/promises';
import { SOURCE_EXTENSIONS, walkRepository } from './repository-walker';

/**
 * Literal, case-insensitive code search over a cloned repository.
 *
 * Deliberately not a regular-expression search. A pattern supplied by a model or
 * a user and compiled into a JavaScript regular expression is a denial-of-service
 * vector: `(a+)+$` against a long line backtracks catastrophically and blocks the
 * event loop, which in a single-threaded worker takes down every concurrent task.
 * A literal substring search cannot do that, and it answers the question the agent
 * actually asks - "where is this model, field or string mentioned".
 *
 * Everything is bounded: files walked, files read, matches returned, and the
 * length of a returned line. A search must not be a way to extract a repository
 * one call at a time.
 */

export interface CodeSearchMatch {
  readonly path: string;
  readonly line: number;
  /** The matching line, trimmed and length-capped. */
  readonly preview: string;
}

export interface CodeSearchResult {
  readonly query: string;
  readonly matches: readonly CodeSearchMatch[];
  readonly filesSearched: number;
  /** True when a cap stopped the search before the tree was exhausted. */
  readonly truncated: boolean;
}

export interface CodeSearchOptions {
  readonly maxResults?: number;
  readonly maxFileBytes?: number;
  /** Restricts the search to these extensions. Defaults to source files. */
  readonly extensions?: ReadonlySet<string>;
}

const MAX_PREVIEW_LENGTH = 200;
const MAX_MATCHES_PER_FILE = 5;

export async function searchCode(
  root: string,
  query: string,
  options: CodeSearchOptions = {},
): Promise<CodeSearchResult> {
  const maxResults = options.maxResults ?? 60;
  const needle = query.trim().toLowerCase();

  if (needle.length < 2) {
    return { query, matches: [], filesSearched: 0, truncated: false };
  }

  const walked = await walkRepository(root, {
    extensions: options.extensions ?? SOURCE_EXTENSIONS,
    maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
  });

  const matches: CodeSearchMatch[] = [];
  let filesSearched = 0;
  let truncated = walked.truncated;

  for (const file of walked.files) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }

    const contents = await readFile(file.absolutePath, 'utf8').catch(() => null);
    if (contents === null) continue;
    filesSearched += 1;

    // A cheap whole-file test first: most files do not match, and splitting a
    // large file into lines is the expensive part.
    if (!contents.toLowerCase().includes(needle)) continue;

    const lines = contents.split('\n');
    let perFile = 0;

    for (let index = 0; index < lines.length; index += 1) {
      if (perFile >= MAX_MATCHES_PER_FILE) break;
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      if (!lines[index].toLowerCase().includes(needle)) continue;

      matches.push({
        path: file.path,
        line: index + 1,
        preview: previewOf(lines[index]),
      });
      perFile += 1;
    }
  }

  return { query, matches, filesSearched, truncated };
}

/**
 * A single-line, length-capped preview.
 *
 * Control characters are stripped: a preview is rendered in a browser and written
 * to an audit record, and a carriage return or an escape sequence in source could
 * corrupt either.
 */
function previewOf(line: string): string {
  let cleaned = '';
  for (let index = 0; index < line.length && cleaned.length < MAX_PREVIEW_LENGTH; index += 1) {
    const code = line.charCodeAt(index);
    cleaned += code < 0x20 || code === 0x7f ? ' ' : line[index];
  }
  return cleaned.trim();
}
