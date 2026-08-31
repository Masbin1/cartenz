/**
 * JSON Schemas for the tools a model may call (ADR-020).
 *
 * Held together rather than inline in each tool, so that the surface a model sees
 * can be read in one place. Descriptions matter more here than in ordinary
 * documentation: they are the only guidance a model gets about when to use a tool
 * and what a good argument looks like, so they state the constraint rather than
 * merely naming the parameter.
 */

const relativePath = {
  type: 'string',
  description:
    'Path relative to the repository root, using forward slashes. Absolute paths, paths containing "..", and anything inside .git are refused.',
  maxLength: 1024,
} as const;

export const LIST_DIRECTORY_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      ...relativePath,
      description: `${relativePath.description} Use "." for the repository root.`,
    },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

export const SEARCH_CODE_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'A literal string to find, case-insensitively. Not a regular expression. Use a model name such as "sale.order", a field name, or a class name. At least 2 characters.',
      minLength: 2,
      maxLength: 200,
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

export const READ_FILE_SCHEMA = {
  type: 'object',
  properties: { path: relativePath },
  required: ['path'],
  additionalProperties: false,
} as const;

export const CREATE_FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: relativePath,
    content: {
      type: 'string',
      description:
        'The complete contents of the new file. Not a fragment: whatever is supplied here is exactly what the file will contain.',
    },
    summary: {
      type: 'string',
      description: 'One line describing what this file does and why it was added.',
      maxLength: 500,
    },
  },
  required: ['path', 'content', 'summary'],
  additionalProperties: false,
} as const;

export const UPDATE_FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: relativePath,
    content: {
      type: 'string',
      description:
        'The complete new contents of the file, not a patch and not a fragment. Read the file first: whatever is supplied here replaces it entirely.',
    },
    summary: {
      type: 'string',
      description: 'One line describing what changed in this file and why.',
      maxLength: 500,
    },
  },
  required: ['path', 'content', 'summary'],
  additionalProperties: false,
} as const;

/**
 * A targeted edit (ADR-022). The preferred way to change an existing file: it
 * cannot delete what it does not name, which is the failure update_file has.
 */
export const EDIT_FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: relativePath,
    find: {
      type: 'string',
      description:
        'The exact existing text to replace, copied from the file including its indentation. Must appear exactly once: if it appears more than once, extend it with surrounding lines until it is unique.',
    },
    replace: {
      type: 'string',
      description:
        'The text to put in its place. Everything else in the file is left untouched. Pass an empty string to remove the found text.',
    },
    summary: {
      type: 'string',
      description: 'One line describing what changed in this file and why.',
      maxLength: 500,
    },
  },
  required: ['path', 'find', 'replace', 'summary'],
  additionalProperties: false,
} as const;

export const DELETE_FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      ...relativePath,
      description: `${relativePath.description} Deleting a file requires a human approval, which will pause the task.`,
    },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

/** Tools that take no arguments still need a schema the SDK can serialise. */
export const NO_ARGUMENTS_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export const GIT_BRANCH_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'Branch name. Letters, digits, dot, underscore, slash and hyphen only; must not begin with a hyphen.',
      maxLength: 200,
    },
  },
  required: ['name'],
  additionalProperties: false,
} as const;

export const GIT_COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: 'Commit message. A subject line, a blank line, then the body.',
      maxLength: 4000,
    },
  },
  required: ['message'],
  additionalProperties: false,
} as const;

export const VALIDATION_SCHEMA = {
  type: 'object',
  properties: {
    module: {
      type: 'string',
      description: 'Technical name of the module to test. Omit to test everything.',
      maxLength: 200,
    },
  },
  additionalProperties: false,
} as const;

export const RUN_LINTER_SCHEMA = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Paths to check. Omit to check every modified file.',
      maxItems: 100,
    },
  },
  additionalProperties: false,
} as const;
