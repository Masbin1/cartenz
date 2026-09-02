import type { ExecutionMode } from './execution-mode';

/**
 * The execution adapter seam (ADR-028).
 *
 * Each execution mode is implemented by its own executor - `OdooOnlineExecutor`,
 * `OdooSHExecutor`, `OnPremiseExecutor` - bound behind this interface and
 * resolved once at dispatch from the project type. No tool may reach a resource
 * outside what its mode permits.
 *
 * The three capability facts below are what the platform reasons about and what
 * the mode gating is described in terms of. The concrete lifecycle methods
 * (prepare the execution surface, apply changes, validate, commit, push) are
 * introduced on the concrete executors as each is built, keeping this interface
 * the stable contract they all satisfy.
 */
export interface Executor {
  /** The execution mode this executor implements. */
  readonly mode: ExecutionMode;

  /** Whether the agent's changes live in a Git repository (odoo_sh, on_premise). */
  readonly managesGit: boolean;

  /** Whether a completed change is pushed to a remote by the platform. */
  readonly pushesToRemote: boolean;

  /** Whether the agent touches a filesystem at all (false for odoo_online). */
  readonly touchesFilesystem: boolean;
}

/**
 * Multi-provider token under which the concrete executors are bound. The
 * ExecutorRegistry collects every value registered against it.
 */
export const EXECUTOR = 'AGENT_EXECUTOR';
