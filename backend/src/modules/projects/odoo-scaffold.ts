/**
 * Scaffolding a custom Odoo addon for a new project (ADR-032).
 *
 * Pure functions: the technical name derivation and the file contents. The
 * filesystem work lives in the service, so the part with the rules can be tested
 * without a disk.
 */

/** Odoo module names are Python package names, so this is a constraint. */
const MAX_TECHNICAL_NAME_LENGTH = 63;

/**
 * Derives an Odoo module name from a project name.
 *
 * "Vania Sales" -> `vania_sales`. Lowercased because Odoo module directories are
 * lowercase by convention and case-sensitively imported; non-alphanumerics
 * collapse to a single underscore because a module name is a Python identifier;
 * a leading digit is prefixed because an identifier cannot start with one.
 *
 * Returns null when nothing usable survives — a name of only punctuation — so
 * the caller asks for an explicit technical name rather than inventing one.
 */
export function deriveTechnicalName(projectName: string): string | null {
  const slug = projectName
    .normalize('NFKD')
    // Strip accents so "Café" becomes "cafe" rather than losing the letter.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (slug.length === 0) return null;

  const prefixed = /^[0-9]/.test(slug) ? `m_${slug}` : slug;
  return prefixed.slice(0, MAX_TECHNICAL_NAME_LENGTH).replace(/_+$/, '');
}

/**
 * Whether a technical name is one this platform will create a directory for.
 *
 * Deliberately stricter than "a valid Python identifier": no separators, no
 * dots, no leading underscore. The directory is created under the on-premise
 * root by joining this name, so a name that could traverse is refused here as
 * well as by the containment check.
 */
export function isValidTechnicalName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,62}$/.test(name) && !name.endsWith('_');
}

export interface ScaffoldFile {
  /** Path relative to the repository root, always with forward slashes. */
  readonly path: string;
  readonly content: string;
}

/**
 * The files a scaffolded addon starts with.
 *
 * Minimal on purpose. A scaffold that ships a demo model produces modules that
 * carry example code for the rest of their life; the agent adds a model when a
 * task asks for one. What is here is what Odoo requires for the module to load
 * and be extendable: the package markers, a manifest, and the access-rules file
 * every new model needs a row in.
 */
export function buildScaffoldFiles(input: {
  readonly technicalName: string;
  readonly projectName: string;
  readonly odooVersion: string | null;
}): readonly ScaffoldFile[] {
  const { technicalName, projectName } = input;
  // Odoo manifest versions are `<series>.<module version>`; 1.0.0 is the
  // conventional starting point for a new module.
  const series = input.odooVersion ?? '1.0';
  const version = `${series}.1.0.0`;

  return [
    {
      path: `${technicalName}/__init__.py`,
      content: 'from . import models\n',
    },
    {
      path: `${technicalName}/__manifest__.py`,
      content: [
        '{',
        `    "name": ${JSON.stringify(projectName)},`,
        `    "version": ${JSON.stringify(version)},`,
        '    "category": "Customisations",',
        '    "license": "LGPL-3",',
        '    # base only: a scaffold does not know what the work will need, and the',
        '    # agent adds a dependency when a change actually requires it.',
        '    "depends": ["base"],',
        '    "data": [',
        '        "security/ir.model.access.csv",',
        '    ],',
        '    "installable": True,',
        '    "application": False,',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: `${technicalName}/models/__init__.py`,
      content: '',
    },
    {
      path: `${technicalName}/security/ir.model.access.csv`,
      content:
        'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\n',
    },
    {
      path: `${technicalName}/README.md`,
      content: [
        `# ${projectName}`,
        '',
        `Custom Odoo addon \`${technicalName}\`.`,
        '',
        'Created by the LinkedERP AI Development Agent (ADR-032).',
        '',
        '## Layout',
        '',
        '- `models/` — Python models, each imported from `models/__init__.py`',
        '- `views/` — XML views, each declared in `__manifest__.py`',
        '- `security/ir.model.access.csv` — one row per model, or it is unusable',
        '',
      ].join('\n'),
    },
    {
      path: '.gitignore',
      content: ['__pycache__/', '*.pyc', '*.pyo', '.idea/', '.vscode/', ''].join('\n'),
    },
  ];
}
