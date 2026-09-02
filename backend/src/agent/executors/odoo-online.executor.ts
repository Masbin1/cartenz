import { Injectable } from '@nestjs/common';
import type { Executor } from './executor.interface';

/**
 * The Odoo Online execution adapter (ADR-028).
 *
 * No filesystem, no Git, no workspace: the agent operates against the Odoo Online
 * instance through the JSON-RPC customization surface, driven with the project's
 * sealed credentials. The lifecycle methods live in the tools and client for now;
 * this class is the capability record the rest of the platform reasons about.
 */
@Injectable()
export class OdooOnlineExecutor implements Executor {
  readonly mode = 'odoo_online' as const;
  readonly managesGit = false;
  readonly pushesToRemote = false;
  readonly touchesFilesystem = false;
}
