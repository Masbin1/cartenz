'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, taskEventSocketUrl } from './api';
import type { TaskEvent, TaskEventType } from './types';

/**
 * A frame the gateway sends about the connection rather than about a task. These
 * carry no sequence, which is how they are told apart from events.
 */
interface ControlFrame {
  readonly type: 'connected' | 'subscribed' | 'unsubscribed' | 'pong' | 'error';
  readonly taskId?: string;
  readonly message?: string;
}

interface TaskStreamState {
  events: TaskEvent[];
  connected: boolean;
}

/**
 * Follows one task's event stream.
 *
 * The persisted history is fetched first and the socket subscribes second, so a
 * user who opens a task already in progress sees everything that has happened
 * rather than only what arrives from now on. Events are keyed by sequence, so an
 * event that appears in both the replay and the live stream is not shown twice.
 *
 * The history is then fetched a second time, once the server confirms the
 * subscription. That is not redundant: anything published between the first fetch
 * and the subscription taking effect belongs to neither, and would be lost. It was
 * lost - a task submitted from this page showed only its last two events, because
 * the clone and the analysis happened inside that window. The second fetch closes
 * it, and costs nothing, because merging by sequence discards what is already
 * held.
 *
 * The socket closes when the task leaves the hook, and a dropped connection
 * reconnects with a bounded backoff: a task can run for minutes, and a lost
 * socket must not leave the interface silently stale.
 */
export function useTaskStream(taskId: string | null): TaskStreamState {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const closedByUsRef = useRef(false);

  const merge = useCallback((incoming: TaskEvent) => {
    setEvents((previous) => {
      if (previous.some((event) => event.sequence === incoming.sequence)) return previous;
      return [...previous, incoming].sort((a, b) => a.sequence - b.sequence);
    });
  }, []);

  /**
   * Merges a batch, keyed by sequence.
   *
   * Replaces rather than appends where a sequence is already held, so the second
   * history fetch cannot duplicate anything the live stream already delivered.
   */
  const mergeAll = useCallback((incoming: readonly TaskEvent[]) => {
    setEvents((previous) => {
      const bySequence = new Map(previous.map((event) => [event.sequence, event]));
      for (const event of incoming) {
        if (!bySequence.has(event.sequence)) bySequence.set(event.sequence, event);
      }
      return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
    });
  }, []);

  useEffect(() => {
    /**
     * Cleared on every change of task, not only when the task becomes null.
     *
     * Sequence numbers restart at one for each task, so events left over from a
     * previously selected task do not merely appear under the wrong heading: they
     * occupy the sequence numbers the new task's events arrive with, and the merge
     * discards the new ones as duplicates. Selecting a second task showed the
     * first task's activity and none of its own.
     */
    setEvents([]);

    if (!taskId) return;

    closedByUsRef.current = false;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const loadHistory = async () => {
      try {
        const history = await api.tasks.events(taskId);
        if (cancelled) return;
        mergeAll(
          history.map((row) => ({
            taskId,
            taskReference: '',
            sequence: row.sequence,
            type: row.eventType as TaskEventType,
            status: row.status as TaskEvent['status'],
            taskStatus: (row.payload?.to as TaskEvent['taskStatus']) ?? 'created',
            message: row.message,
            at: row.createdAt,
            payload: row.payload ?? undefined,
          })),
        );
      } catch {
        // The socket may still deliver live events; an empty replay is not fatal.
      }
    };

    const connect = () => {
      const url = taskEventSocketUrl();
      if (!url || cancelled) return;

      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        retryRef.current = 0;
        socket.send(JSON.stringify({ action: 'subscribe', taskId }));
      };

      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(String(message.data)) as
            | Partial<TaskEvent>
            | ControlFrame;

          if (typeof (payload as Partial<TaskEvent>).sequence === 'number') {
            merge(payload as TaskEvent);
            return;
          }

          // A control frame. On confirmation that the subscription is live, refill
          // the gap between the first history fetch and this moment.
          if ((payload as ControlFrame).type === 'subscribed') {
            void loadHistory();
          }
        } catch {
          // A malformed frame is ignored rather than breaking the stream.
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (cancelled || closedByUsRef.current) return;

        // Bounded backoff: 1s, 2s, 4s, capped at 15s.
        const delay = Math.min(1000 * 2 ** retryRef.current, 15000);
        retryRef.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      socket.onerror = () => setConnected(false);
    };

    void loadHistory().then(connect);

    return () => {
      cancelled = true;
      closedByUsRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: 'unsubscribe', taskId }));
        socket.close();
      }
      socketRef.current = null;
    };
  }, [taskId, merge, mergeAll]);

  return { events, connected };
}
