/**
 * Scaffolding a project's addons directory (ADR-032, amended by ADR-033).
 *
 * Pure functions: the directory-name derivation and the file contents. The
 * filesystem work lives in the service, so the part with the rules is testable
 * without touching a disk.
 *
 * The scaffold deliberately creates an empty `addons/` directory rather than a
 * module. What a project needs on day one is somewhere to put addons; the module
 * name belongs to the first task that describes the work, not to project
 * creation.
 */

/** Files written into a new project directory. */
export interface ScaffoldFile {
  /** Path relative to the project directory. */
  readonly path: string;
  readonly content: string;
}

/**
 * Derives a directory name from a project name.
 *
 * "PT Angin Ribut" -> pt_angin_ribut. The addons directory sits on an Odoo
 * addons path and its children are Python packages, so the same lowercase
 * identifier rules are applied here: a directory the operator has to rename
 * before Odoo will load anything from it is not a working default.
 *
 * Returns null when nothing usable survives, which the caller reports rather
 * than inventing a name.
 */
export function deriveDirectoryName(projectName: string): string | null {
  const ascii = projectName
    .normalize('NFKD')
    // Strip accents rather than dropping the letter: "Café" -> "cafe", not "caf".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const collapsed = ascii
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (collapsed.length === 0) return null;

  // A leading digit cannot start a Python identifier, and modules created inside
  // this directory are imported by name.
  const prefixed = /^[0-9]/.test(collapsed) ? `m_${collapsed}` : collapsed;

  return prefixed.slice(0, 63).replace(/_+$/g, '');
}

/**
 * Whether a name is safe to join onto the projects root and usable by Odoo.
 *
 * Rejects anything containing a separator, a leading dot or traversal, so the
 * name alone cannot escape the intended directory. The service checks the
 * resolved path as well: this is the first of two gates, not the only one.
 */
export function isValidDirectoryName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,62}$/.test(name) && !name.endsWith('_');
}

/**
 * The files written into a new project directory.
 *
 * `addons/.gitkeep` because git does not track directories: without it the
 * addons directory would exist on the machine that created it and vanish for
 * anyone who cloned the repository.
 */
export function buildScaffoldFiles(input: { readonly projectName: string }): ScaffoldFile[] {
  return [
    {
      path: 'addons/.gitkeep',
      content: '',
    },
    {
      path: '.gitignore',
      content: ['__pycache__/', '*.pyc', '*.pyo', '.idea/', '.vscode/', ''].join('\n'),
    },
    {
      path: 'README.md',
      content: [
        `# ${input.projectName}`,
        '',
        'Custom Odoo addons for this project.',
        '',
        'Modules live in `addons/`. That directory is on the Odoo addons path and',
        'is the only place this project writes: the Odoo base and enterprise',
        'source are configured as read-only references, so a task can read all of',
        'Odoo and change only the modules here.',
        '',
        'The directory starts empty. Modules are created by the work that needs',
        'them, so their names come from the change rather than from the project.',
        '',
      ].join('\n'),
    },
  ];
}
