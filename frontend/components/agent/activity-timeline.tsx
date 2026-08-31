'use client';

import { useEffect, useRef } from 'react';
import { clockTime } from '@/lib/format';
import type { TaskEvent } from '@/lib/types';

const TYPE_STYLE: Record<string, { marker: string; label: string }> = {
  task_started: { marker: 'bg-state-running', label: 'started' },
  agent_activity: { marker: 'bg-content-subtle', label: '' },
  tool_started: { marker: 'bg-state-running', label: 'tool' },
  tool_completed: { marker: 'bg-state-success', label: 'tool' },
  file_modified: { marker: 'bg-state-running', label: 'file' },
  approval_required: { marker: 'bg-state-waiting', label: 'approval' },
  test_started: { marker: 'bg-state-running', label: 'test' },
  test_completed: { marker: 'bg-state-success', label: 'test' },
  task_completed: { marker: 'bg-state-success', label: 'completed' },
  task_failed: { marker: 'bg-state-failure', label: 'failed' },
  task_status_changed: { marker: 'bg-content-subtle', label: 'state' },
};

/**
 * The agent activity stream.
 *
 * This is the part of the interface that makes the platform legible: the user
 * watches the agent reason, request tools and pause for approval, rather than
 * waiting on an opaque spinner. Failed and denied events keep their colour so a
 * refused tool request is visible rather than buried.
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
      <p className="px-4 py-8 text-center text-xs text-content-subtle">
        No activity yet. The stream appears here as the agent works.
      </p>
    );
  }

  return (
    <ol className="space-y-0.5 px-4 py-3">
      {events.map((event) => {
        const style = TYPE_STYLE[event.type] ?? TYPE_STYLE.agent_activity;
        const failed = event.status === 'failed';

        return (
          <li key={event.sequence} className="flex gap-3 py-1">
            <span className="mt-1.5 shrink-0">
              <span
                className={`block h-1.5 w-1.5 rounded-full ${failed ? 'bg-state-failure' : style.marker}`}
              />
            </span>
            <span className="shrink-0 font-mono text-2xs leading-5 text-content-subtle">
              {clockTime(event.at)}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={`text-xs leading-5 ${failed ? 'text-state-failure' : 'text-content'}`}
              >
                {event.message}
              </span>
              {typeof event.payload?.reason === 'string' ? (
                <span className="mt-0.5 block text-2xs text-state-waiting">
                  {event.payload.reason}
                </span>
              ) : null}
              {typeof event.payload?.toolName === 'string' && style.label === 'tool' ? (
                <span className="ml-2 font-mono text-2xs text-content-subtle">
                  {event.payload.toolName}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
      <div ref={endRef} />
    </ol>
  );
}
