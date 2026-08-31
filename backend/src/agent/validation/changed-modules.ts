/**
 * Which Odoo modules a set of changed files belongs to (ADR-027).
 *
 * A validation run installs modules, not files, so the change has to be mapped
 * back to the addons that contain it. In an Odoo repository the addon is the
 * directory holding `__manifest__.py`, and in the layouts this serves that is the
 * first path segment.
 *
 * Files outside any addon - a README, a `.gitignore`, a `docs/` directory - map
 * to nothing, which is the right answer: there is no module to install for them.
 */

/**
 * Directories that are never an Odoo addon, whatever they contain.
 *
 * Listed rather than detected because detection would mean reading the workspace
 * from a function whose whole value is being cheap and pure.
 */
const NOT_ADDONS = new Set(['docs', '.github', '.vscode', 'setup', 'scripts']);

export function changedModules(paths: readonly string[]): string[] {
  const modules = new Set<string>();

  for (const path of paths) {
    // Strips a leading "/" or "./" only. A character class of [./] would also eat
    // the dot of ".github", turning a directory that is never an addon into one
    // called "github".
    const normalised = path.replace(/^(?:\.\/|\/)+/, '');
    const segments = normalised.split('/').filter((segment) => segment.length > 0);

    // A file at the repository root belongs to no addon.
    if (segments.length < 2) continue;

    const candidate = segments[0];
    if (NOT_ADDONS.has(candidate) || candidate.startsWith('.')) continue;

    modules.add(candidate);
  }

  return [...modules].sort();
}
