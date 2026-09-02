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

const odooModelName = {
  type: 'string',
  description:
    'The technical model name, e.g. "sale.order". Dotted, as in the Odoo ORM.',
  pattern: '^[a-z0-9_]+(\\.[a-z0-9_]+)*$',
  maxLength: 120,
} as const;

export const ODOO_LIST_MODELS_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'A case-insensitive fragment of the model name to filter on. Omit to list everything.',
      maxLength: 120,
    },
  },
  additionalProperties: false,
} as const;

export const ODOO_LIST_FIELDS_SCHEMA = {
  type: 'object',
  properties: { model: odooModelName },
  required: ['model'],
  additionalProperties: false,
} as const;

export const ODOO_CREATE_FIELD_SCHEMA = {
  type: 'object',
  properties: {
    model: odooModelName,
    name: {
      type: 'string',
      description:
        'Technical field name, without the "x_" prefix (it is added automatically, as Studio does). e.g. "referensi".',
      pattern: '^[a-z0-9_]+$',
      maxLength: 60,
    },
    label: {
      type: 'string',
      description: 'The human label shown in the UI, e.g. "Referensi".',
      maxLength: 200,
    },
    type: {
      type: 'string',
      description: 'Field type: char, text, integer, float, boolean, date, datetime, selection, many2one.',
      maxLength: 40,
    },
    required: {
      type: 'boolean',
      description: 'Whether the field must always have a value. Defaults to false.',
    },
  },
  required: ['model', 'name', 'label', 'type'],
  additionalProperties: false,
} as const;

export const ODOO_ADD_FIELD_TO_VIEW_SCHEMA = {
  type: 'object',
  properties: {
    model: odooModelName,
    field: {
      type: 'string',
      description: 'The technical field name to add, including the "x_" prefix.',
      pattern: '^[a-z0-9_]+$',
      maxLength: 120,
    },
    after: {
      type: 'string',
      description: 'The technical name of the existing field this new field goes below, e.g. "payment_term_id".',
      pattern: '^[a-z0-9_]+$',
      maxLength: 120,
    },
  },
  required: ['model', 'field', 'after'],
  additionalProperties: false,
} as const;
