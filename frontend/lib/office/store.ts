import type {
  AgentTaskStatus,
  AiOfficeActivityItem,
  AiOfficeAttentionItem,
  AiOfficeBoard,
  AiOfficeCard,
  AiOfficeQueue,
  TaskEvent,
} from '@/lib/types';
import { phaseFor } from './status';

/**
 * The office's client state as a reducer, so realtime behaviour is a pure
 * function of (state, message) and can be tested without a socket.
 *
 * The contract, in order of precedence:
 *
 * 1. A REST snapshot is the truth. It replaces everything and clears the
 *    "moved" marks, because a snapshot is a fresh read and not a transition.
 * 2. A live event may move a known card to its new status straight away, so
 *    the figure walks the moment the worker changes state. It may not invent a
 *    card: an event for an unknown task only asks for a resync.
 * 3. An event's `message` is never stored. It is the agent's own narration
 *    (ADR-066 keeps that out of the portal); the office only reads `taskId`,
 *    `taskStatus`, `type` and `sequence`.
 * 4. Events are ordered per task by `sequence`. A late or duplicate frame for
 *    a task is dropped rather than moving the figure backwards.
 *
 * Card identity is preserved wherever a card did not change, so memoised
 * figures only re-render for the task an event actually touched.
 */

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'synchronizing';

export interface OfficeState {
  board: AiOfficeBoard | null;
  attention: AiOfficeAttentionItem[];
  queue: AiOfficeQueue | null;
  activity: AiOfficeActivityItem[];
  hasMoreActivity: boolean;
  connection: Connection;
  /** Tasks whose status changed since the last snapshot. Drives the walk animation. */
  movedTaskIds: ReadonlySet<string>;
  /** Highest event sequence applied per task. */
  sequences: Readonly<Record<string, number>>;
  /** True when something arrived that only a refetch can reconcile. */
  needsResync: boolean;
  loadedAt: Date | null;
  error: string | null;
}

export type OfficeMessage =
  | {
      kind: 'snapshot';
      board: AiOfficeBoard;
      attention: AiOfficeAttentionItem[];
      queue: AiOfficeQueue;
      activity: AiOfficeActivityItem[];
      activityPage: number;
      at: Date;
    }
  | { kind: 'snapshot-failed'; error: string }
  | { kind: 'older-activity'; items: AiOfficeActivityItem[]; activityPage: number }
  | { kind: 'socket-open' }
  | { kind: 'socket-closed' }
  | { kind: 'resync-started' }
  | { kind: 'event'; event: TaskEvent };

export const EMPTY_MOVED: ReadonlySet<string> = new Set();

export const INITIAL_OFFICE_STATE: OfficeState = {
  board: null,
  attention: [],
  queue: null,
  activity: [],
  hasMoreActivity: false,
  connection: 'connecting',
  movedTaskIds: EMPTY_MOVED,
  sequences: {},
  needsResync: false,
  loadedAt: null,
  error: null,
};

const TERMINAL: ReadonlySet<AgentTaskStatus> = new Set(['completed', 'failed', 'cancelled']);

/**
 * The single status change a live event may make to the floor.
 *
 * A terminal status takes the card off the floor. It does not add it to
 * `recent`: the finished card's `endedAt` is only known to the database, so the
 * resync that follows supplies it rather than the client guessing a time.
 */
function moveCard(
  board: AiOfficeBoard,
  taskId: string,
  status: AgentTaskStatus,
): { board: AiOfficeBoard; moved: boolean } {
  const index = board.cards.findIndex((card) => card.taskId === taskId);
  if (index === -1) return { board, moved: false };

  const current = board.cards[index];
  if (current.status === status) return { board, moved: false };

  if (TERMINAL.has(status)) {
    const cards = board.cards.filter((card) => card.taskId !== taskId);
    return {
      board: { ...board, cards, summary: { ...board.summary, live: cards.length } },
      moved: true,
    };
  }

  // The card keeps its progress and last action: those come from the database
  // and a live event carries neither. The resync replaces them moments later.
  const next: AiOfficeCard = { ...current, status, phase: phaseFor(status) };
  const cards = board.cards.slice();
  cards[index] = next;
  return { board: { ...board, cards }, moved: true };
}

export function officeReducer(state: OfficeState, message: OfficeMessage): OfficeState {
  switch (message.kind) {
    case 'snapshot':
      return {
        ...state,
        board: message.board,
        attention: message.attention,
        queue: message.queue,
        activity: message.activity,
        hasMoreActivity: message.activity.length === message.activityPage,
        movedTaskIds: EMPTY_MOVED,
        needsResync: false,
        loadedAt: message.at,
        error: null,
        // A snapshot that lands after a reconnect completes the synchronise.
        connection: state.connection === 'synchronizing' ? 'live' : state.connection,
      };

    case 'snapshot-failed':
      // The last known floor stays up; only the error line changes.
      return {
        ...state,
        error: message.error,
        connection: state.connection === 'synchronizing' ? 'live' : state.connection,
      };

    case 'older-activity': {
      const seen = new Set(state.activity.map((item) => item.id));
      return {
        ...state,
        activity: [...state.activity, ...message.items.filter((item) => !seen.has(item.id))],
        hasMoreActivity: message.items.length === message.activityPage,
      };
    }

    case 'socket-open': {
      // The first connection is live as soon as the socket is up, because the
      // snapshot already landed. After a drop, events were missed and are gone,
      // so the office shows "synchronizing" until a fresh read lands.
      const first = state.connection === 'connecting';
      return { ...state, connection: first ? 'live' : 'synchronizing', needsResync: !first };
    }

    case 'socket-closed':
      return { ...state, connection: 'reconnecting' };

    case 'resync-started':
      return { ...state, needsResync: false };

    case 'event': {
      const { event } = message;
      if (typeof event.taskId !== 'string' || typeof event.sequence !== 'number') return state;

      const last = state.sequences[event.taskId] ?? -1;
      if (event.sequence <= last) return state;

      const sequences = { ...state.sequences, [event.taskId]: event.sequence };

      if (!state.board || !event.taskStatus) {
        return { ...state, sequences, needsResync: true };
      }

      const { board, moved } = moveCard(state.board, event.taskId, event.taskStatus);

      let movedTaskIds = state.movedTaskIds;
      if (moved && !TERMINAL.has(event.taskStatus)) {
        const next = new Set(movedTaskIds);
        next.add(event.taskId);
        movedTaskIds = next;
      }

      return {
        ...state,
        board,
        sequences,
        movedTaskIds,
        // Every event is a reason to reread: progress, the last recorded action,
        // pending approvals and the activity line all live only in the database.
        // An event for a task the floor does not hold moves nothing, so the
        // refetch is the only thing that can put it there.
        needsResync: true,
      };
    }
  }
}
