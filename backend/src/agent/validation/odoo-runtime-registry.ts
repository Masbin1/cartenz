/**
 * Which Odoo core to validate a project against (ADR-027).
 *
 * A consultancy's server holds several Odoo versions side by side. The host this
 * was written against has a 19.0 core, a 17.0 core, and one shared enterprise
 * directory, with each client's addons in their own directory beside them. A
 * project's version is detected from its manifests; this maps that to the core
 * that can actually load it.
 *
 * Configured, never guessed. Running 18.0 code against a 19.0 core produces a
 * page of import errors that look like the change is broken when the runtime is
 * simply wrong, and that is a worse outcome than not running the tests at all.
 * A version with no configured runtime is skipped, and the reason says which
 * version was wanted.
 */

export interface OdooRuntime {
  /** The series this runtime serves: `17.0`, `18.0`, `19.0`. */
  readonly series: string;
  /** Absolute path to the directory containing `odoo-bin`. */
  readonly corePath: string;
  /**
   * Extra addon directories always on the path for this series - enterprise,
   * OCA, anything shared. The project's own addons are added per run, from the
   * workspace rather than from the live directory.
   */
  readonly sharedAddonPaths: readonly string[];
}

export class UnknownOdooRuntimeError extends Error {
  constructor(
    readonly series: string,
    readonly configured: readonly string[],
  ) {
    super(
      configured.length === 0
        ? `No Odoo runtime is configured, so validation cannot run. Set ODOO_RUNTIMES to ` +
          `point at least one series at a core directory, for example ` +
          `"19.0=/opt/odoo19".`
        : `No Odoo runtime is configured for series ${series}. Configured: ` +
          `${configured.join(', ')}. Validation is skipped rather than run against a ` +
          `different series, which would fail for reasons that have nothing to do with ` +
          `the change.`,
    );
    this.name = 'UnknownOdooRuntimeError';
  }
}

/**
 * Normalises an Odoo version to its series.
 *
 * Manifests carry `19.0.1.0.3`, the release carries `19.0`, and people write
 * `19`. All three mean the same runtime, and treating them as different would
 * make the registry depend on which of them a repository happened to use.
 */
export function toSeries(version: string): string {
  const parts = version.trim().split('.');
  if (parts.length === 0 || parts[0] === '') return '';

  const major = parts[0];
  const minor = parts.length > 1 ? parts[1] : '0';

  return `${major}.${minor}`;
}

/**
 * Reads the runtimes from configuration.
 *
 * The format is `series=path` pairs: `19.0=/opt/odoo19,17.0=/opt/odoo17`. Shared
 * addon directories are given separately and apply to every series, because on
 * the layout this serves the enterprise directory is shared across versions.
 */
export function parseRuntimes(
  spec: string,
  sharedAddonPaths: readonly string[] = [],
): OdooRuntime[] {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf('=');
      if (separator === -1) {
        throw new Error(
          `"${entry}" is not a runtime. Each entry is series=path, for example 19.0=/opt/odoo19.`,
        );
      }

      const series = toSeries(entry.slice(0, separator));
      const corePath = entry.slice(separator + 1).trim();

      if (!series) throw new Error(`"${entry}" has no series before the "=".`);
      if (!corePath.startsWith('/')) {
        throw new Error(
          `"${corePath}" is not an absolute path. A relative runtime path would resolve ` +
            'against whatever directory the worker happened to start in.',
        );
      }

      return { series, corePath, sharedAddonPaths };
    });
}

/** Selects the runtime for a project's detected version. */
export function selectRuntime(
  runtimes: readonly OdooRuntime[],
  version: string | null,
): OdooRuntime {
  const series = toSeries(version ?? '');
  const match = runtimes.find((runtime) => runtime.series === series);

  if (!match) {
    throw new UnknownOdooRuntimeError(
      series || '(none detected)',
      runtimes.map((runtime) => runtime.series),
    );
  }

  return match;
}
