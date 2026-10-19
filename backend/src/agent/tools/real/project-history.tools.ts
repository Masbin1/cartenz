import { Injectable } from '@nestjs/common';
import { TaskRepository } from '../../task-repository';
import type { AnyToolDefinition, ToolDefinition, ToolExecutionContext } from '../tool.interface';

/**
 * Project-wide memory, on demand (ADR-080).
 *
 * The prompt carries an index of the project's recent requests; this tool is how
 * a model reads a request in full when the index is not enough - "what exactly
 * did we decide about the trip KPI", "show me everything in that conversation".
 * It reads only the platform's own task record for the project it is already
 * working on, so it leaves nothing and needs no approval.
 *
 * The limits are the tool's own, not the caller's: a model that asks for a
 * hundred requests gets twenty short ones, because the answer is going straight
 * back into the same context the index was trying to protect.
 */

/** Request bodies are shortened to this before they are returned. */
const MAX_PROMPT_CHARS = 2_000;
/** Answers are shortened to this before they are returned. */
const MAX_ANSWER_CHARS = 6_000;
/** Requests returned at most, per call. */
const MAX_TASKS = 20;
/** Total characters of request and answer text returned at most, per call. */
const MAX_TOTAL_CHARS = 40_000;

interface ProjectHistoryInput extends Record<string, unknown> {
  readonly reference?: string;
  readonly sessionId?: string;
  readonly limit?: number;
}

@Injectable()
export class ProjectHistoryTools {
  constructor(private readonly tasks: TaskRepository) {}

  get definitions(): readonly AnyToolDefinition[] {
    return [this.readProjectHistory];
  }

  private readonly readProjectHistory: ToolDefinition<ProjectHistoryInput> = {
    name: 'read_project_history',
    description:
      'Read earlier requests and answers from this project, across every conversation, including conversations other than this one. Use it when the request refers to work done before, or when asked what has been discussed, tried, changed or failed in the project.',
    permission: 'project_history_read',
    leavesPlatform: false,
    simulated: false,
    availableToModel: true,
    parameters: {
      type: 'object',
      properties: {
        reference: {
          type: 'string',
          description:
            'One request to read in full, e.g. task_976297. Omit to read the most recent requests.',
        },
        sessionId: {
          type: 'string',
          description:
            'Read one conversation (session) only, when its id is known from the project history index.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TASKS,
          description: `How many requests to return, newest first. Defaults to 10, at most ${MAX_TASKS}.`,
        },
      },
      additionalProperties: false,
    },

    validate(input: unknown): string | null {
      if (typeof input !== 'object' || input === null) return 'input must be an object';
      const value = input as ProjectHistoryInput;

      if (value.reference !== undefined) {
        if (typeof value.reference !== 'string' || value.reference.trim().length === 0) {
          return 'reference must be a non-empty string';
        }
        if (value.reference.length > 100) return 'reference is too long';
      }

      if (value.sessionId !== undefined) {
        if (typeof value.sessionId !== 'string' || value.sessionId.trim().length === 0) {
          return 'sessionId must be a non-empty string';
        }
        if (value.sessionId.length > 100) return 'sessionId is too long';
      }

      if (value.limit !== undefined) {
        if (typeof value.limit !== 'number' || !Number.isInteger(value.limit)) {
          return 'limit must be an integer';
        }
        if (value.limit < 1 || value.limit > MAX_TASKS) {
          return `limit must be between 1 and ${MAX_TASKS}`;
        }
      }

      return null;
    },

    execute: async (input: ProjectHistoryInput, context: ToolExecutionContext) => {
      const limit = input.limit ?? 10;
      const rows = await this.tasks.loadProjectHistory(context.projectId, {
        excludeTaskId: context.taskId,
        limit,
        ...(input.reference ? { reference: input.reference.trim() } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId.trim() } : {}),
      });

      const counts = await this.tasks.countProjectHistory(context.projectId);

      let spent = 0;
      const tasks = [];
      for (const row of rows) {
        if (spent >= MAX_TOTAL_CHARS) break;
        const prompt = shorten(row.prompt.trim(), MAX_PROMPT_CHARS);
        const answer = row.answer?.trim() ? shorten(row.answer.trim(), MAX_ANSWER_CHARS) : null;
        spent += prompt.length + (answer?.length ?? 0);

        tasks.push({
          reference: row.reference,
          kind: row.kind,
          status: row.status,
          sessionId: row.sessionId,
          sessionTitle: row.sessionTitle,
          createdAt: row.createdAt,
          prompt,
          answer,
          failureReason: row.failureReason,
          planSummary: row.planSummary,
          modifiedPaths: row.modifiedPaths,
          commitHash: row.commitHash,
        });
      }

      return {
        tasks,
        returned: tasks.length,
        projectTasks: counts.tasks,
        projectConversations: counts.conversations,
        truncated: tasks.length < rows.length,
        ...(rows.length === 0
          ? { note: 'No earlier request in this project matched. The project has no history besides the current request.' }
          : {}),
      };
    },
  };
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} … [shortened, ${text.length - max} more characters]`;
}
