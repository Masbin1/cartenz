import { changedModules } from '../../agent/validation/changed-modules';
import type { ExecutionMode } from '../../agent/executors/execution-mode';

/**
 * The rule and the pure helpers behind an ephemeral preview (ADR-052).
 *
 * Extracted from the service so the decisions can be asserted without a
 * database, a host, or a running Odoo — the part of this feature most likely to
 * be quietly wrong if it lives only in a code path that needs a deployment to
 * exercise.
 */

/**
 * The shape of a preview reference.
 *
 * It becomes a directory name, a systemd unit name and part of a database name,
 * so it is a plain lowercase alphanumeric token and nothing else — the same
 * discipline `scratchDatabaseName` applies to a validation database. Generated
 * by the service, re-validated by the root-run script.
 */
export const PREVIEW_REF_PATTERN = /^[a-z0-9]{16}$/;

export function isPreviewRef(value: string): boolean {
  return PREVIEW_REF_PATTERN.test(value);
}

/**
 * The paths a unified diff touches.
 *
 * Reads the `diff --git a/<path> b/<path>` header git writes for every file,
 * rather than the `+++ b/<path>` line, because the latter is `/dev/null` for a
 * deletion and carries a `a/`/`b/` prefix that is not present in the header for
 * a rename.
 */
export function changedPathsFromPatch(patch: string): string[] {
  const paths = new Set<string>();

  for (const line of patch.split('\n')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!match) continue;
    const path = match[2] === '/dev/null' ? match[1] : match[2];
    if (path && path !== '/dev/null') paths.add(path);
  }

  return [...paths];
}

/** The Odoo modules a draft touches, which are what the preview updates. */
export function previewModules(patch: string): string[] {
  return changedModules(changedPathsFromPatch(patch));
}

export interface PreviewDecisionInput {
  /** `config.preview.enabled`: provisioning on and a script configured. */
  readonly enabled: boolean;
  /** How a task on this project operates (ADR-028, ADR-050). */
  readonly executionMode: ExecutionMode | null;
  /** Whether the task has a retained diff. */
  readonly patchPresent: boolean;
  /** Whether that diff was truncated when it was stored. */
  readonly patchTruncated: boolean;
  /** Whether the project names an Odoo version, needed for the template. */
  readonly hasVersion: boolean;
}

export interface PreviewDecision {
  readonly allowed: boolean;
  /** A plain, user-facing reason when not allowed. Null when allowed. */
  readonly reason: string | null;
}

/**
 * Whether a preview may be built, and why not when it may not.
 *
 * The order is the policy, and each refusal names the actual obstacle rather
 * than a generic failure — the portal shows this text, and "cannot preview" with
 * no reason is the failure mode the operator asked to avoid.
 */
export function decidePreview(input: PreviewDecisionInput): PreviewDecision {
  if (!input.enabled) {
    return {
      allowed: false,
      reason:
        'Preview is not enabled on this deployment (PROJECT_PREVIEW_SCRIPT is empty, or ' +
        'PROJECT_PROVISIONING_ENABLED is false).',
    };
  }

  if (input.executionMode === null || input.executionMode === 'odoo_online') {
    return {
      allowed: false,
      reason:
        'This project has no draft on disk to preview. Preview needs a Git-backed project ' +
        'with a repository.',
    };
  }

  if (!input.patchPresent) {
    return {
      allowed: false,
      reason: 'This task has no retained diff, so there is no draft to show.',
    };
  }

  if (input.patchTruncated) {
    return {
      allowed: false,
      reason:
        'The draft is too large to reconstruct for a preview (its diff was truncated when ' +
        'it was stored). Review its diff instead.',
    };
  }

  if (!input.hasVersion) {
    return {
      allowed: false,
      reason:
        'This project names no Odoo version, so there is no standard database to preview ' +
        'against. Set its version first.',
    };
  }

  return { allowed: true, reason: null };
}

/** Milliseconds left before a preview is torn down; never negative. */
export function remainingTtlMs(expiresAt: Date, now: number): number {
  return Math.max(0, expiresAt.getTime() - now);
}
