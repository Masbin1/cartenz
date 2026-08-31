import { ODOO_VERSIONS, type OdooVersion } from '../../core/enums';

/**
 * The structured project specification.
 *
 * Persisted as a versioned record rather than inferred from conversation, so
 * that the agent's understanding of a project has a definite, reviewable source.
 * The shape follows the documented example, with `version` and `createdAt`
 * added so a specification can be revised without losing the previous one.
 */
export interface ProjectSpecification {
  readonly project_name: string;
  readonly framework: 'Odoo';
  readonly odoo_version: string;
  readonly description: string;
  readonly modules: readonly string[];
  readonly requirements: readonly ProjectSpecificationRequirement[];
  readonly deployment: {
    readonly environment: 'development' | 'staging' | 'production';
  };
}

export interface ProjectSpecificationRequirement {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
}

export interface BuildSpecificationInput {
  readonly projectName: string;
  readonly odooVersion: OdooVersion;
  readonly description: string;
  readonly requirements: readonly { title: string; detail?: string }[];
  readonly modules?: readonly string[];
}

/**
 * Builds a specification from the AI project flow inputs.
 *
 * Requirements are given stable identifiers (REQ-001 and upward) at this point
 * rather than at display time, so that a plan or a task can cite a requirement
 * by an identifier that does not move when the list is reordered.
 *
 * The environment is always `development`. Production is never a target of a
 * newly specified project: deployment automation is out of MVP scope, and
 * defaulting otherwise would put a new project one approval away from a
 * production action.
 */
export function buildProjectSpecification(
  input: BuildSpecificationInput,
): ProjectSpecification {
  if (!(ODOO_VERSIONS as readonly string[]).includes(input.odooVersion)) {
    throw new Error(`Unsupported Odoo version: ${input.odooVersion}`);
  }

  return {
    project_name: input.projectName,
    framework: 'Odoo',
    odoo_version: input.odooVersion.replace(/[.]0$/, ''),
    description: input.description,
    modules: [...(input.modules ?? [])],
    requirements: input.requirements.map((requirement, index) => ({
      id: `REQ-${String(index + 1).padStart(3, '0')}`,
      title: requirement.title,
      ...(requirement.detail ? { detail: requirement.detail } : {}),
    })),
    deployment: { environment: 'development' },
  };
}
