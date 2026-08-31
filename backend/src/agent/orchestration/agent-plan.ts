/**
 * The structured implementation plan the agent produces in the planning state and
 * the user approves before anything is implemented.
 *
 * Persisted on the task rather than only narrated in the conversation, so the
 * approval is against a definite artefact and the same plan can be re-read after
 * the fact.
 */
export interface ImplementationPlan {
  readonly summary: string;
  readonly odooVersion: string | null;
  readonly steps: readonly PlanStep[];
  readonly filesToModify: readonly PlannedFileChange[];
  readonly validation: readonly string[];
  readonly risks: readonly string[];
  /** True while the plan is produced by the mock planner (ADR-013). */
  readonly generatedBy: string;
}

export interface PlanStep {
  readonly order: number;
  readonly title: string;
  readonly detail: string;
}

export interface PlannedFileChange {
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted';
  readonly reason: string;
}

/** A file the task reports as modified, as shown in the workspace. */
export interface ModifiedFile {
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted';
  readonly summary: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

/** Validation and test outcome recorded on the task. */
export interface TaskTestResults {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly suites: readonly {
    readonly name: string;
    readonly status: 'passed' | 'failed';
    readonly detail?: string;
  }[];
  readonly simulated: boolean;
}
