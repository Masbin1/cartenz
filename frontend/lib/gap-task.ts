/**
 * ADR-073 Phase 3: one-click task from a configuration gap.
 *
 * A gap is a requirement the fit-gap review could not cover with modules or
 * configuration (`kind: 'configuration_gap'`). The project page links each one
 * to the agent workspace as `?requirement=REQ-00N`; the workspace resolves the
 * id against the specification it already loads and pre-fills the prompt.
 *
 * The link carries only the id, never the text: the prompt is rebuilt from the
 * stored specification, so a shared or edited URL cannot put arbitrary text in
 * the composer, and the URL stays short however long the requirement is.
 *
 * The prompt is a draft. Nothing is submitted until the person sends it.
 */
import type { ProjectDetail, ProjectSpecification } from './types';

export type SpecificationRequirement = ProjectSpecification['requirements'][number];

/** Requirement ids are `REQ-` plus digits; anything else is ignored. */
const REQUIREMENT_ID = /^REQ-\d{1,4}$/;

export function isConfigurationGap(requirement: SpecificationRequirement): boolean {
  return requirement.kind === 'configuration_gap';
}

/** The workspace link for one gap. */
export function gapTaskHref(projectId: string, requirementId: string): string {
  return `/projects/${projectId}/agent?requirement=${encodeURIComponent(requirementId)}`;
}

/**
 * Finds the gap a `?requirement=` value names. Returns null for a malformed
 * id, an id the specification does not have, or a requirement that is not a
 * configuration gap — the workspace then opens with an empty composer, as it
 * would without the parameter.
 */
export function findGapRequirement(
  specification: ProjectSpecification | null | undefined,
  requirementId: string | null | undefined,
): SpecificationRequirement | null {
  if (!specification || !requirementId || !REQUIREMENT_ID.test(requirementId)) return null;
  const found = specification.requirements.find((entry) => entry.id === requirementId);
  return found && isConfigurationGap(found) ? found : null;
}

/**
 * The draft prompt for a gap: the requirement itself, then what the database
 * already has, so the agent builds on the configured state instead of
 * re-deciding it. Only applied/skipped setup entries are listed (skipped means
 * it was already in place); failed entries are not the database's state.
 */
export function gapTaskPrompt(
  requirement: SpecificationRequirement,
  project: Pick<ProjectDetail, 'odooVersion' | 'specification' | 'dbSetup'>,
): string {
  const lines: string[] = [];
  lines.push(`Implement ${requirement.id}: ${requirement.title}`);
  if (requirement.detail) {
    lines.push('', `From the project brief: ${requirement.detail}`);
  }

  lines.push(
    '',
    'This is a configuration gap from the fit-gap review: standard modules and settings do not cover it, so it needs a custom module or customisation.',
  );

  const context: string[] = [];
  if (project.odooVersion) context.push(`- Odoo version: ${project.odooVersion}`);
  const modules = project.specification?.modules ?? [];
  if (modules.length > 0) context.push(`- Installed modules: ${modules.join(', ')}`);

  const inPlace = (project.dbSetup?.report ?? []).filter(
    (entry) => entry.status === 'applied' || entry.status === 'skipped',
  );
  if (inPlace.length > 0) {
    context.push('- Already configured in the database:');
    for (const entry of inPlace) {
      const detail = entry.detail && entry.detail !== entry.label ? ` (${entry.detail})` : '';
      context.push(`  - ${entry.kind}: ${entry.label}${detail}`);
    }
  }

  if (context.length > 0) {
    lines.push('', 'Context:', ...context);
  }

  lines.push(
    '',
    'Build on the existing configuration rather than changing it. If something in the requirement is ambiguous, state the assumption you made.',
  );

  return lines.join('\n');
}
