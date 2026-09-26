'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, taskEventSocketUrl } from './api';
import type {
  AgentTaskStatus,
  AiOfficeAttentionItem,
  AiOfficeBoard,
  AiOfficeCard,
  AiOfficeActivityItem,
  AiOfficeQueue,
  TaskEvent,
} from './types';

interface OfficeState {
  board: AiOfficeBoard | null;
  attention: AiOfficeAttentionItem[];
  activity: AiOfficeActivityItem[];
  queue: AiOfficeQueue | null;
  /** True while the WebSocket is open and the board feed is subscribed. */
  live: boolean;
  busy: boolean;
  loadedAt: Date | null;
  refresh: () => Promise<void>;
  loadMoreActivity: () => Promise<void>;
  hasMoreActivity: boolean;
}

/**
 * A live event names only the new status, so a card is moved optimistically
 * between rooms without waiting for the refetch.
 *
 * A terminal status moves the card out of the floor. The refetch that follows
 * picks it up in `recent`, so a task that finishes is seen to end rather than
 * blink out - but the floor itself only ever holds live work.
 */
function applyStatus(
  cards: AiOfficeCard[],
  taskId: string,
  status: AgentTaskStatus,
): AiOfficeCard[] {
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  if (terminal) return cards.filter((card) => card.taskId !== taskId);

  const existing = cards.find((card) => card.taskId === taskId);
  if (!existing) return cards;
  return cards.map((card) => (card.taskId === taskId ? { ...card, status } : card));
}

/**
 * The AI Office stream: the board over REST, moved by task events over the
 * existing gateway's cross-project feed (`{ action: 'subscribe', scope:
 * 'ai-office' }`).
 *
 * Live events are used for three things and no more: the connection indicator, an
 * optimistic status change so a task visibly moves between rooms the moment the
 * worker changes its state, and a debounced refetch that redraws the card and the
 * activity feed from the database.
 *
 * The refetch is not laziness. An event carries the agent's `message`, which for
 * `agent_activity` is its own narration - the thing ADR-066 forbids publishing to
 * the portal. Rendering it would leak reasoning to the browser through the back
 * door, so the wire payload is never displayed; every visible line comes from the
 * sanitised REST endpoints instead.
 *
 * Events missed while disconnected are gone, so a reconnect resyncs by refetching
 * rather than pretending it caught up.
 */
export function useOffice(): OfficeState {
  const [board, setBoard] = useState<AiOfficeBoard | null>(null);
  const [attention, setAttention] = useState<AiOfficeAttentionItem[]>([]);
  const [activity, setActivity] = useState<AiOfficeActivityItem[]>([]);
  const [queue, setQueue] = useState<AiOfficeQueue | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(true);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [hasMoreActivity, setHasMoreActivity] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const closedByUsRef = useRef(false);
  const resyncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchAll = useCallback(async () => {
    const [boardResult, attentionResult, activityResult, queueResult] = await Promise.all([
      api.aiOffice.board(),
      api.aiOffice.attention(),
      api.aiOffice.activity({ limit: 40 }),
      api.aiOffice.queue(),
    ]);
    setBoard(boardResult);
    setQueue(queueResult);
    setAttention(attentionResult);
    setActivity(activityResult);
    setHasMoreActivity(activityResult.length === 40);
    setLoadedAt(new Date());
  }, []);

  /** Coalesces a burst of events - one task emits dozens per step - into one refetch. */
  const scheduleResync = useCallback(() => {
    if (resyncTimer.current) clearTimeout(resyncTimer.current);
    resyncTimer.current = setTimeout(() => {
      void fetchAll().catch(() => undefined);
    }, 1200);
  }, [fetchAll]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await fetchAll();
    } finally {
      setBusy(false);
    }
  }, [fetchAll]);

  const loadMoreActivity = useCallback(async () => {
    const oldest = activity[activity.length - 1];
    if (!oldest) return;
    const older = await api.aiOffice.activity({ before: oldest.at, limit: 40 });
    setActivity((previous) => {
      const seen = new Set(previous.map((item) => item.id));
      return [...previous, ...older.filter((item) => !seen.has(item.id))];
    });
    setHasMoreActivity(older.length === 40);
  }, [activity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    closedByUsRef.current = false;
    let cancelled = false;

    const connect = () => {
      const url = taskEventSocketUrl();
      if (!url || cancelled) return;

      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        if (cancelled) return;
        setLive(true);
        retryRef.current = 0;
        socket.send(JSON.stringify({ action: 'subscribe', scope: 'ai-office' }));
      };

      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(String(message.data)) as
            Partial<TaskEvent> | { type?: string };

          if (typeof (payload as Partial<TaskEvent>).sequence !== 'number') return;

          const event = payload as TaskEvent;
          if (typeof event.taskId === 'string' && event.taskStatus) {
            setBoard((previous) =>
              previous
                ? {
                    ...previous,
                    cards: applyStatus(previous.cards, event.taskId, event.taskStatus),
                  }
                : previous,
            );
          }
          scheduleResync();
        } catch {
          // A malformed frame is ignored rather than breaking the stream.
        }
      };

      socket.onclose = () => {
        setLive(false);
        if (cancelled || closedByUsRef.current) return;

        // Bounded backoff, then resync: events missed while away are gone, so the
        // board has to be re-read rather than resumed.
        const delay = Math.min(1000 * 2 ** retryRef.current, 15000);
        retryRef.current += 1;
        setTimeout(() => {
          if (cancelled) return;
          connect();
          scheduleResync();
        }, delay);
      };

      socket.onerror = () => setLive(false);
    };

    connect();

    return () => {
      cancelled = true;
      closedByUsRef.current = true;
      if (resyncTimer.current) clearTimeout(resyncTimer.current);
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: 'unsubscribe', scope: 'ai-office' }));
        socket.close();
      }
      socketRef.current = null;
    };
  }, [scheduleResync]);

  return {
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
  };
}
