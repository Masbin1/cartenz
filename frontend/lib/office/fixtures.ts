import type {
  AgentTaskStatus,
  AiOfficeAttentionItem,
  AiOfficeBoard,
  AiOfficeCard,
  AiOfficeFinishedCard,
  AiOfficeQueue,
  TaskEvent,
} from '@/lib/types';
import { phaseFor } from './status';

/**
 * Test fixtures shaped exactly like the API responses. Every field the
 * backend returns is present, so a test cannot pass by leaning on a field the
 * real payload lacks.
 */

let counter = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const PROJECT_MAHA = { projectId: uuid(9001), projectName: 'MAHA' };
export const PROJECT_OMNI = { projectId: uuid(9002), projectName: 'Omnisurge' };

export function card(status: AgentTaskStatus, overrides: Partial<AiOfficeCard> = {}): AiOfficeCard {
  counter += 1;
  return {
    taskId: uuid(counter),
    taskReference: `TASK-${counter}`,
    ...PROJECT_MAHA,
    prompt: `Create a sale approval module for request ${counter}`,
    status,
    phase: phaseFor(status),
    progress: 0.5,
    currentAction: null,
    startedAt: '2026-09-26T02:00:00.000Z',
    updatedAt: '2026-09-26T02:05:00.000Z',
    ...overrides,
  };
}

export function finished(
  status: 'completed' | 'failed' | 'cancelled',
  overrides: Partial<AiOfficeFinishedCard> = {},
): AiOfficeFinishedCard {
  counter += 1;
  return {
    taskId: uuid(counter),
    taskReference: `TASK-${counter}`,
    ...PROJECT_OMNI,
    prompt: `Finished request ${counter}`,
    status,
    endedAt: '2026-09-26T01:00:00.000Z',
    ...overrides,
  };
}

export function board(
  cards: AiOfficeCard[],
  recent: AiOfficeFinishedCard[] = [],
  summary: Partial<AiOfficeBoard['summary']> = {},
): AiOfficeBoard {
  return {
    cards,
    recent,
    summary: {
      live: cards.length,
      needsAttention: cards.filter((c) => c.status === 'waiting_approval').length,
      completedToday: 0,
      failedToday: 0,
      ...summary,
    },
  };
}

export function queue(overrides: Partial<AiOfficeQueue> = {}): AiOfficeQueue {
  return { waiting: [], capacity: 2, running: 0, ...overrides };
}

export function approval(
  forCard: AiOfficeCard,
  overrides: Partial<AiOfficeAttentionItem> = {},
): AiOfficeAttentionItem {
  counter += 1;
  return {
    approvalId: uuid(counter),
    taskId: forCard.taskId,
    taskReference: forCard.taskReference,
    projectId: forCard.projectId,
    projectName: forCard.projectName,
    action: 'git_push',
    requiredReason: 'Pushing to the customer repository needs a human.',
    requestedAt: '2026-09-26T02:06:00.000Z',
    ...overrides,
  };
}

let sequence = 0;
export function event(
  taskId: string,
  type: TaskEvent['type'],
  taskStatus: AgentTaskStatus,
  overrides: Partial<TaskEvent> = {},
): TaskEvent {
  sequence += 1;
  return {
    taskId,
    taskReference: 'TASK-X',
    sequence,
    type,
    status: 'running',
    taskStatus,
    message: 'the agent narrates its reasoning here, which must never be rendered',
    at: '2026-09-26T02:10:00.000Z',
    ...overrides,
  };
}
