import {
  buildProjectHistory,
  DEFAULT_PROJECT_HISTORY_BUDGET,
  PROJECT_HISTORY_LABEL,
  type ProjectHistory,
  type ProjectHistoryTask,
} from './project-history';

/**
 * ADR-080: a request sees the project's earlier requests, across conversations.
 *
 * The defect this pins: a request typed into a new conversation reached the
 * model with only the conversation's own earlier turns (ADR-074), so "summarise
 * everything discussed in this project" was answered with "no earlier
 * conversation is recorded" while the portal listed several.
 */

function task(overrides: Partial<ProjectHistoryTask> = {}): ProjectHistoryTask {
  return {
    reference: 'task_1',
    kind: 'chat',
    status: 'completed',
    sessionId: 'session-1',
    sessionTitle: 'Delivery KPI',
    createdAt: '2026-10-14T13:45:00.000Z',
    prompt: 'What report shows completed trip sheets?',
    answer: 'There is no report yet; the data lives in trip.sheet.',
    failureReason: null,
    planSummary: null,
    modifiedPaths: [],
    commitHash: null,
    ...overrides,
  };
}

function history(tasks: ProjectHistoryTask[], overrides: Partial<ProjectHistory> = {}): ProjectHistory {
  return {
    tasks,
    totalTasks: tasks.length,
    conversationCount: new Set(tasks.map((entry) => entry.sessionId)).size,
    ...overrides,
  };
}

describe('buildProjectHistory (ADR-080)', () => {
  it('renders nothing when the project has no other request', () => {
    expect(buildProjectHistory(history([]))).toEqual([]);
  });

  it('renders one part labelled as earlier conversations, not as untrusted data', () => {
    const [part] = buildProjectHistory(history([task()]));

    expect(part.label).toBe(PROJECT_HISTORY_LABEL);
    expect(part.untrusted).toBe(false);
  });

  it('says how much the project holds and which conversation a request belongs to', () => {
    const [part] = buildProjectHistory(
      history([task(), task({ reference: 'task_2', status: 'failed', failureReason: 'push was refused' })], {
        totalTasks: 9,
        conversationCount: 3,
      }),
    );

    expect(part.content).toContain('9 request(s) in 3 conversation(s)');
    expect(part.content).toContain('"Delivery KPI"');
    expect(part.content).toContain('task_1');
    expect(part.content).toContain('task_2');
  });

  it('shows a change request with its commit and files, so success and failure are distinguishable', () => {
    const [part] = buildProjectHistory(
      history([
        task({
          reference: 'task_976297',
          kind: 'change',
          status: 'failed',
          prompt: 'Buat devtask untuk trip KPI',
          answer: 'Dev task written.',
          failureReason: 'git push refused: non-fast-forward',
          modifiedPaths: ['linkederp_dashboard_api/docs/delivery-trip-kpi-dev-task.md'],
          commitHash: '4e389b494ac6f2fc97af272ea4c8b4edf698ef02',
        }),
      ]),
    );

    expect(part.content).toContain('change request, failed');
    expect(part.content).toContain('committed: 4e389b494ac6');
    expect(part.content).toContain('delivery-trip-kpi-dev-task.md');
  });

  it('states the outcome as failed when there is no answer to show', () => {
    const [part] = buildProjectHistory(
      history([task({ answer: null, status: 'failed', failureReason: 'model returned no plan' })]),
    );

    expect(part.content).toContain('outcome: failed - model returned no plan');
  });

  it('never presents an unreadable outcome as an answer', () => {
    const [part] = buildProjectHistory(history([task({ answer: null, failureReason: null })]));

    expect(part.content).toContain('no answer recorded');
  });

  it('counts the requests it had to leave out instead of implying it saw everything', () => {
    const tasks = Array.from({ length: 6 }, (_, index) =>
      task({ reference: `task_${index}`, createdAt: `2026-10-1${index}T10:00:00.000Z` }),
    );

    const [part] = buildProjectHistory(history(tasks, { totalTasks: 30 }), {
      ...DEFAULT_PROJECT_HISTORY_BUDGET,
      maxTasks: 4,
    });

    expect(part.content).toContain('the 4 most recent are listed here and 26 older one(s) are not');
  });

  it('stops at the character budget rather than truncating a request mid-sentence', () => {
    const tasks = Array.from({ length: 5 }, (_, index) =>
      task({ reference: `task_${index}`, prompt: 'x'.repeat(400) }),
    );

    const [part] = buildProjectHistory(history(tasks), {
      ...DEFAULT_PROJECT_HISTORY_BUDGET,
      maxChars: 600,
      maxPromptChars: 400,
    });

    const listed = (part.content.match(/^- /gm) ?? []).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(5);
    expect(part.content).toContain('older one(s) are not');
  });

  it('marks a shortened prompt rather than silently cutting it', () => {
    const [part] = buildProjectHistory(history([task({ prompt: 'y'.repeat(500) })]), {
      ...DEFAULT_PROJECT_HISTORY_BUDGET,
      maxPromptChars: 50,
    });

    expect(part.content).toContain('[shortened, 450 more characters]');
  });
});
