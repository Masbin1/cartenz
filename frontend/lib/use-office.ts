'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { api, taskEventSocketUrl } from './api';
import { INITIAL_OFFICE_STATE, officeReducer, type OfficeState } from './office/store';
import type { TaskEvent } from './types';

const ACTIVITY_PAGE = 40;

/**
 * The AI Office stream: a REST snapshot, moved live by task events over the
 * existing gateway's cross-project feed (`{ action: 'subscribe', scope:
 * 'ai-office' }`), and periodically reconciled by a refetch.
 *
 * `officeReducer` (lib/office/store.ts) holds every rule for how a message
 * changes the state; this hook only wires up the socket, debounces bursts of
 * events into one resync, and retries. That split is what makes the reducer's
 * rules - "an event never carries the agent's narration into state", "a status
 * change is drawn immediately, everything else waits for the resync" -
 * testable without a live socket (lib/office/store.test.ts).
 */
export function useOffice() {
  const [state, dispatch] = useReducer(officeReducer, INITIAL_OFFICE_STATE);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const closedByUsRef = useRef(false);
  const resyncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stateRef = useRef(state);
  stateRef.current = state;

  const fetchSnapshot = useCallback(async () => {
    try {
      const [board, attention, activity, queue] = await Promise.all([
        api.aiOffice.board(),
        api.aiOffice.attention(),
        api.aiOffice.activity({ limit: ACTIVITY_PAGE }),
        api.aiOffice.queue(),
      ]);
      dispatch({
        kind: 'snapshot',
        board,
        attention,
        queue,
        activity,
        activityPage: ACTIVITY_PAGE,
        at: new Date(),
      });
    } catch {
      dispatch({ kind: 'snapshot-failed', error: 'Could not reach the office board.' });
    }
  }, []);

  const scheduleResync = useCallback(() => {
    if (resyncTimer.current) clearTimeout(resyncTimer.current);
    // One task emits several events per step; this coalesces a burst into one
    // refetch instead of one per event.
    resyncTimer.current = setTimeout(() => void fetchSnapshot(), 1000);
  }, [fetchSnapshot]);

  const refresh = useCallback(async () => {
    await fetchSnapshot();
  }, [fetchSnapshot]);

  const loadMoreActivity = useCallback(async () => {
    const oldest = stateRef.current.activity[stateRef.current.activity.length - 1];
    if (!oldest) return;
    const older = await api.aiOffice.activity({ before: oldest.at, limit: ACTIVITY_PAGE });
    dispatch({ kind: 'older-activity', items: older, activityPage: ACTIVITY_PAGE });
  }, []);

  useEffect(() => {
    void fetchSnapshot();
  }, [fetchSnapshot]);

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
        dispatch({ kind: 'socket-open' });
        retryRef.current = 0;
        socket.send(JSON.stringify({ action: 'subscribe', scope: 'ai-office' }));
        if (stateRef.current.needsResync) scheduleResync();
      };

      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(String(message.data)) as Partial<TaskEvent>;
          if (typeof payload.sequence !== 'number') return;
          dispatch({ kind: 'event', event: payload as TaskEvent });
          scheduleResync();
        } catch {
          // A malformed frame is ignored rather than breaking the stream.
        }
      };

      socket.onclose = () => {
        dispatch({ kind: 'socket-closed' });
        if (cancelled || closedByUsRef.current) return;

        // Bounded backoff, then resync: events missed while away are gone, so
        // the office is re-read rather than assumed caught up.
        const delay = Math.min(1000 * 2 ** retryRef.current, 15000);
        retryRef.current += 1;
        setTimeout(() => {
          if (cancelled) return;
          connect();
        }, delay);
      };

      socket.onerror = () => dispatch({ kind: 'socket-closed' });
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

  // The tab becoming visible again is exactly the "browser tab active" case
  // (PRD section 25): a snapshot is read to catch up on anything missed while
  // backgrounded, same as a reconnect.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchSnapshot();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchSnapshot]);

  return { state, refresh, loadMoreActivity } satisfies {
    state: OfficeState;
    refresh: () => Promise<void>;
    loadMoreActivity: () => Promise<void>;
  };
}
