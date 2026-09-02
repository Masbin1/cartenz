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
 *   - `ai_project` has no repository and no execution surface: a task on it can
 *     only plan, never modify anything, so it maps to `null`.
 */
export const EXECUTION_MODES = ['odoo_online', 'odoo_sh', 'on_premise'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

const MODE_BY_PROJECT_TYPE: Partial<Record<ProjectType, ExecutionMode>> = {
  odoo_online: 'odoo_online',
  odoo_sh: 'odoo_sh',
  repository: 'odoo_sh',
  on_premise: 'on_premise',
};

/** The execution mode a task on the given project type runs in, or null. */
export function executionModeFor(projectType: ProjectType): ExecutionMode | null {
  return MODE_BY_PROJECT_TYPE[projectType] ?? null;
}

export function isExecutionMode(value: string): value is ExecutionMode {
  return (EXECUTION_MODES as readonly string[]).includes(value);
}
