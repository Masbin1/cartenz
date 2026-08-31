import { Inject, Injectable } from '@nestjs/common';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { traversesUpwards } from '../../../core/path-utils';
import { APP_CONFIG } from '../../../core/config/config.module';
import type { AppConfig } from '../../../core/config/configuration';
import { searchCode } from '../../analysis/code-search';
import { REDACTIONS } from '../../../core/ai-boundary/boundary-types';
import {
  CREATE_FILE_SCHEMA,
  DELETE_FILE_SCHEMA,
  EDIT_FILE_SCHEMA,
  LIST_DIRECTORY_SCHEMA,
  READ_FILE_SCHEMA,
  SEARCH_CODE_SCHEMA,
  UPDATE_FILE_SCHEMA,
} from '../tool-schemas';
import {
  resolveExistingPath,
  resolveWritablePath,
} from '../../workspace/workspace-path';
import {
  applyEdit,
  assertNotDestructiveRewrite,
} from './write-safety';
import type { AnyToolDefinition, ToolDefinition, ToolExecutionContext } from '../tool.interface';

/**
 * Real repository tools (ADR-019).
 *
 * These read and write the task's own clone. Every path passes through
 * resolveExistingPath or resolveWritablePath, which resolve symbolic links and
 * refuse anything landing outside the workspace; no tool here joins a path itself.
 *
 * Read sizes and result counts are bounded by configuration, so a single tool
 * call cannot return a repository's worth of text to a model or a browser.
 *
 * A validate() function refuses a request before any filesystem access, so a
 * malformed or hostile path is rejected with no side effect and one audit record.
 */

interface PathInput {
  readonly path: string;
}

interface WriteInput extends PathInput {
  readonly content: string;
  readonly summary: string;
}

interface EditInput extends PathInput {
  readonly find: string;
  readonly replace: string;
  readonly summary: string;
}

/** Shape checks only. Containment is decided at execution, against the real path. */
function requireRelativePath(input: unknown, field = 'path'): string | null {
  if (typeof input !== 'object' || input === null) return 'input must be an object';
  const value = (input as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `${field} is required and must be a non-empty string`;
  }
  if (value.length > 1024) return `${field} is longer than 1024 characters`;
  if (value.includes('\0')) return `${field} contains a NUL byte`;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return `${field} must be relative to the repository root`;
  }
  if (traversesUpwards(value)) {
    return `${field} must not traverse outside the repository`;
  }
  return null;
}

/**
 * A string of the right type and length. An empty one passes, which is correct
 * for a field where emptiness is meaningful - edit_file's replacement text, where
 * empty means "remove the text that was found".
 */
function requireStringOfLength(input: unknown, field: string, maxLength: number): string | null {
  if (typeof input !== 'object' || input === null) return 'input must be an object';
  const value = (input as Record<string, unknown>)[field];
  if (typeof value !== 'string') return `${field} is required and must be a string`;
  if (value.length > maxLength) return `${field} is longer than ${maxLength} characters`;
  return null;
}

/** As requireStringOfLength, and refuses an empty value. */
function requireNonEmptyString(input: unknown, field: string, maxLength: number): string | null {
  const shape = requireStringOfLength(input, field, maxLength);
  if (shape) return shape;

  const value = (input as Record<string, unknown>)[field] as string;
  return value.length === 0 ? `${field} must not be empty` : null;
}

/**
 * Refuses content that carries the AI data boundary's own redaction markers.
 *
 * This closes a hazard that only exists once a model is in the loop, and it is
 * worth stating plainly because it inverts the boundary's purpose if missed.
 *
 * The boundary redacts credentials out of a file before the model sees it. The
 * write tools replace a file entirely. So a model that reads a file containing a
 * credential, and writes it back, writes back the redaction - silently deleting
 * the customer's real credential and replacing it with a placeholder. The control
 * meant to protect the customer would be destroying their code.
 *
 * Refusing is the honest outcome: the task fails visibly, and the message says
 * why. The alternative - restoring the original secret before writing - would mean
 * carrying unredacted material back through the write path, which is worse.
 *
 * The proper fix is targeted edits rather than whole-file rewrites, so that a
 * region a model never saw is a region it cannot overwrite. That is a change to
 * the tool contract and is recorded as the next step in ADR-020.
 */
function assertNotRedacted(content: string, path: string): void {
  for (const marker of Object.values(REDACTIONS)) {
    if (content.includes(marker)) {
      throw new Error(
        `Refused to write ${path}: the content contains "${marker}". This file holds a ` +
          'credential or personal data that the AI data boundary removed before the agent read it, ' +
          'so writing the version it produced back would delete the original. Edit this file ' +
          'by hand, or remove the credential from the repository.',
      );
    }
  }
}

/** Refuses a file tool when the task has no clone to work in. */
function assertRepository(context: ToolExecutionContext): void {
  if (context.workspace.simulated) {
    throw new Error(
      'This project has no repository connected, so there is no working copy to read or modify.',
    );
  }
}

@Injectable()
export class RealRepositoryTools {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get definitions(): readonly AnyToolDefinition[] {
    return [
      this.listDirectory,
      this.searchCode,
      this.readFile,
      this.createFile,
      this.editFile,
      this.updateFile,
      this.deleteFile,
    ];
  }

  private readonly listDirectory: ToolDefinition<PathInput> = {
    name: 'list_directory',
    description: 'List the contents of a directory in the project repository',
    permission: 'repository_read',
    leavesPlatform: false,
    simulated: false,
    parameters: LIST_DIRECTORY_SCHEMA,
    availableToModel: true,
    validate: (input) => requireRelativePath(input),
    execute: async (input, context) => {
      assertRepository(context);
      const target = await resolveExistingPath(context.workspace.repositoryPath, input.path);
      const entries = await readdir(target, { withFileTypes: true });

      return {
        path: input.path,
        entries: entries
          .filter((entry) => entry.name !== '.git')
          .slice(0, 500)
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
          }))
          .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
        truncated: entries.length > 500,
      };
    },
  };

  private readonly searchCode: ToolDefinition<{ query: string }> = {
    name: 'search_code',
    description:
      'Search the repository for a literal string: a model name, a field name or a class name',
    permission: 'repository_read',
    leavesPlatform: false,
    simulated: false,
    parameters: SEARCH_CODE_SCHEMA,
    availableToModel: true,
    validate: (input) => {
      const invalid = requireNonEmptyString(input, 'query', 200);
      if (invalid) return invalid;
      const query = (input as { query: string }).query.trim();
      // A one-character search matches most of a repository and returns noise.
      if (query.length < 2) return 'query must be at least 2 characters';
      return null;
    },
    execute: async (input, context) => {
      assertRepository(context);
      const result = await searchCode(context.workspace.repositoryPath, input.query, {
        maxResults: this.config.limits.searchMaxResults,
        maxFileBytes: this.config.limits.searchMaxFileBytes,
      });

      return {
        query: result.query,
        matchCount: result.matches.length,
        filesSearched: result.filesSearched,
        truncated: result.truncated,
        matches: result.matches,
      };
    },
  };

  private readonly readFile: ToolDefinition<PathInput> = {
    name: 'read_file',
    description: 'Read a file from the project repository',
    permission: 'repository_read',
    leavesPlatform: false,
    simulated: false,
    parameters: READ_FILE_SCHEMA,
    availableToModel: true,
    validate: (input) => requireRelativePath(input),
    execute: async (input, context) => {
      assertRepository(context);
      const target = await resolveExistingPath(context.workspace.repositoryPath, input.path);

      const info = await stat(target);
      if (info.isDirectory()) {
        throw new Error(`${input.path} is a directory. Use list_directory instead.`);
      }

      const maxBytes = this.config.limits.readFileMaxBytes;
      const buffer = await readFile(target);
      const truncated = buffer.byteLength > maxBytes;
      const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;

      // A file containing a NUL byte in its first kilobyte is binary; returning
      // its bytes as text would produce nonsense in the timeline and the audit
      // record.
      if (slice.subarray(0, 1024).includes(0)) {
        return {
          path: input.path,
          binary: true,
          bytes: info.size,
          content: null,
        };
      }

      const content = slice.toString('utf8');
      return {
        path: input.path,
        binary: false,
        bytes: info.size,
        lineCount: content.split('\n').length,
        truncated,
        content,
      };
    },
  };

  private readonly createFile: ToolDefinition<WriteInput> = {
    name: 'create_file',
    description: 'Create a new file in the project repository',
    permission: 'repository_write',
    leavesPlatform: false,
    simulated: false,
    parameters: CREATE_FILE_SCHEMA,
    availableToModel: true,
    validate: (input) =>
      requireRelativePath(input) ??
      requireNonEmptyString(input, 'content', 1024 * 1024) ??
      requireNonEmptyString(input, 'summary', 500),
    execute: async (input, context) => {
      assertRepository(context);
      assertNotRedacted(input.content, input.path);
      const target = await resolveWritablePath(context.workspace.repositoryPath, input.path);

      // Refused rather than overwritten: create_file that silently replaced an
      // existing file would lose work with no diff to show it.
      const exists = await stat(target).then(
        () => true,
        () => false,
      );
      if (exists) {
        throw new Error(`${input.path} already exists. Use update_file to change it.`);
      }

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, input.content, 'utf8');

      return {
        path: input.path,
        change: 'added',
        summary: input.summary,
        bytes: Buffer.byteLength(input.content, 'utf8'),
        linesAdded: input.content.split('\n').length,
        linesRemoved: 0,
      };
    },
  };

  private readonly updateFile: ToolDefinition<WriteInput> = {
    name: 'update_file',
    description:
      'Replace the entire contents of an existing file. Read it first: this is not a patch',
    permission: 'repository_write',
    leavesPlatform: false,
    simulated: false,
    parameters: UPDATE_FILE_SCHEMA,
    availableToModel: true,
    validate: (input) =>
      requireRelativePath(input) ??
      requireNonEmptyString(input, 'content', 1024 * 1024) ??
      requireNonEmptyString(input, 'summary', 500),
    execute: async (input, context) => {
      assertRepository(context);
      assertNotRedacted(input.content, input.path);
      // resolveExistingPath, not resolveWritablePath: update_file must fail on a
      // file that is not there rather than create one, so a mistaken path is
      // reported instead of producing a stray file.
      const target = await resolveExistingPath(context.workspace.repositoryPath, input.path);

      const previous = await readFile(target, 'utf8');

      // A caller that does not reproduce the file exactly deletes the rest of it,
      // which is what happened on the first run against a real repository
      // (ADR-022). Refused before the write, so nothing is lost.
      assertNotDestructiveRewrite(input.path, previous, input.content);

      await writeFile(target, input.content, 'utf8');

      const previousLines = previous.split('\n').length;
      const nextLines = input.content.split('\n').length;

      return {
        path: input.path,
        change: 'modified',
        summary: input.summary,
        bytes: Buffer.byteLength(input.content, 'utf8'),
        // Indicative only. The authoritative counts come from git diff --numstat,
        // which is what the review and the task record use.
        linesAdded: Math.max(0, nextLines - previousLines),
        linesRemoved: Math.max(0, previousLines - nextLines),
      };
    },
  };

  /**
   * A targeted edit (ADR-022): the preferred way to change an existing file.
   *
   * It cannot delete what it does not name, so the whole class of accidental
   * truncation is out of reach. It requires the found text to appear exactly
   * once, because an edit applied to the wrong one of three similar blocks is
   * harder to notice than an edit that did not happen.
   */
  private readonly editFile: ToolDefinition<EditInput> = {
    name: 'edit_file',
    description:
      'Replace one exact region of an existing file, leaving the rest untouched. ' +
      'Prefer this over update_file for any change to a file that already exists',
    permission: 'repository_write',
    leavesPlatform: false,
    simulated: false,
    parameters: EDIT_FILE_SCHEMA,
    availableToModel: true,
    validate: (input) =>
      requireRelativePath(input) ??
      requireNonEmptyString(input, 'find', 1024 * 1024) ??
      // replace may be empty: removing the found text is a legitimate edit, and
      // it cannot remove anything the caller has not quoted.
      requireStringOfLength(input, 'replace', 1024 * 1024) ??
      requireNonEmptyString(input, 'summary', 500),
    execute: async (input, context) => {
      assertRepository(context);
      assertNotRedacted(input.replace, input.path);
      const target = await resolveExistingPath(context.workspace.repositoryPath, input.path);

      const previous = await readFile(target, 'utf8');
      const result = applyEdit(input.path, previous, input.find, input.replace);
      await writeFile(target, result.content, 'utf8');

      return {
        path: input.path,
        change: 'modified',
        summary: input.summary,
        bytes: Buffer.byteLength(result.content, 'utf8'),
        // Indicative only. The authoritative counts come from git diff --numstat.
        linesAdded: result.linesAdded,
        linesRemoved: result.linesRemoved,
      };
    },
  };

  /**
   * Deletion is approval-bearing (chapter 11), so it declares leavesPlatform and
   * the validator requires a granted `file_deletion` approval before it runs.
   */
  private readonly deleteFile: ToolDefinition<PathInput> = {
    name: 'delete_file',
    description: 'Delete a file from the project repository. Requires a human approval',
    permission: 'repository_write',
    leavesPlatform: true,
    simulated: false,
    parameters: DELETE_FILE_SCHEMA,
    availableToModel: true,
    validate: (input) => requireRelativePath(input),
    execute: async (input, context) => {
      assertRepository(context);
      const target = await resolveExistingPath(context.workspace.repositoryPath, input.path);

      const info = await stat(target);
      // A recursive directory delete is not offered: the blast radius of one
      // mistaken path would be a whole subtree.
      if (info.isDirectory()) {
        throw new Error(`${input.path} is a directory. Directory deletion is not available.`);
      }

      await rm(target, { force: true });

      return {
        path: input.path,
        change: 'deleted',
        bytes: info.size,
      };
    },
  };
}
