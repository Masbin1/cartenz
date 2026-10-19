import type { PromptPart } from '../model/model-provider.interface';

/**
 * Project-wide memory (ADR-080).
 *
 * A conversation remembers its own earlier turns (ADR-074), but the context a
 * request needs is not always in the conversation it was typed into. A design
 * discussed on Tuesday is executed on Thursday from a new conversation, and the
 * agent answering Thursday's request has never seen Tuesday. The portal lists
 * every conversation of a project (ADR-047) and the data has always been there;
 * nothing carried it to the model.
 *
 * This module renders a bounded index of the project's requests, across every
 * conversation, as one prompt part. It is pure - no database, no clock - so the
 * budget rules are testable on their own. The index is deliberately an index:
 * enough of each request and its outcome to know that it exists and how it ended,
 * with `read_project_history` available when the full text is needed.
 */

/** One request in the project, as read from `agent_tasks`. */
export interface ProjectHistoryTask {
  readonly reference: string;
  readonly kind: 'change' | 'chat';
  readonly status: string;
  readonly sessionId: string | null;
  readonly sessionTitle: string | null;
  /** ISO timestamp of when the request was made. */
  readonly createdAt: string;
  readonly prompt: string;
  readonly answer: string | null;
  readonly failureReason: string | null;
  readonly planSummary: string | null;
  readonly modifiedPaths: readonly string[];
  readonly commitHash: string | null;
}

export interface ProjectHistory {
  /** The most recent requests, newest first. */
  readonly tasks: readonly ProjectHistoryTask[];
  /** Every request in the project, including those not listed. */
  readonly totalTasks: number;
  /** Every conversation in the project, including those not listed. */
  readonly conversationCount: number;
}

export interface ProjectHistoryBudget {
  /** Total characters the rendered index may occupy. */
  readonly maxChars: number;
  /** Characters kept from one request's prompt before it is shortened. */
  readonly maxPromptChars: number;
  /** Characters kept from one answer or failure before it is shortened. */
  readonly maxAnswerChars: number;
  /** Requests considered at most. */
  readonly maxTasks: number;
}

/**
 * Smaller than the conversation budget on purpose: this part is added to every
 * chat and every plan, so it must stay cheap for a request that has nothing to
 * do with history. Roughly 2.5k tokens - a project's recent shape, not its
 * transcript.
 */
export const DEFAULT_PROJECT_HISTORY_BUDGET: ProjectHistoryBudget = {
  maxChars: 10_000,
  maxPromptChars: 200,
  maxAnswerChars: 300,
  maxTasks: 40,
};

export const PROJECT_HISTORY_LABEL = 'Earlier conversations in this project (newest first)';

/**
 * Renders the project's requests as a single prompt part, or returns an empty
 * list when the project has none besides the current request.
 *
 * Newest first, because a project's recent work is what a new request is most
 * likely to continue. When the budget runs out the older requests are counted in
 * the part itself, so a model asked to summarise the whole project can say what
 * it cannot see instead of implying it saw everything.
 */
export function buildProjectHistory(
  history: ProjectHistory,
  budget: ProjectHistoryBudget = DEFAULT_PROJECT_HISTORY_BUDGET,
): PromptPart[] {
  if (history.tasks.length === 0) return [];

  const blocks: string[] = [];
  let used = 0;
  let listed = 0;

  for (const task of history.tasks) {
    if (listed >= budget.maxTasks) break;
    const block = renderTask(task, budget);
    if (blocks.length > 0 && used + block.length > budget.maxChars) break;
    blocks.push(block);
    used += block.length;
    listed += 1;
  }

  const omitted = history.totalTasks - listed;
  const header = [
    'These are earlier requests in this project, newest first, across every',
    'conversation - including conversations other than the one you are in now.',
    `The project has ${history.totalTasks} request(s) in ${history.conversationCount} conversation(s)` +
      `${omitted > 0 ? `; the ${listed} most recent are listed here and ${omitted} older one(s) are not` : ''}.`,
    'Use them when a request refers to work done earlier, and when asked what has',
    'been discussed, tried, changed or failed in this project. When the full text of',
    'a request is needed, call read_project_history with its reference or session id.',
  ].join('\n');

  return [
    {
      label: PROJECT_HISTORY_LABEL,
      content: `${header}\n\n${blocks.join('\n\n')}`,
      untrusted: false,
    },
  ];
}

function renderTask(task: ProjectHistoryTask, budget: ProjectHistoryBudget): string {
  const lines = [
    `- ${formatDate(task.createdAt)} - ${task.reference} (${task.kind === 'change' ? 'change request' : 'question'}, ${task.status.replace(/_/g, ' ')})` +
      `${task.sessionTitle ? ` in "${task.sessionTitle}"` : task.sessionId ? '' : ' outside a conversation'}`,
    `  asked: ${shorten(task.prompt.trim(), budget.maxPromptChars)}`,
  ];

  if (task.answer?.trim()) {
    lines.push(`  outcome: ${shorten(task.answer.trim(), budget.maxAnswerChars)}`);
  } else if (task.failureReason?.trim()) {
    lines.push(`  outcome: failed - ${shorten(task.failureReason.trim(), budget.maxAnswerChars)}`);
  } else {
    lines.push('  outcome: no answer recorded (still running, cancelled, or produced none)');
  }

  if (task.commitHash) {
    lines.push(`  committed: ${task.commitHash.slice(0, 12)}`);
  }

  if (task.modifiedPaths.length > 0) {
    const shown = task.modifiedPaths.slice(0, 5);
    const more = task.modifiedPaths.length - shown.length;
    lines.push(`  files: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
  }

  return lines.join('\n');
}

/** `19 Oct 2026 14:05`, in the platform's own timezone-free UTC form. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} … [shortened, ${text.length - max} more characters]`;
}
