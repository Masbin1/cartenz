import { Injectable } from '@nestjs/common';
import type { Executor } from './executor.interface';

/**
 * The Odoo.sh execution adapter (ADR-028).
 *
 * Odoo.sh (and a plain `repository`, which shares this mode) runs in a
 * Cartenz-managed Git workspace: the platform clones the custom-module
 * repository, the agent modifies a branch other than `main`, and the change is
 * committed and pushed to that branch with the sealed SSH credential.
 *
 * The lifecycle methods live in the workspace manager and the workflow for now;
 * this class is the capability record the rest of the platform reasons about.
 */
@Injectable()
export class OdooSHExecutor implements Executor {
  readonly mode = 'odoo_sh' as const;
  readonly managesGit = true;
  readonly pushesToRemote = true;
  readonly touchesFilesystem = true;
}
