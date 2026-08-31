'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { useTaskStream } from '@/lib/use-task-stream';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { Alert } from '@/components/ui/alert';
import { ActivityTimeline } from '@/components/agent/activity-timeline';
import { PlanView } from '@/components/agent/plan-view';
import { ApprovalPanel } from '@/components/agent/approval-panel';
import { TaskInspector } from '@/components/agent/task-inspector';
import { DiffViewer } from '@/components/diff/diff-viewer';
import { isActiveStatus, relativeTime } from '@/lib/format';
import { EnvironmentKindBadge } from '@/components/projects/environment-editor';
import type {
  AgentCapabilities,
  ProjectDetail,
  ProjectEnvironment,
  TaskDetail,
  TaskDiff,
  TaskSummary,
} from '@/lib/types';

const DECIDER_ROLES = ['owner', 'admin', 'developer'];

/**
 * The AI agent workspace: the primary working surface of the platform.
 *
 * Three panes, as the product requires. Left is project context and task
 * history; centre is the prompt, the agent activity stream and the plan; right is
 * the task's status, its file changes and its test results.
 *
 * The centre pane is not a chat window. A prompt creates a task, and what follows
 * is a development run with states, tool calls and approval gates - so the
 * interface shows a run, not a conversation.
 */
export default function AgentWorkspacePage() {
  const { loading, user, organization } = useRequireAuth();
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    searchParams.get('task'),
  );
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [environmentId, setEnvironmentId] = useState<string>('');
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);

  const { events, connected } = useTaskStream(selectedTaskId);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const canDecide = DECIDER_ROLES.includes(organization?.role ?? '');

  const selectedEnvironment = environments.find((entry) => entry.id === environmentId) ?? null;
  const productionEnvironments = environments.filter((entry) => entry.kind === 'production');

  const loadProject = useCallback(async () => {
    try {
      const [detail, taskList, environmentList] = await Promise.all([
        api.projects.get(projectId),
        api.tasks.listForProject(projectId),
        api.projects.environments(projectId),
      ]);
      setProject(detail);
      setTasks(taskList);
      setSelectedTaskId((current) => current ?? taskList[0]?.id ?? null);

      // Production environments are listed but never selectable: the server
      // refuses them, and offering one would only produce a refusal.
      const targetable = environmentList.filter((entry) => entry.kind !== 'production');
      setEnvironments(environmentList);
      setEnvironmentId(
        (current) =>
          current ||
          targetable.find((entry) => entry.isDefaultTarget)?.id ||
          targetable[0]?.id ||
          '',
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The project could not be loaded.');
    }
  }, [projectId]);

  useEffect(() => {
    void api.agent
      .capabilities()
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
  }, []);

  const loadTask = useCallback(async (taskId: string) => {
    try {
      setTask(await api.tasks.get(taskId));
    } catch {
      setTask(null);
    }
  }, []);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    if (selectedTaskId) void loadTask(selectedTaskId);
    else setTask(null);
    // The diff belongs to the previously selected task, so it is cleared rather
    // than shown against a different one.
    setDiff(null);
    setDiffOpen(false);
  }, [selectedTaskId, loadTask]);

  /**
   * The patch is fetched once, when the task reports one exists.
   *
   * Deliberately not part of the task detail: the detail is re-fetched on every
   * realtime event, and a quarter-megabyte patch on each would be wasteful.
   */
  useEffect(() => {
    if (!selectedTaskId || !task?.hasDiff || diff !== null) return;

    let cancelled = false;
    void api.tasks
      .diff(selectedTaskId)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, task?.hasDiff, diff]);

  /**
   * The event stream tells the workspace when to re-read the task. Rather than
   * polling on a timer, the arrival of an event is the trigger, so the panes
   * update as the run progresses and go quiet when it settles.
   */
  const latestSequence = events.length > 0 ? events[events.length - 1].sequence : 0;
  useEffect(() => {
    if (!selectedTaskId || latestSequence === 0) return;
    void loadTask(selectedTaskId);
    void api.tasks.listForProject(projectId).then(setTasks);
  }, [latestSequence, selectedTaskId, projectId, loadTask]);

  const submitPrompt = async (event: React.FormEvent) => {
    event.preventDefault();
    if (prompt.trim().length < 10) {
      setError('Describe the change in at least 10 characters.');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const created = await api.tasks.create(projectId, {
        prompt: prompt.trim(),
        environmentId: environmentId || undefined,
      });
      setPrompt('');
      setSelectedTaskId(created.id);
      router.replace(`/projects/${projectId}/agent?task=${created.id}`);
      setTasks(await api.tasks.listForProject(projectId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The task could not be created.');
    } finally {
      setSubmitting(false);
      promptRef.current?.focus();
    }
  };

  const decide = async (decision: 'approved' | 'rejected', note?: string) => {
    if (!selectedTaskId) return;
    try {
      await api.approvals.decide(selectedTaskId, decision, note);
      await loadTask(selectedTaskId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The decision could not be recorded.');
    }
  };

  const cancel = async () => {
    if (!selectedTaskId) return;
    try {
      await api.tasks.cancel(selectedTaskId, 'Cancelled from the agent workspace');
      await loadTask(selectedTaskId);
      setTasks(await api.tasks.listForProject(projectId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The task could not be cancelled.');
    }
  };

  const active = useMemo(() => (task ? isActiveStatus(task.status) : false), [task]);

  if (loading || !user) return <PageLoading />;
  if (!project) return <PageLoading label="Loading workspace" />;

  return (
    <AppShell>
      <div className="mx-auto grid max-w-[1600px] gap-4 px-5 py-5 lg:grid-cols-[260px_minmax(0,1fr)_320px]">
        {/* LEFT: project context and task history */}
        <aside className="space-y-4">
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Project</h2>
              <Link
                href={`/projects/${project.id}`}
                className="text-2xs text-accent hover:underline"
              >
                Detail
              </Link>
            </div>
            <div className="px-4 py-3">
              <p className="truncate text-sm font-semibold">{project.name}</p>
              <dl className="mt-2.5 space-y-1 text-2xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-content-subtle">Odoo</dt>
                  <dd>{project.odooVersion ?? 'Not set'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-content-subtle">Base branch</dt>
                  <dd className="font-mono">{project.defaultBranch}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-content-subtle">Repository</dt>
                  <dd>{project.repositoryUrl ? 'Connected' : 'None'}</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Task history</h2>
              <span className="text-2xs text-content-subtle">{tasks.length}</span>
            </div>
            {tasks.length === 0 ? (
              <p className="px-4 py-5 text-2xs text-content-subtle">
                No tasks yet. Submit a prompt to create the first.
              </p>
            ) : (
              <ul className="max-h-[52vh] divide-y divide-surface-border overflow-y-auto">
                {tasks.map((entry) => {
                  const selected = entry.id === selectedTaskId;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTaskId(entry.id);
                          router.replace(`/projects/${projectId}/agent?task=${entry.id}`);
                        }}
                        className={`w-full px-3.5 py-2.5 text-left transition-colors ${
                          selected ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/60'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="line-clamp-2 text-2xs leading-relaxed">
                            {entry.prompt}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <span className="font-mono text-2xs text-content-subtle">
                            {entry.reference}
                          </span>
                          <StatusBadge status={entry.status} />
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* CENTRE: prompt, agent activity, plan */}
        <section className="space-y-4">
          <form onSubmit={submitPrompt} className="panel p-4">
            <label htmlFor="prompt" className="panel-title mb-2 block">
              Development request
            </label>
            <textarea
              id="prompt"
              ref={promptRef}
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                // Submit on Ctrl/Cmd+Enter: the field is multi-line, so Enter
                // must insert a newline rather than sending.
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  void submitPrompt(event as unknown as React.FormEvent);
                }
              }}
              placeholder="Add a customer reference field to Sales Order and Invoice."
              className="field-input resize-none"
            />
            {environments.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label htmlFor="environment" className="text-2xs text-content-subtle">
                  Target
                </label>
                <select
                  id="environment"
                  value={environmentId}
                  onChange={(event) => setEnvironmentId(event.target.value)}
                  disabled={submitting}
                  className="field-input w-auto py-1 text-xs"
                >
                  {environments
                    .filter((environment) => environment.kind !== 'production')
                    .map((environment) => (
                      <option key={environment.id} value={environment.id}>
                        {environment.name} ({environment.branch})
                      </option>
                    ))}
                </select>
                {selectedEnvironment ? (
                  <EnvironmentKindBadge kind={selectedEnvironment.kind} />
                ) : null}
                {productionEnvironments.length > 0 ? (
                  <span className="text-2xs text-content-subtle">
                    {productionEnvironments.map((environment) => environment.branch).join(', ')} is
                    production and cannot be targeted.
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-2xs text-content-subtle">
                The agent analyses the project, produces a plan and waits for your approval before
                changing anything.
                {capabilities && !capabilities.git.pushEnabled
                  ? ' This server cannot push: the branch stays in the workspace for you to review.'
                  : null}
              </p>
              <button type="submit" disabled={submitting} className="btn-primary shrink-0">
                {submitting ? <Spinner /> : null}
                {submitting ? 'Submitting' : 'Submit request'}
              </button>
            </div>
          </form>

          {error ? <Alert tone="error">{error}</Alert> : null}

          {task?.pendingApproval ? (
            <ApprovalPanel
              approval={task.pendingApproval}
              onDecide={decide}
              canDecide={canDecide}
            />
          ) : null}

          <div className="panel">
            <div className="panel-header">
              <div className="flex items-center gap-2.5">
                <h2 className="panel-title">Agent activity</h2>
                {task ? (
                  <span className="font-mono text-2xs text-content-subtle">{task.reference}</span>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5 text-2xs text-content-subtle">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      connected ? 'bg-state-success' : 'bg-state-idle'
                    }`}
                  />
                  {connected ? 'Live' : 'Offline'}
                </span>
                {task && active ? (
                  <button type="button" onClick={() => void cancel()} className="btn-ghost px-2 py-1 text-2xs">
                    Cancel task
                  </button>
                ) : null}
              </div>
            </div>
            <div className="max-h-[46vh] overflow-y-auto">
              <ActivityTimeline events={events} />
            </div>
          </div>

          {task?.hasDiff ? (
            <div className="panel">
              <div className="panel-header">
                <div className="flex items-center gap-2.5">
                  <h2 className="panel-title">Review diff</h2>
                  {task.diffStats ? (
                    <span className="font-mono text-2xs">
                      <span className="text-content-subtle">
                        {task.diffStats.filesChanged} file
                        {task.diffStats.filesChanged === 1 ? '' : 's'}
                      </span>{' '}
                      <span className="text-state-success">+{task.diffStats.linesAdded}</span>{' '}
                      <span className="text-state-failure">-{task.diffStats.linesRemoved}</span>
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setDiffOpen((open) => !open)}
                  className="btn-ghost px-2 py-1 text-2xs"
                >
                  {diffOpen ? 'Hide' : 'Show'}
                </button>
              </div>

              {diffOpen ? (
                <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
                  {diff === null ? (
                    <p className="py-6 text-center text-xs text-content-subtle">Loading the diff</p>
                  ) : diff.patch ? (
                    <>
                      <p className="mb-3 font-mono text-2xs text-content-subtle">
                        {diff.branch} against {diff.baseCommit?.slice(0, 12)}
                      </p>
                      <DiffViewer
                        patch={diff.patch}
                        truncated={diff.stats?.patchTruncated ?? false}
                      />
                    </>
                  ) : (
                    <p className="py-6 text-center text-xs text-content-subtle">
                      No diff was recorded for this task.
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {task?.plan ? <PlanView plan={task.plan} /> : null}
        </section>

        {/* RIGHT: task status, files, tests, approvals */}
        <aside>
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Task</h2>
              {task ? (
                <span className="text-2xs text-content-subtle">
                  {relativeTime(task.createdAt)}
                </span>
              ) : null}
            </div>
            <TaskInspector task={task} />
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
