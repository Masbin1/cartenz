import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ExecutionMode } from './execution-mode';
import { EXECUTOR, type Executor } from './executor.interface';

/** Raised when a mode has no executor bound. Failing closed, not falling through. */
export class UnsupportedExecutionModeError extends Error {
  constructor(mode: string) {
    super(
      `No executor is bound for execution mode "${mode}". ` +
        'This mode is not implemented yet; the task cannot run.',
    );
    this.name = 'UnsupportedExecutionModeError';
  }
}

/**
 * Resolves the executor for an execution mode (ADR-028).
 *
 * The concrete executors register themselves against the `EXECUTOR` multi-provider
 * token; this registry collects them and answers the single dispatch question
 * "which executor runs this task". A mode with no executor is refused explicitly
 * rather than silently falling back to a different mode's behaviour.
 */
@Injectable()
export class ExecutorRegistry {
  private readonly executors = new Map<ExecutionMode, Executor>();

  constructor(@Optional() @Inject(EXECUTOR) executors: readonly Executor[] = []) {
    for (const executor of executors) {
      if (this.executors.has(executor.mode)) {
        throw new Error(
          `Duplicate executor registration for mode "${executor.mode}". Execution modes must be unique.`,
        );
      }
      this.executors.set(executor.mode, executor);
    }
  }

  /** The executor for a mode, throwing when none is bound. */
  forMode(mode: ExecutionMode): Executor {
    const executor = this.executors.get(mode);
    if (!executor) throw new UnsupportedExecutionModeError(mode);
    return executor;
  }

  /** Whether an executor is bound for the mode. */
  has(mode: ExecutionMode): boolean {
    return this.executors.has(mode);
  }

  /** The modes an executor is currently bound for. */
  boundModes(): readonly ExecutionMode[] {
    return [...this.executors.keys()];
  }
}
