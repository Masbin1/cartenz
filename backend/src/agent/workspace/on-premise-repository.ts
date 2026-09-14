import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The directory that is the Git repository for a selected on-premise project
 * (ADR-039).
 *
 * The directory that was selected when that is the repository, the `addons/`
 * directory inside it when that is one instead, and null when neither is. Two
 * layouts exist and both are legitimate: a project this platform scaffolded has the
 * repository at its root with `addons/` inside it, while a project the operator's
 * create_project provisioned keeps its repository *in* `addons/` and treats the
 * project directory as a container for `config/`, `data/` and `logs/`.
 *
 * Shared rather than written twice because it is the same question in both places
 * that ask it: the workspace layer, before it operates on a project, and the
 * backfill that gives an older project its remote.
 */
export async function resolveOnPremiseRepository(selected: string): Promise<string | null> {
  const isRepository = async (candidate: string): Promise<boolean> =>
    (await stat(join(candidate, '.git')).catch(() => null)) !== null;

  if (await isRepository(selected)) return selected;

  const addons = join(selected, 'addons');
  const addonsInfo = await stat(addons).catch(() => null);
  if (addonsInfo?.isDirectory() && (await isRepository(addons))) return addons;

  return null;
}
