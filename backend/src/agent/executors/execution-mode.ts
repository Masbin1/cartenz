import type { ProjectType } from '../../core/enums';

/**
 * The three execution modes of Cartenz (ADR-028).
 *
 * A project type is not an execution mode: `project_type` records where a project
 * comes from (Table 4, ADR-017), while an execution mode records how a task on
 * that project actually operates. The mapping below is the single place that
 * decides it, so no tool, workflow or validator answers the question twice.
 *
 *   odoo_online  -> the AI operates on the Odoo instance through Studio
 *   odoo_sh      -> the AI operates on a Cartenz-managed Git workspace
 *   on_premise   -> the AI operates directly on the selected local directory
 *
 * Two of the five project types share an execution mode:
 *
 *   - `odoo_sh` and `repository` both run the Cartenz-managed Git workspace. They
 *     differ on branch policy and build monitoring (Odoo.sh specifics), not on
 *     which tools are legal, so they share the `odoo_sh` mode here.
 *   - `ai_project` has no repository. Before it has a local directory a task on
 *     it can only plan, so it maps to `null`; once it has been scaffolded a
 *     local directory (ADR-036) it runs in the `on_premise` mode, working
 *     directly on that directory like any other on-premise project.
 */
export const EXECUTION_MODES = ['odoo_online', 'odoo_sh', 'on_premise'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

const MODE_BY_PROJECT_TYPE: Partial<Record<ProjectType, ExecutionMode>> = {
  odoo_online: 'odoo_online',
  odoo_sh: 'odoo_sh',
  repository: 'odoo_sh',
  on_premise: 'on_premise',
};

/** Facts beyond the project type that can decide an execution mode (ADR-036). */
export interface ExecutionModeContext {
  /**
   * Whether the project has a local directory selected. For an `ai_project` this
   * is what turns a plan-only project into one that runs on-premise; other types
   * ignore it, their mode being fixed by the type.
   */
  readonly hasLocalDirectory?: boolean;
}

/** The execution mode a task on the given project type runs in, or null. */
export function executionModeFor(
  projectType: ProjectType,
  context: ExecutionModeContext = {},
): ExecutionMode | null {
  // An AI project is a creation flow, not a permanently inert type (ADR-036):
  // once it has a local directory its tasks run on-premise, writing real modules
  // into that directory rather than into a throwaway simulated workspace.
  if (projectType === 'ai_project') {
    return context.hasLocalDirectory ? 'on_premise' : null;
  }

  return MODE_BY_PROJECT_TYPE[projectType] ?? null;
}

export function isExecutionMode(value: string): value is ExecutionMode {
  return (EXECUTION_MODES as readonly string[]).includes(value);
}
