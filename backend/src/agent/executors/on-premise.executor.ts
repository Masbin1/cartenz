import { Injectable } from '@nestjs/common';
import type { Executor } from './executor.interface';

/**
 * The on-premise execution adapter (ADR-028).
 *
 * The agent operates directly on the customer's selected local custom-module
 * directory: no clone, writes contained to that directory, and shared Odoo base
 * and enterprise directories readable but never writable.
 *
 * The lifecycle methods that actually drive a task live in the workspace manager
 * and the workflow for now; this class is the capability record the rest of the
 * platform reasons about, and the home for those methods as the executor grows.
 */
@Injectable()
export class OnPremiseExecutor implements Executor {
  readonly mode = 'on_premise' as const;
  readonly managesGit = true;
  readonly pushesToRemote = true;
  readonly touchesFilesystem = true;
}
