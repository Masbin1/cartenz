import { Injectable } from '@nestjs/common';
import type { AgentPermission } from '../../core/authz/agent-permissions';
import { isNeverGrantable } from '../../core/authz/agent-permissions';
import type { AgentTaskKind } from '../../core/enums';
import type { ExecutionMode } from '../executors/execution-mode';
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
  /** The execution mode this task runs in (ADR-028). */
  readonly executionMode: ExecutionMode | null;
  /** The kind of task the tool request belongs to (ADR-029). */
  readonly taskKind: AgentTaskKind;
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
 *   3. Is the tool legal in this task's execution mode?
 *   4. Does the project grant the permission the tool requires?
 *   5. Is the input well formed?
 *   6. Does this instance additionally require a human approval?
 *
 * A denial at step 1, 3 or 4 is a policy failure; a denial at step 5 is a
 * malformed request. They are distinguished because they mean different things
 * to whoever reads the audit trail.
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

    // Mode gating (ADR-028). A tool that declares modes is refused in any other
    // mode, and in a task with no mode at all. The AI is never the boundary: the
    // model is not asked to avoid a filesystem on odoo_online; the request is
    // refused here before anything executes.
    if (tool.modes !== undefined) {
      if (context.executionMode === null || !tool.modes.includes(context.executionMode)) {
        return {
          outcome: 'denied',
          reason: `${tool.name} is not available in this project's execution mode`,
        };
      }
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

    // Chat write gate (ADR-029). A chat task reads freely, but a write tool is
    // gated behind an inline approval: these tools replace or create files
    // entirely, so allowing one unapproved would be a write to customer code
    // with no person in the loop. delete_file is deliberately excluded - it
    // keeps its existing `file_deletion` gate below.
    if (
      context.taskKind === 'chat' &&
      CHAT_WRITE_TOOLS.includes(tool.name) &&
      !context.grantedApprovals.includes('chat_edit')
    ) {
      return {
        outcome: 'approval_required',
        tool,
        approvalAction: 'chat_edit',
        reason: 'a chat task writes a file only with your approval',
      };
    }

    // A pull belongs to a change request, not a conversation. A chat task's
    // workspace is a throwaway clone whose changes are read back as the chat's
    // own writes (ADR-053): pulled commits would be mistaken for an approved
    // edit and committed as one. Refused here rather than trusted to the prompt.
    if (context.taskKind === 'chat' && tool.name === 'git_pull') {
      return {
        outcome: 'denied',
        reason: 'git_pull is available in a change request, not in a conversation',
      };
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
        // A change task on Odoo Online has already had its plan approved, and a
        // record write there is what that plan described (ADR-064). Asking again
        // mid-implementation would re-run the loop from the start after the
        // second decision - on a live instance, where the first half already ran.
        if (
          approvalAction === 'odoo_record_write' &&
          context.taskKind === 'change' &&
          context.grantedApprovals.includes('implementation_plan')
        ) {
          return { outcome: 'allowed', tool };
        }

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
 * The write tools whose execution in a chat task requires the `chat_edit`
 * approval (ADR-029). Delete is not here: it is already approval-bearing through
 * its `file_deletion` gate, and one gate is enough.
 */
const CHAT_WRITE_TOOLS = ['edit_file', 'update_file', 'create_file'];

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
    // Record writes on a live Odoo Online instance (ADR-064). Declared here
    // rather than as a chat-only rule like CHAT_WRITE_TOOLS above, because a
    // record write is a change to a customer's running system whether the task
    // that asked for it was a conversation or a change request: `leavesPlatform`
    // is what the boundary means, so the gate follows from it in both kinds.
    case 'odoo_create_records':
    case 'odoo_update_records':
      return 'odoo_record_write';
    default:
      return null;
  }
}
