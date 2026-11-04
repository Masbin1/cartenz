import type { PromptPart } from '../model/model-provider.interface';

/** A tool call this task has already made successfully, before it was last suspended. */
export interface PriorAction {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown>;
}

export interface PriorProgressBudget {
  readonly maxActions: number;
  readonly maxChars: number;
}

export const DEFAULT_PRIOR_PROGRESS_BUDGET: PriorProgressBudget = {
  maxActions: 60,
  maxChars: 8_000,
};

export const PRIOR_PROGRESS_LABEL =
  'What you already did in this task before being paused for approval';

/**
 * Renders this task's own successful tool calls as one prompt part, or
 * returns an empty list when there are none (ADR-092).
 *
 * Oldest first, matching the order they actually happened in, so the model
 * reads them the same way it would read its own earlier turns. Each call is
 * a single line - tool name plus a short, size-capped rendering of its input
 * and output - since the point is "what happened and roughly what came back",
 * not a byte-for-byte replay of large tool output already in the database.
 *
 * Not marked untrusted: this is the platform's own audit log of calls that
 * already passed the permission validator, not content a person or a file
 * supplied - the same trust level as the prompt the model is answering.
 */
export function buildPriorProgress(
  actions: readonly PriorAction[],
  budget: PriorProgressBudget = DEFAULT_PRIOR_PROGRESS_BUDGET,
): PromptPart[] {
  if (actions.length === 0) return [];

  const considered = actions.slice(0, budget.maxActions);
  const omitted = actions.length - considered.length;

  const lines = considered.map(
    (action, index) =>
      `${index + 1}. ${action.toolName}(${shorten(JSON.stringify(action.input), 200)}) -> ` +
      shorten(JSON.stringify(action.output), 300),
  );

  const header =
    'You already made these tool calls earlier in this same task, before being paused for a ' +
    "human approval. Do not repeat them or redo work they already finished - continue from " +
    'where they left off towards what the approval you just received was for.';

  const footer = omitted > 0 ? `\n\n(${omitted} earlier call(s) omitted for length.)` : '';

  let content = `${header}\n\n${lines.join('\n')}${footer}`;
  if (content.length > budget.maxChars) {
    content = `${content.slice(0, budget.maxChars)}\n\n(truncated)`;
  }

  return [{ label: PRIOR_PROGRESS_LABEL, content, untrusted: false }];
}

function shorten(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}
