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

import type { OdooEdition } from '../../core/enums';

/** Files written into a new project directory. */
export interface ScaffoldFile {
  /** Path relative to the project directory. */
  readonly path: string;
  readonly content: string;
  /**
   * POSIX file mode, when it matters. Omitted means the default: only `run.sh`
   * needs to be executable, so only it sets this.
   */
  readonly mode?: number;
}

/**
 * What a runnable `odoo.conf` and `run.sh` need (ADR-035).
 *
 * All absolute and specific to the machine the project is created on: the Odoo
 * base repo root (the one holding `odoo-bin` and `addons/`, per ADR-033), the
 * enterprise path when there is one, and the interpreter that can import Odoo
 * (`ODOO_PYTHON`, ADR-034).
 */
export interface RunnableConfig {
  /** The project's directory name, used as the default database name. */
  readonly directoryName: string;
  /** The Odoo repo root: holds `odoo-bin` and `addons/`. */
  readonly basePath: string;
  /** The enterprise addons directory, or null when not configured. */
  readonly enterprisePath: string | null;
  /**
   * The project's Odoo edition (ADR-037). A community project omits the
   * enterprise path from its addons path even when one is configured.
   */
  readonly edition: OdooEdition;
  /** The interpreter that starts Odoo, usually a virtualenv. */
  readonly python: string;
  /** The HTTP port the dev server binds. */
  readonly httpPort: number;
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
export function buildScaffoldFiles(input: {
  readonly projectName: string;
  /**
   * When present and the base path holds `odoo-bin`, two runnable files are
   * added (ADR-035). Absent — an environment-only deployment or a base without a
   * launcher — leaves the three ADR-032 files unchanged.
   */
  readonly runnable?: RunnableConfig;
}): ScaffoldFile[] {
  const files: ScaffoldFile[] = [
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
        input.runnable
          ? [
              '',
              '## Running locally',
              '',
              'No Docker. This project ships an `odoo.conf` and a `run.sh` pointed at',
              'the Odoo source on the machine it was created on.',
              '',
              '```bash',
              './run.sh -i base --stop-after-init   # first run: initialise the database',
              './run.sh                              # start the server',
              '```',
              '',
              `Then open http://127.0.0.1:${input.runnable.httpPort}.`,
              '',
              'The paths in `odoo.conf` are absolute and specific to this machine.',
              'A clone onto a different host must edit them.',
            ].join('\n')
          : '',
        '',
      ].join('\n'),
    },
  ];

  if (input.runnable) {
    files.push(
      { path: 'odoo.conf', content: buildRunnableConf(input.runnable) },
      { path: 'run.sh', content: buildRunScript(input.runnable), mode: 0o755 },
    );
  }

  return files;
}

/**
 * A runnable server `odoo.conf` (ADR-035) — distinct from the ephemeral
 * validation conf (ADR-027), which runs `--stop-after-init` and is deleted after
 * one run.
 *
 * The addons path is project, then enterprise, then core, matching the order the
 * agent reads them: the project's own modules take precedence, and `<base>/addons`
 * supplies the standard Odoo modules. No password is written — `run.sh` passes it
 * through `PGPASSWORD` — so the committed file carries no credential.
 */
export function buildRunnableConf(config: RunnableConfig): string {
  const addonsPath = [
    `${config.basePath}/addons`,
    // Enterprise only for an Enterprise project (ADR-037): a Community project
    // has no enterprise licence, so its conf must not load enterprise addons.
    config.edition === 'enterprise' ? config.enterprisePath : null,
    'addons',
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(',');

  // `addons/` is written relative on purpose: the conf lives at the project root,
  // Odoo resolves relative addons paths against the conf's directory, so a clone
  // that only moved the project (not the Odoo source) still finds its own modules.

  return [
    '[options]',
    '; Generated by LinkedERP so this project runs as a local dev server (ADR-035).',
    '; This is the project configuration - edit it. Paths are specific to this machine.',
    `addons_path = ${addonsPath}`,
    `db_name = ${config.directoryName}`,
    '; Password is not stored here; run.sh passes it through PGPASSWORD.',
    'db_host = 127.0.0.1',
    'db_port = 5432',
    'db_user = odoo',
    `http_interface = 127.0.0.1`,
    `http_port = ${config.httpPort}`,
    '',
  ].join('\n');
}

/**
 * The launcher (ADR-035). Runs the configured interpreter against the base
 * repo's `odoo-bin` with this conf, forwarding any extra arguments so
 * `./run.sh -u <module>` or `./run.sh --dev=xml` work unchanged.
 */
export function buildRunScript(config: RunnableConfig): string {
  return [
    '#!/usr/bin/env bash',
    '# Generated by LinkedERP (ADR-035). Runs this project as a local Odoo dev',
    '# server, without Docker. First run: ./run.sh -i base --stop-after-init',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    '',
    '# The Postgres password for the db_user in odoo.conf. Override by exporting',
    '# PGPASSWORD before calling, e.g. PGPASSWORD=secret ./run.sh',
    'export PGPASSWORD="${PGPASSWORD:-odoo}"',
    '',
    `exec ${shellQuote(config.python)} ${shellQuote(`${config.basePath}/odoo-bin`)} \\`,
    '  -c odoo.conf "$@"',
    '',
  ].join('\n');
}

/** Single-quotes a value for POSIX sh, escaping embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
