'use client';

import { useEffect, useRef } from 'react';
import { Activity } from 'lucide-react';
import { clockTime, type StatusTone } from '@/lib/format';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusDot } from '@/components/ui/status-dot';
import type { TaskEvent } from '@/lib/types';

/**
 * What each event type means, as a status tone for its marker on the rail and a
 * label for the few events that deserve one. `label` is also how a tool event
 * is recognised, so its tool name can be shown beside the message.
 */
const TYPE_STYLE: Record<string, { tone: StatusTone; label: string }> = {
  task_started: { tone: 'running', label: 'started' },
  agent_activity: { tone: 'neutral', label: '' },
  tool_started: { tone: 'running', label: 'tool' },
  tool_completed: { tone: 'success', label: 'tool' },
  file_modified: { tone: 'running', label: 'file' },
  approval_required: { tone: 'waiting', label: 'approval' },
  test_started: { tone: 'running', label: 'test' },
  test_completed: { tone: 'success', label: 'test' },
  task_completed: { tone: 'success', label: 'completed' },
  task_failed: { tone: 'failure', label: 'failed' },
  task_status_changed: { tone: 'neutral', label: 'state' },
};

const MARKER: Record<StatusTone, string> = {
  running: 'bg-state-running',
  waiting: 'bg-state-waiting',
  success: 'bg-state-success',
  failure: 'bg-state-failure',
  idle: 'bg-state-idle',
  neutral: 'bg-content-subtle/60',
};

/**
 * The agent activity stream.
 *
 * This is the part of the interface that makes the platform legible: the user
 * watches the agent reason, request tools and pause for approval, rather than
 * waiting on an opaque spinner. Failed and denied events keep their colour so a
 * refused tool request is visible rather than buried.
 *
 * Laid out as a quiet vertical timeline: a hairline rail with a small marker
 * per event, the time in monospace, the message in callout text. Only the
 * events that need a person (a failure, an approval) carry a labelled status.
 */
export function ActivityTimeline({ events }: { events: TaskEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  const countRef = useRef(0);

  useEffect(() => {
    // Only scroll when something new arrives, so a user reading history is not
    // dragged to the bottom on every re-render.
    if (events.length > countRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    countRef.current = events.length;
  }, [events.length]);

  if (events.length === 0) {
    return (
      <EmptyState
        compact
        icon={Activity}
        title="No activity yet"
        description="Progress appears here as the agent works."
      />
    );
  }

  return (
    <ol className="relative px-5 py-4 sm:px-6">
      {events.map((event, index) => {
        const style = TYPE_STYLE[event.type] ?? TYPE_STYLE.agent_activity;
        const failed = event.status === 'failed';
        const tone: StatusTone = failed ? 'failure' : style.tone;
        const last = index === events.length - 1;

        return (
          <li key={event.sequence} className="relative flex animate-fade-in gap-3 pb-4 last:pb-0">
            {/* The rail and the marker. */}
            <span className="relative flex w-2 shrink-0 justify-center" aria-hidden="true">
              {last ? null : (
                <span className="absolute bottom-[-0.25rem] top-4 w-px bg-surface-border" />
              )}
              <span className={`relative mt-1.5 h-2 w-2 rounded-full ${MARKER[tone]}`} />
            </span>

            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <time dateTime={event.at} className="mono-meta shrink-0">
                  {clockTime(event.at)}
                </time>
                {failed ? (
                  <StatusDot tone="failure" size="small">
                    Failed
                  </StatusDot>
                ) : style.label === 'approval' ? (
                  <StatusDot tone="waiting" size="small">
                    Needs approval
                  </StatusDot>
                ) : null}
              </span>
              <span
                className={`mt-0.5 block break-words text-callout ${
                  failed ? 'text-state-failure' : 'text-content'
                }`}
              >
                {event.message}
                {typeof event.payload?.toolName === 'string' && style.label === 'tool' ? (
                  <span className="code-chip ml-2 align-middle">{event.payload.toolName}</span>
                ) : null}
              </span>
              {typeof event.payload?.reason === 'string' ? (
                <span className="mt-1 block text-meta text-state-waiting">{event.payload.reason}</span>
              ) : null}
            </span>
          </li>
        );
      })}
      <div ref={endRef} />
    </ol>
  );
}
