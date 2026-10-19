import type { PromptPart } from '../model/model-provider.interface';

/**
 * Per-conversation memory (ADR-074).
 *
 * Every message a person sends in a workspace conversation creates a new task,
 * and each task used to reach the model with nothing but its own prompt. The
 * session grouped the tasks for the portal (ADR-047) but nothing carried the
 * earlier turns to the model, so "explain what you said before" was answered by
 * a model that had never seen it. ADR-029 declared `conversationContext` on the
 * chat loop for exactly this; nothing filled it.
 *
 * This module turns the earlier tasks of a session into one prompt part. It is
 * pure - no database, no clock - so the budget rules are testable on their own.
 */

/** One earlier task in the same conversation, as read from `agent_tasks`. */
export interface ConversationTurn {
  readonly reference: string;
  readonly kind: 'change' | 'chat';
  readonly status: string;
  readonly prompt: string;
  readonly answer: string | null;
  readonly failureReason: string | null;
  /** A change task's approved plan summary, when it reached planning. */
  readonly planSummary: string | null;
  /** Repository paths a task changed, when it changed any. */
  readonly modifiedPaths: readonly string[];
}

export interface ConversationContextBudget {
  /** Total characters the rendered history may occupy. */
  readonly maxChars: number;
  /** Characters kept from one prompt before it is shortened. */
  readonly maxPromptChars: number;
  /** Characters kept from one answer before it is shortened. */
  readonly maxAnswerChars: number;
  /** Turns considered at most, newest first. */
  readonly maxTurns: number;
}

/**
 * Sized for a flash-class model's context alongside the system prompt, tool
 * schemas and tool results the loop accumulates. Roughly 6k tokens of history:
 * enough for a long conversation's recent turns, small enough that the tool
 * loop still has room to read files.
 */
export const DEFAULT_CONVERSATION_BUDGET: ConversationContextBudget = {
  maxChars: 24_000,
  maxPromptChars: 3_000,
  maxAnswerChars: 4_000,
  maxTurns: 20,
};

export const CONVERSATION_CONTEXT_LABEL = 'Earlier in this conversation (oldest first)';

/**
 * Renders earlier turns as a single prompt part, or returns an empty list when
 * there are none.
 *
 * Newest turns win when the budget is short: the turn a person is most likely
 * referring to is the last one. Dropped turns are counted in the part itself so
 * the model can say it no longer has them rather than inventing them.
 */
export function buildConversationContext(
  turns: readonly ConversationTurn[],
  budget: ConversationContextBudget = DEFAULT_CONVERSATION_BUDGET,
): PromptPart[] {
  if (turns.length === 0) return [];

  const considered = turns.slice(-budget.maxTurns);
  let omitted = turns.length - considered.length;

  const rendered: string[] = [];
  let used = 0;

  // Walk newest to oldest so the budget is spent on the recent turns.
  for (let index = considered.length - 1; index >= 0; index -= 1) {
    const block = renderTurn(considered[index], considered.length - index, budget);
    if (rendered.length > 0 && used + block.length > budget.maxChars) {
      omitted += index + 1;
      break;
    }
    rendered.unshift(block);
    used += block.length;
  }

  const header = [
    'These are the earlier messages in this same conversation, with the answers',
    'that were given. Use them when the current message refers back to them.',
    ...(omitted > 0
      ? [`${omitted} older message(s) are not included here because of length.`]
      : []),
  ].join('\n');

  return [
    {
      label: CONVERSATION_CONTEXT_LABEL,
      content: `${header}\n\n${rendered.join('\n\n')}`,
      untrusted: false,
    },
  ];
}

function renderTurn(
  turn: ConversationTurn,
  _positionFromEnd: number,
  budget: ConversationContextBudget,
): string {
  const lines = [
    `### ${turn.reference} (${turn.kind === 'chat' ? 'question' : 'change request'}, ${turn.status.replace(/_/g, ' ')})`,
    `User: ${shorten(turn.prompt.trim(), budget.maxPromptChars)}`,
  ];

  if (turn.planSummary?.trim()) {
    lines.push(`Plan: ${shorten(turn.planSummary.trim(), budget.maxAnswerChars)}`);
  }

  if (turn.answer?.trim()) {
    lines.push(`Assistant: ${shorten(turn.answer.trim(), budget.maxAnswerChars)}`);
  } else if (turn.failureReason?.trim()) {
    lines.push(`Outcome: failed - ${shorten(turn.failureReason.trim(), 600)}`);
  } else {
    lines.push('Assistant: (no answer recorded - the request was still running or produced none)');
  }

  if (turn.modifiedPaths.length > 0) {
    const shown = turn.modifiedPaths.slice(0, 15);
    const more = turn.modifiedPaths.length - shown.length;
    lines.push(`Files changed: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
  }

  return lines.join('\n');
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} … [shortened, ${text.length - max} more characters]`;
}
