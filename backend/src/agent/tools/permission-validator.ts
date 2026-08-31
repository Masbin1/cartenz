import { Injectable } from '@nestjs/common';
import type { AgentPermission } from '../../core/authz/agent-permissions';
import { isNeverGrantable } from '../../core/authz/agent-permissions';
import { ToolRegistry } from './tool-registry';
import type { AnyToolDefinition } from './tool.interface';

/** The outcome of validating one tool request. */
export type ToolPermissionDecision =
  | { readonly outcome: 'allowed'; readonly tool: AnyToolDefinition }
  | {
      readonly outcome: 'approval_required';
      readonly tool: AnyToolDefinition;
      readonly approvalAction: string;
      readonly reason: string;
    }
  | { readonly outcome: 'denied'; readonly reason: string };

export interface ToolRequest {
  readonly toolName: string;
  readonly input: unknown;
}

export interface ToolPolicyContext {
  readonly agentPermissions: Record<AgentPermission, boolean>;
  /** Approval actions already granted for this task. */
  readonly grantedApprovals: readonly string[];
}

/**
 * The permission validator of chapter 7.
 *
 * Every tool request passes through `validate` before anything is executed.
 * There is no second path to execution: the execution service takes its decision
 * from this class and refuses to proceed on anything other than `allowed`.
 *
 * The checks run in a deliberate order, most categorical first:
 *
 *   1. Is the capability one that can never be granted?
 *   2. Is the tool registered?
 *   3. Does the project grant the permission the tool requires?
 *   4. Is the input well formed?
 *   5. Does this instance additionally require a human approval?
 *
 * A denial at step 1 or 3 is a policy failure; a denial at step 4 is a malformed
 * request. They are distinguished because they mean different things to whoever
 * reads the audit trail.
 */
@Injectable()
export class ToolPermissionValidator {
  constructor(private readonly registry: ToolRegistry) {}

  validate(request: ToolRequest, context: ToolPolicyContext): ToolPermissionDecision {
    if (isNeverGrantable(request.toolName)) {
      return {
        outcome: 'denied',
        reason: `${request.toolName} is never permitted (Table 7: always denied)`,
      };
    }

    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return { outcome: 'denied', reason: `${request.toolName} is not a registered tool` };
    }

    if (context.agentPermissions[tool.permission] !== true) {
      return {
        outcome: 'denied',
        reason: `the project does not grant ${tool.permission}, which ${tool.name} requires`,
      };
    }

    const invalid = tool.validate(request.input);
    if (invalid) {
      return { outcome: 'denied', reason: `invalid request for ${tool.name}: ${invalid}` };
    }

    if (tool.leavesPlatform) {
      const approvalAction = approvalActionForTool(tool.name);

      if (!approvalAction) {
        /**
         * Fails closed. A tool that leaves the platform boundary with no
         * approval action mapped is refused rather than permitted unapproved, so
         * adding such a tool without also declaring its approval action is a
         * refused request rather than an unguarded one.
         */
        return {
          outcome: 'denied',
          reason: `${tool.name} leaves the platform boundary but has no approval action mapped`,
        };
      }

      if (!context.grantedApprovals.includes(approvalAction)) {
        return {
          outcome: 'approval_required',
          tool,
          approvalAction,
          reason: `${tool.name} affects systems outside the platform and requires approval`,
        };
      }
    }

    return { outcome: 'allowed', tool };
  }
}

/**
 * Maps a tool to the approval action that authorises it. See the fail-closed
 * note above: a tool with `leavesPlatform` and no entry here is denied.
 */
export function approvalActionForTool(toolName: string): string | null {
  switch (toolName) {
    case 'git_push':
      return 'git_push';
    case 'delete_file':
      return 'file_deletion';
    default:
      return null;
  }
}
