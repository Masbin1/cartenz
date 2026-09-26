'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
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
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { AgentFigure } from '@/components/ai-office/agent-figure';
import { RoomScene } from '@/components/ai-office/room-scene';
import { humanise, relativeTime } from '@/lib/format';
import type {
  AiOfficeActivityItem,
  AiOfficeAttentionItem,
  AiOfficeCard,
  AiOfficeFinishedCard,
  AiOfficePhase,
} from '@/lib/types';

/**
 * The office floor (PRD docs/AI-OFFICE-PRD-draft.md, ADR-066).
 *
 * Four rooms, each a phase of the task lifecycle, and in each room a person for
 * every task actually running. The figures are tasks: Cartenz runs one agent
 * through a fixed state machine, so a desk is a task and the way the person sits
 * is that task's state. Nothing here animates without a database row behind it.
 *
 * Live updates come from the existing gateway's cross-project feed. The wire
 * message is never rendered - it carries the agent's own narration, which
 * ADR-066 keeps out of the browser - so a visible change is either an optimistic
 * status move or a refetch from the sanitised REST endpoints.
 */
const ROOMS: {
  phase: AiOfficePhase;
  name: string;
  role: string;
  hint: string;
}[] = [
  {
    phase: 'research',
    name: 'Research',
    role: 'Analysts',
    hint: 'Reading the request, planning the change',
  },
  { phase: 'development', name: 'Development', role: 'Engineers', hint: 'Writing the change' },
  { phase: 'quality', name: 'Quality', role: 'Testers', hint: 'Running validation and tests' },
  { phase: 'operations', name: 'Operations', role: 'Release', hint: 'Commit, push, build' },
];

export default function AiOfficePage() {
  const { loading, user } = useRequireAuth();
  const {
    board,
    attention,
    activity,
    queue,
    live,
    busy,
    loadedAt,
    refresh,
    loadMoreActivity,
    hasMoreActivity,
  } = useOffice();
  const [selected, setSelected] = useState<AiOfficeCard | null>(null);

  const byPhase = useMemo(() => {
    const grouped: Record<AiOfficePhase, AiOfficeCard[]> = {
      research: [],
      development: [],
      quality: [],
      operations: [],
    };
    for (const card of board?.cards ?? []) grouped[card.phase].push(card);
    return grouped;
  }, [board]);

  if (loading || !user) return <PageLoading label="Loading your session" />;

  const summary = board?.summary;

  return (
    <AppShell>
      <div className="page">
        <PageHeader
          title="AI Office"
          description="Every task running across your projects, shown as the phase it is in. One person is one task that exists right now."
          actions={
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void refresh()}
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
              <LiveIndicator live={live} />
              <span className="text-meta text-content-subtle">
                {loadedAt ? `Read at ${loadedAt.toLocaleTimeString()}` : 'Reading the board'}
              </span>
            </>
          }
        />

        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Metric
              label="Working now"
              hint={
                queue
                  ? `${queue.running} of ${queue.capacity} workers busy`
                  : 'Tasks occupying a worker'
              }
              value={summary?.live}
              icon={Users}
              busy={busy}
            />
            <Metric
              label="Waiting on you"
              hint={attention.length > 0 ? 'Paused for a decision' : 'Nothing waiting'}
              value={summary?.needsAttention}
              icon={Hand}
              busy={busy}
              highlight={(summary?.needsAttention ?? 0) > 0}
            />
            <Metric
              label="Completed today"
              hint="Since midnight"
              value={summary?.completedToday}
              icon={CircleCheckBig}
              busy={busy}
            />
            <Metric
              label="Failed today"
              hint="Since midnight"
              value={summary?.failedToday}
              icon={TriangleAlert}
              busy={busy}
              tone={(summary?.failedToday ?? 0) > 0 ? 'failure' : undefined}
            />
          </dl>

          {attention.length > 0 ? <AttentionQueue items={attention} /> : null}

          <div className="office-floor overflow-hidden rounded-card border border-surface-border">
            <div className="grid gap-px bg-surface-border sm:grid-cols-2">
              {ROOMS.map((room) => (
                <Room
                  key={room.phase}
                  room={room}
                  cards={byPhase[room.phase]}
                  busy={busy}
                  onSelect={setSelected}
                  selectedId={selected?.taskId ?? null}
                />
              ))}
            </div>
          </div>

          {!busy && (board?.recent.length ?? 0) > 0 ? (
            <RecentlyFinished items={board?.recent ?? []} />
          ) : null}

          <div className="grid gap-6 lg:grid-cols-5">
            <QueueCard queue={queue} busy={busy} className="lg:col-span-2" />
            <ActivityFeed
              items={activity}
              busy={busy}
              hasMore={hasMoreActivity}
              onMore={loadMoreActivity}
              className="lg:col-span-3"
            />
          </div>

          {!busy && (board?.cards.length ?? 0) === 0 ? (
            <EmptyState
              icon={Activity}
              title="The office is quiet"
              description="No task is running right now, so every desk is empty. Start one from a project's agent workspace and a person sits down at a desk in the room for its phase."
              action={
                <Link href="/projects" className="btn-primary">
                  Go to projects
                </Link>
              }
            />
          ) : null}
        </div>
      </div>

      {selected ? <TaskDrawer card={selected} onClose={() => setSelected(null)} /> : null}
    </AppShell>
  );
}

function LiveIndicator({ live }: { live: boolean }) {
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
      {live ? 'Live' : 'Reconnecting'}
    </span>
  );
}

/**
 * One room: its name, and the scene with a person per task in this phase.
 *
 * The room is wide enough for four desks; anything past that is counted, not
 * squeezed in, because a five-person desk row would stop reading as an office.
 */
function Room({
  room,
  cards,
  busy,
  onSelect,
  selectedId,
}: {
  room: (typeof ROOMS)[number];
  cards: AiOfficeCard[];
  busy: boolean;
  onSelect: (card: AiOfficeCard) => void;
  selectedId: string | null;
}) {
  return (
    <section className="flex flex-col bg-surface-raised/80 p-4">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-headline text-content">{room.name}</h2>
          <p className="mt-0.5 text-meta text-content-subtle">{room.role}</p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-meta font-semibold tabular-nums ${
            cards.length > 0
              ? 'bg-state-running/10 text-state-running'
              : 'bg-surface-overlay text-content-subtle'
          }`}
        >
          {busy ? '-' : cards.length}
        </span>
      </header>
      <p className="mt-1 text-caption text-content-subtle">{room.hint}</p>

      <div className="mt-3 flex-1">
        {busy ? (
          <Skeleton className="aspect-[280/250] w-full" />
        ) : (
          <RoomScene
            phase={room.phase}
            name={room.name}
            cards={cards}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        )}
      </div>

      {!busy && cards.length === 0 ? (
        <p className="mt-2 text-center text-caption text-content-subtle">
          Empty. No task is in this phase.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The last few hours of finished tasks, each person standing back from the desk.
 *
 * A finished task has no desk (the floor is live work only), so this is where a
 * viewer who just watched a desk empty sees what became of it - and what makes an
 * idle office read as quiet rather than broken.
 */
function RecentlyFinished({ items }: { items: AiOfficeFinishedCard[] }) {
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
        {items.map((item, index) => (
          <li
            key={item.taskId}
            className="office-recent-item bg-surface-raised"
            style={{ animationDelay: `${index * 40}ms` }}
          >
            <Link
              href={`/projects/${item.projectId}/agent?task=${item.taskId}`}
              className="flex h-full flex-col items-center gap-2 px-3 py-4 text-center transition-colors hover:bg-surface-overlay/60"
            >
              <AgentFigure taskId={item.taskId} status={item.status} size={64} />
              <div className="min-w-0 max-w-full">
                <p className="truncate text-meta font-medium text-content">{item.projectName}</p>
                <p className="mt-0.5 line-clamp-2 text-caption text-content-subtle">
                  {item.prompt}
                </p>
                <p className="mt-1 text-caption tabular-nums text-content-subtle">
                  {humanise(item.status)} · {relativeTime(item.endedAt)}
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

function QueueCard({
  queue,
  busy,
  className = '',
}: {
  queue: ReturnType<typeof useOffice>['queue'];
  busy: boolean;
  className?: string;
}) {
  const waiting = queue?.waiting ?? [];

  return (
    <section
      className={`overflow-hidden rounded-card border border-surface-border bg-surface-raised ${className}`}
    >
      <div className="flex items-center gap-3 border-b border-surface-border px-5 py-4">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-overlay text-content-subtle"
          aria-hidden="true"
        >
          <Users className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <h2 className="min-w-0 flex-1 text-headline text-content">Workers</h2>
        {queue ? (
          <span className="text-meta tabular-nums text-content-subtle">
            {queue.running}/{queue.capacity} busy
          </span>
        ) : null}
      </div>

      {busy ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-14 w-full" />
        </div>
      ) : waiting.length === 0 ? (
        <p className="px-5 py-6 text-callout text-content-subtle">
          Nothing is queued. Every started task has a worker.
        </p>
      ) : (
        <>
          <p className="px-5 pt-3 text-meta text-content-subtle">
            {waiting.length === 1 ? '1 task is waiting' : `${waiting.length} tasks are waiting`} for
            a free worker.
          </p>
          <ul className="mt-1 divide-y divide-surface-border">
            {waiting.slice(0, 6).map((item) => (
              <li key={item.taskId} className="px-5 py-3">
                <p className="truncate text-callout text-content">{item.prompt}</p>
                <p className="mt-0.5 text-meta text-content-subtle">
                  {item.projectName}
                  {' · '}
                  <span className="font-mono text-caption">{item.taskReference}</span>
                  {' · '}
                  {relativeTime(item.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ActivityFeed({
  items,
  busy,
  hasMore,
  onMore,
  className = '',
}: {
  items: AiOfficeActivityItem[];
  busy: boolean;
  hasMore: boolean;
  onMore: () => Promise<void>;
  className?: string;
}) {
  const [loadingMore, setLoadingMore] = useState(false);

  return (
    <section
      className={`overflow-hidden rounded-card border border-surface-border bg-surface-raised ${className}`}
    >
      <div className="flex items-center gap-3 border-b border-surface-border px-5 py-4">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-state-running/10 text-state-running"
          aria-hidden="true"
        >
          <Activity className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <h2 className="min-w-0 flex-1 text-headline text-content">Activity</h2>
      </div>

      {busy ? (
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

/** The card, in full, without leaving the floor (PRD phase 3). */
function TaskDrawer({ card, onClose }: { card: AiOfficeCard; onClose: () => void }) {
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
            <AgentFigure taskId={card.taskId} status={card.status} size={72} />
            <div className="min-w-0">
              <p className="text-callout font-medium text-content">{card.projectName}</p>
              <p className="mt-0.5 font-mono text-caption text-content-subtle">
                {card.taskReference}
              </p>
              <div className="mt-1.5">
                <StatusBadge status={card.status} size="small" />
              </div>
            </div>
          </div>

          <div>
            <p className="text-meta text-content-subtle">Request</p>
            <p className="mt-1 text-callout text-content">{card.prompt}</p>
          </div>

          <div>
            <p className="text-meta text-content-subtle">Last action</p>
            <p className="mt-1 font-mono text-caption text-content-muted">
              {card.currentAction ?? 'No action recorded yet'}
            </p>
          </div>

          <div>
            <p className="text-meta text-content-subtle">Progress</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-overlay">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${Math.round(card.progress * 100)}%` }}
              />
            </div>
            <p className="mt-1.5 text-meta text-content-subtle">
              {humanise(card.status)}
              {card.startedAt ? ` · started ${relativeTime(card.startedAt)}` : ''}
            </p>
          </div>

          <Link
            href={`/projects/${card.projectId}/agent?task=${card.taskId}`}
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
  busy,
  highlight = false,
  tone,
}: {
  label: string;
  hint: string;
  value: number | undefined;
  icon: typeof Activity;
  busy: boolean;
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
        {busy || value === undefined ? (
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
