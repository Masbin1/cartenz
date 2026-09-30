'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  CircleCheckBig,
  Hand,
  RefreshCw,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { useOffice } from '@/lib/use-office';
import { AppShell } from '@/components/ui/app-shell';
import { PageHeader } from '@/components/ui/page';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AgentFigure } from '@/components/ai-office/agent-figure';
import { OfficeCanvas } from '@/components/ai-office/office-canvas';
import { OfficeFilterBar } from '@/components/ai-office/office-filter-bar';
import { OfficeLegend, OfficeEmptyNote } from '@/components/ai-office/office-legend';
import { OfficeMobileList } from '@/components/ai-office/office-mobile-list';
import { humanise, relativeTime } from '@/lib/format';
import {
  NO_FILTERS,
  activityInScope,
  buildOfficeModel,
  mobileAgents,
  projectsOnFloor,
  type OfficeAgent,
  type OfficeFilters,
} from '@/lib/office/model';
import type { AiOfficeActivityItem, AiOfficeAttentionItem } from '@/lib/types';

/**
 * Cartenz AI Office: a live spatial view of the actual `agent_tasks` load
 * (docs/AI-OFFICE-PRD-draft.md, ADR-066, and the visualization dev task on top
 * of it).
 *
 * The rule this page exists to keep, stated once so every component built for
 * it can point back here: a figure on the floor is a task that exists right
 * now, its pose and room are that task's real status, and nothing on the floor
 * moves without a row in `agent_tasks` behind it. Cartenz runs one agent
 * through a fixed state machine per task (ADR-018); there is no multi-agent
 * registry to draw, so a figure is named by its work (project + task
 * reference), not by an invented persona, and the dispatch node in the middle
 * of the floor is the real worker pool, not an orchestrator that does not
 * exist in this system.
 *
 * `lib/office/model.ts` turns the API's read models into that floor; this
 * file only lays the page out and wires the toolbar.
 */
export default function AiOfficePage() {
  const { loading, user } = useRequireAuth();
  const { state, refresh, loadMoreActivity } = useOffice();
  const [selected, setSelected] = useState<OfficeAgent | null>(null);
  const [filters, setFilters] = useState<OfficeFilters>(NO_FILTERS);
  const [busy, setBusy] = useState(false);
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setIsCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const model = useMemo(
    () =>
      buildOfficeModel({
        board: state.board,
        attention: state.attention,
        queue: state.queue,
        activity: state.activity,
        live: state.connection === 'live',
        movedTaskIds: state.movedTaskIds,
      }),
    [
      state.attention,
      state.board,
      state.connection,
      state.movedTaskIds,
      state.queue,
      state.activity,
    ],
  );

  const projects = useMemo(() => projectsOnFloor(model.agents), [model.agents]);
  const scopedActivity = useMemo(
    () => activityInScope(model.activity, filters),
    [model.activity, filters],
  );
  const mobileList = useMemo(() => mobileAgents(model, filters), [model, filters]);

  if (loading || !user) return <PageLoading label="Loading your session" />;

  const loadingBoard = model.status === 'loading';

  return (
    <AppShell>
      <div className="page">
        <PageHeader
          title="AI Office"
          description="Every task running across your projects, shown as a live floor. One figure is one task that exists right now."
          actions={
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setBusy(true);
                void refresh().finally(() => setBusy(false));
              }}
              disabled={busy}
            >
              {busy ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <RefreshCw className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              )}
              Refresh
            </button>
          }
          meta={
            <>
              <ConnectionIndicator connection={state.connection} />
              <span className="text-meta text-content-subtle">
                {state.loadedAt
                  ? `Read at ${state.loadedAt.toLocaleTimeString()}`
                  : 'Reading the board'}
              </span>
            </>
          }
        />

        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Metric
              label="Working now"
              hint={`${model.orchestrator.busy} of ${model.orchestrator.capacity || '—'} workers busy`}
              value={loadingBoard ? undefined : model.totals.running + model.totals.waiting}
              icon={Users}
            />
            <Metric
              label="Waiting on you"
              hint={model.totals.approval > 0 ? 'Paused for a decision' : 'Nothing waiting'}
              value={loadingBoard ? undefined : model.totals.approval}
              icon={Hand}
              highlight={model.totals.approval > 0}
            />
            <Metric
              label="Completed today"
              hint="Since midnight"
              value={loadingBoard ? undefined : model.totals.completedToday}
              icon={CircleCheckBig}
            />
            <Metric
              label="Failed today"
              hint="Since midnight"
              value={loadingBoard ? undefined : model.totals.failedToday}
              icon={TriangleAlert}
              tone={model.totals.failedToday > 0 ? 'failure' : undefined}
            />
          </dl>

          {state.error ? (
            <p className="rounded-card border border-state-waiting/40 bg-state-waiting/5 px-4 py-2.5 text-callout text-state-waiting">
              {state.error} Showing the last known floor.
            </p>
          ) : null}

          {model.totals.approval > 0 ? <AttentionQueue items={state.attention} /> : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <OfficeFilterBar filters={filters} onChange={setFilters} projects={projects} />
            <OfficeLegend />
          </div>

          {loadingBoard ? (
            <Skeleton className="h-[420px] w-full rounded-card" />
          ) : isCompact ? (
            <OfficeMobileList agents={mobileList} onSelect={setSelected} />
          ) : (
            <OfficeCanvas
              model={model}
              filters={filters}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          )}

          {!loadingBoard && model.status === 'empty' ? (
            <OfficeEmptyNote onGoToProjects={() => (window.location.href = '/projects')} />
          ) : null}

          {!loadingBoard && model.recent.length > 0 ? (
            <RecentlyFinished agents={model.recent} />
          ) : null}

          <ActivityFeed
            items={scopedActivity}
            loading={loadingBoard}
            hasMore={state.hasMoreActivity && filters.projectId === 'all'}
            onMore={loadMoreActivity}
          />
        </div>
      </div>

      {selected ? <TaskDrawer agent={selected} onClose={() => setSelected(null)} /> : null}
    </AppShell>
  );
}

function ConnectionIndicator({ connection }: { connection: string }) {
  const live = connection === 'live';
  const label =
    connection === 'live'
      ? 'Live'
      : connection === 'synchronizing'
        ? 'Synchronizing...'
        : connection === 'reconnecting'
          ? 'Reconnecting to AI Office...'
          : 'Connecting...';

  return (
    <span className="inline-flex items-center gap-2 text-meta text-content-muted">
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span
          className={`absolute inline-flex h-full w-full rounded-full ${
            live ? 'animate-ping bg-state-success/60' : 'bg-state-idle/50'
          }`}
        />
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${
            live ? 'bg-state-success' : 'bg-state-idle'
          }`}
        />
      </span>
      {label}
    </span>
  );
}

function RecentlyFinished({ agents }: { agents: OfficeAgent[] }) {
  return (
    <section className="overflow-hidden rounded-card border border-surface-border bg-surface-raised">
      <div className="flex items-center gap-3 border-b border-surface-border px-5 py-4">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-state-success/10 text-state-success"
          aria-hidden="true"
        >
          <CircleCheckBig className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <h2 className="min-w-0 flex-1 text-headline text-content">Just finished</h2>
        <span className="text-meta text-content-subtle">Last 3 hours</span>
      </div>
      <ul className="grid grid-cols-2 gap-px bg-surface-border sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {agents.map((agent, index) => (
          <li
            key={agent.id}
            className="office-recent-item bg-surface-raised"
            style={{ animationDelay: `${index * 40}ms` }}
          >
            <Link
              href={`/projects/${agent.projectId}/agent?task=${agent.taskId}`}
              className="flex h-full flex-col items-center gap-2 px-3 py-4 text-center transition-colors hover:bg-surface-overlay/60"
            >
              <AgentFigure taskId={agent.taskId} status={agent.taskStatus} size={64} />
              <div className="min-w-0 max-w-full">
                <p className="truncate text-meta font-medium text-content">{agent.projectName}</p>
                <p className="mt-0.5 line-clamp-2 text-caption text-content-subtle">
                  {agent.taskTitle}
                </p>
                <p className="mt-1 text-caption tabular-nums text-content-subtle">
                  {humanise(agent.taskStatus)} · {relativeTime(agent.updatedAt)}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AttentionQueue({ items }: { items: AiOfficeAttentionItem[] }) {
  return (
    <section className="overflow-hidden rounded-card border border-state-waiting/40 bg-surface-raised">
      <div className="flex items-center gap-3 border-b border-surface-border px-5 py-4 sm:px-6">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-state-waiting/10 text-state-waiting"
          aria-hidden="true"
        >
          <Hand className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <h2 className="min-w-0 flex-1 text-headline text-content">Waiting on you</h2>
        <span className="rounded-full bg-state-waiting/10 px-2.5 py-0.5 text-meta font-semibold tabular-nums text-state-waiting">
          {items.length}
        </span>
      </div>
      <ul className="divide-y divide-surface-border">
        {items.map((item) => (
          <li
            key={item.approvalId}
            className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-6"
          >
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium text-content">{humanise(item.action)}</p>
              <p className="mt-0.5 text-callout text-content-muted">{item.requiredReason}</p>
              <p className="mt-1.5 text-meta text-content-subtle">
                {item.projectName}
                {' · '}
                <span className="font-mono text-caption">{item.taskReference}</span>
                {' · '}
                {relativeTime(item.requestedAt)}
              </p>
            </div>
            <Link
              href={`/projects/${item.projectId}/agent?task=${item.taskId}`}
              className="btn-primary btn-sm shrink-0 self-start sm:self-auto"
            >
              Review
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActivityFeed({
  items,
  loading,
  hasMore,
  onMore,
}: {
  items: AiOfficeActivityItem[];
  loading: boolean;
  hasMore: boolean;
  onMore: () => Promise<void>;
}) {
  const [loadingMore, setLoadingMore] = useState(false);

  return (
    <section className="overflow-hidden rounded-card border border-surface-border bg-surface-raised">
      <div className="flex items-center gap-3 border-b border-surface-border px-5 py-4">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-state-running/10 text-state-running"
          aria-hidden="true"
        >
          <Activity className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <h2 className="min-w-0 flex-1 text-headline text-content">Activity</h2>
      </div>

      {loading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-5 w-3/5" />
        </div>
      ) : items.length === 0 ? (
        <p className="px-5 py-6 text-callout text-content-subtle">Nothing recorded yet.</p>
      ) : (
        <>
          <ul className="divide-y divide-surface-border">
            {items.map((item) => (
              <li key={item.id} className="office-feed-item flex items-start gap-3 px-5 py-2.5">
                <span
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${feedDot(item.status)}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-callout text-content">
                    {item.summary ?? humanise(item.actionType)}
                  </p>
                  <p className="mt-0.5 text-meta text-content-subtle">
                    {item.projectName}
                    {' · '}
                    <Link
                      href={`/projects/${item.projectId}/agent?task=${item.taskId}`}
                      className="font-mono text-caption hover:text-content"
                    >
                      {item.taskReference}
                    </Link>
                    {' · '}
                    {relativeTime(item.at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {hasMore ? (
            <div className="border-t border-surface-border px-5 py-3">
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void onMore().finally(() => setLoadingMore(false));
                }}
              >
                {loadingMore ? <Spinner className="h-4 w-4" /> : null}
                Older activity
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function feedDot(status: string): string {
  if (status === 'failed') return 'bg-state-failure';
  if (status === 'denied') return 'bg-state-waiting';
  if (status === 'running') return 'bg-state-running';
  return 'bg-state-success';
}

/** The agent, in full, without leaving the floor (section 17). */
function TaskDrawer({ agent, onClose }: { agent: OfficeAgent; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Task detail"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 animate-fade-in bg-black/30 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-[22rem] max-w-[90vw] animate-slide-in flex-col border-l border-surface-border bg-surface">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4">
          <h2 className="text-headline text-content">Task</h2>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div className="flex items-center gap-4">
            <AgentFigure taskId={agent.taskId} status={agent.taskStatus} size={72} />
            <div className="min-w-0">
              <p className="text-callout font-medium text-content">{agent.projectName}</p>
              <p className="mt-0.5 font-mono text-caption text-content-subtle">
                {agent.taskReference}
              </p>
              <div className="mt-1.5">
                <StatusBadge status={agent.taskStatus} size="small" />
              </div>
            </div>
          </div>

          {agent.approval ? (
            <div className="rounded-card border border-state-waiting/40 bg-state-waiting/5 p-3">
              <p className="text-meta font-medium text-state-waiting">
                {humanise(agent.approval.action)}
              </p>
              <p className="mt-1 text-caption text-content-muted">{agent.approval.reason}</p>
            </div>
          ) : null}

          <div>
            <p className="text-meta text-content-subtle">Request</p>
            <p className="mt-1 text-callout text-content">{agent.taskTitleFull}</p>
          </div>

          <div>
            <p className="text-meta text-content-subtle">Last action</p>
            <p className="mt-1 font-mono text-caption text-content-muted">{agent.currentAction}</p>
          </div>

          <div>
            <p className="text-meta text-content-subtle">Progress</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-overlay">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${Math.round(agent.progress * 100)}%` }}
              />
            </div>
            <p className="mt-1.5 text-meta text-content-subtle">
              {humanise(agent.taskStatus)}
              {agent.startedAt ? ` · started ${relativeTime(agent.startedAt)}` : ''}
            </p>
          </div>

          <Link
            href={`/projects/${agent.projectId}/agent?task=${agent.taskId}`}
            className="btn-primary w-full"
          >
            Open task
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          </Link>
        </div>
      </aside>
    </div>
  );
}

function Metric({
  label,
  hint,
  value,
  icon: Icon,
  highlight = false,
  tone,
}: {
  label: string;
  hint: string;
  value: number | undefined;
  icon: typeof Activity;
  highlight?: boolean;
  tone?: 'failure';
}) {
  return (
    <div
      className={`rounded-card border bg-surface-raised p-4 sm:p-5 ${
        highlight ? 'border-state-waiting/40' : 'border-surface-border'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <dt className="text-callout font-medium text-content-muted">{label}</dt>
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            tone === 'failure'
              ? 'bg-state-failure/10 text-state-failure'
              : highlight
                ? 'bg-state-waiting/10 text-state-waiting'
                : 'bg-surface-overlay text-content-subtle'
          }`}
          aria-hidden="true"
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
      <dd className="mt-2">
        {value === undefined ? (
          <Skeleton className="h-9 w-12" />
        ) : (
          <span
            className={`block animate-fade-in text-display-sm tabular-nums ${
              highlight ? 'text-state-waiting' : value > 0 ? 'text-content' : 'text-content-subtle'
            }`}
          >
            {value}
          </span>
        )}
        <span className="mt-1 block text-meta text-content-subtle">{hint}</span>
      </dd>
    </div>
  );
}
