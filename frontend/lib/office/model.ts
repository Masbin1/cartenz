import type {
  AgentTaskStatus,
  AiOfficeActivityItem,
  AiOfficeAttentionItem,
  AiOfficeBoard,
  AiOfficeFinishedCard,
  AiOfficePhase,
  AiOfficeQueue,
} from '@/lib/types';
import {
  STATUS_ACTIONS,
  isOfficeLive,
  needsAttention,
  officeStatusFor,
  phaseFor,
  previousPhase,
  type OfficeStatus,
} from './status';

/**
 * The office's state, derived from what the backend actually knows.
 *
 * The rule this file exists to keep is that nothing reaches the drawing
 * without a row behind it. There is no agent registry in Cartenz: a task is one
 * agent walking a fixed state machine (ADR-018), so a figure on the floor is a
 * task that exists, its pose is that task's status, and its movement is the
 * status changing. No persona, no parallel teammates, no invented progress.
 *
 * Everything here is a pure function of the three read models the API returns,
 * which is what makes the office testable and what would let a second renderer
 * draw it without touching this mapping.
 *
 * Deliberately absent: a per-agent `runId`. `agent_tasks` carries no run
 * identity, and inventing one would be exactly the kind of decoration this
 * module refuses to add. The field is declared as `null` so a future run model
 * has somewhere to land.
 */

/** What a figure on the floor is doing, in the office's own vocabulary. */
export interface OfficeAgent {
  /** The task id: the office names a worker by the work, not by a persona. */
  id: string;
  taskId: string;
  taskReference: string;
  /** Project and reference, e.g. "MAHA · TASK-41". Never a made-up agent name. */
  displayName: string;
  projectId: string;
  projectName: string;
  status: OfficeStatus;
  /**
   * The backend's own status, kept alongside the office status. The walk table
   * in `status.ts` is keyed by this, not by `status`: `OfficeStatus` has already
   * collapsed a dozen task states into eight display states, and only the
   * original names a step in the state machine.
   */
  taskStatus: AgentTaskStatus;
  /** The room the agent is in. For a live task this is the task's own phase. */
  department: AiOfficePhase;
  /** 0 to 1, from the task's position in its state machine, never a timer. */
  progress: number;
  /** Always present: a real recorded action, or the honest default for the status. */
  currentAction: string;
  /** True when `currentAction` is a recorded action rather than a status line. */
  currentActionIsReal: boolean;
  taskTitle: string;
  taskTitleFull: string;
  /** True when the agent arrived in its current room since the last render. */
  justMoved: boolean;
  /** True when the agent holds a desk; false for a figure standing back. */
  seated: boolean;
  startedAt: string | null;
  updatedAt: string;
  /** The pending approval blocking this task, when its status is `approval`. */
  approval: { action: string; reason: string } | null;
  /** No run identity exists in the backend yet; declared for the renderer contract. */
  runId: null;
}

export interface OfficeDepartment {
  id: AiOfficePhase;
  name: string;
  role: string;
  hint: string;
  /** Live occupants, in the order the board returned them. */
  agentIds: string[];
  /** How many desks this room draws, occupied or not. */
  desks: number;
  /** True when at least one task occupies this room. */
  busy: boolean;
}

export interface OfficeOrchestrator {
  id: 'dispatch';
  label: string;
  sublabel: string;
  /** Worker slots that can hold a running task (AGENT_WORKER_CONCURRENCY). */
  capacity: number;
  /** Slots actually held right now. */
  busy: number;
  /** Agent ids created or queued but not yet picked up by a worker. */
  dispatchQueue: string[];
  /** The agent currently crossing from dispatch into a room, if any. */
  dispatching: string | null;
  state: 'idle' | 'dispatching' | 'saturated' | 'offline';
}

/**
 * A line between two places on the floor. It always means something concrete:
 * either a room is occupied through the dispatch point, or an agent walked from
 * one room to the next. Nothing is drawn agent-to-agent, because no such
 * relationship exists in the backend and a mesh of decorative lines would be a
 * claim about the architecture that is not true.
 */
export interface OfficeConnection {
  id: string;
  from: AiOfficePhase | 'dispatch';
  to: AiOfficePhase | 'dispatch';
  /** Agents this edge is true of right now. */
  agentIds: string[];
  /** A walking agent makes the line flow; otherwise it is a faint presence line. */
  active: boolean;
}

export interface OfficeTotals {
  agents: number;
  running: number;
  waiting: number;
  approval: number;
  queued: number;
  completedToday: number;
  failedToday: number;
}

export type OfficeStatusLevel = 'loading' | 'empty' | 'live' | 'reconnecting';

export interface OfficeModel {
  status: OfficeStatusLevel;
  agents: OfficeAgent[];
  /** Task ids that ended inside the recent window, standing back from a desk. */
  recent: OfficeAgent[];
  departments: OfficeDepartment[];
  orchestrator: OfficeOrchestrator;
  connections: OfficeConnection[];
  totals: OfficeTotals;
  /** Recent recorded activity, oldest last, as returned by the API. */
  activity: AiOfficeActivityItem[];
}

/** Filters, as the toolbar holds them. `'all'` means unfiltered. */
export interface OfficeFilters {
  department: AiOfficePhase | 'all';
  projectId: string | 'all';
}

export const NO_FILTERS: OfficeFilters = { department: 'all', projectId: 'all' };

/** How strongly something should be drawn under the current filters. */
export type OfficeEmphasis = 'focused' | 'normal' | 'dimmed';

/** How many desks a room draws, occupied or not. */
export const DESKS_PER_ROOM = 4;

/** Characters of a task prompt shown under a figure before it is clipped. */
export const TASK_TITLE_LIMIT = 44;

export const DEPARTMENTS: readonly Omit<OfficeDepartment, 'agentIds' | 'desks' | 'busy'>[] = [
  {
    id: 'research',
    name: 'Research',
    role: 'Analysts',
    hint: 'Reading the request, planning the change',
  },
  { id: 'development', name: 'Development', role: 'Engineers', hint: 'Writing the change' },
  { id: 'quality', name: 'Quality', role: 'Testers', hint: 'Running validation and tests' },
  { id: 'operations', name: 'Operations', role: 'Release', hint: 'Commit, push, build' },
];

export const ORCHESTRATOR_LABEL = 'Dispatch';
export const ORCHESTRATOR_SUBLABEL = 'Worker slots';

/** A prompt clipped for display. Full text stays in the drawer and the title. */
export function clipTitle(text: string, limit = TASK_TITLE_LIMIT): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

function agentFromCard(
  input: {
    taskId: string;
    taskReference: string;
    projectId: string;
    projectName: string;
    prompt: string;
    status: AgentTaskStatus;
    phase: AiOfficePhase;
    progress: number;
    currentAction: string | null;
    startedAt: string | null;
    updatedAt: string;
  },
  context: {
    approval: AiOfficeAttentionItem | null;
    movedTaskIds: ReadonlySet<string>;
  },
): OfficeAgent {
  const status = officeStatusFor(input.status);
  const recorded = input.currentAction !== null && input.currentAction.length > 0;

  return {
    id: input.taskId,
    taskId: input.taskId,
    taskReference: input.taskReference,
    displayName: `${input.projectName} · ${input.taskReference}`,
    projectId: input.projectId,
    projectName: input.projectName,
    status,
    taskStatus: input.status,
    department: input.phase,
    progress: input.progress,
    currentAction: recorded ? (input.currentAction as string) : STATUS_ACTIONS[status],
    currentActionIsReal: recorded,
    taskTitle: clipTitle(input.prompt),
    taskTitleFull: input.prompt,
    justMoved: context.movedTaskIds.has(input.taskId),
    seated: true,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    approval: context.approval
      ? { action: context.approval.action, reason: context.approval.requiredReason }
      : null,
    runId: null,
  };
}

function standingAgent(card: AiOfficeFinishedCard): OfficeAgent {
  const status = officeStatusFor(card.status);
  return {
    id: card.taskId,
    taskId: card.taskId,
    taskReference: card.taskReference,
    displayName: `${card.projectName} · ${card.taskReference}`,
    projectId: card.projectId,
    projectName: card.projectName,
    status,
    taskStatus: card.status,
    department: phaseFor(card.status),
    progress: 1,
    currentAction: STATUS_ACTIONS[status],
    currentActionIsReal: false,
    taskTitle: clipTitle(card.prompt),
    taskTitleFull: card.prompt,
    justMoved: false,
    seated: false,
    startedAt: null,
    updatedAt: card.endedAt,
    approval: null,
    runId: null,
  };
}

function buildConnections(agents: OfficeAgent[]): OfficeConnection[] {
  const edges = new Map<string, OfficeConnection>();

  const add = (
    from: OfficeConnection['from'],
    to: OfficeConnection['to'],
    agentId: string,
    active: boolean,
  ) => {
    const id = `${from}→${to}`;
    const existing = edges.get(id);
    if (existing) {
      existing.agentIds.push(agentId);
      existing.active = existing.active || active;
      return;
    }
    edges.set(id, { id, from, to, agentIds: [agentId], active });
  };

  for (const agent of agents) {
    if (!isOfficeLive(agent.status)) continue;

    const queued = agent.status === 'queued';
    const from = queued ? 'dispatch' : (previousPhase(agent.taskStatus) ?? 'dispatch');

    if (from === agent.department) {
      // No step to draw: the task started in this room. Show it as being on the
      // dispatch line so a running task is never disconnected from the office.
      add('dispatch', agent.department, agent.id, agent.status === 'running');
      continue;
    }

    add(
      from,
      agent.department,
      agent.id,
      agent.justMoved || (!queued && agent.status === 'running'),
    );
  }

  return [...edges.values()];
}

function buildOrchestrator(
  agents: OfficeAgent[],
  queue: AiOfficeQueue | null,
  live: boolean,
): OfficeOrchestrator {
  const capacity = queue?.capacity ?? 0;
  // `queue.running` is the backend's own count of tasks holding a worker slot,
  // and the office renders it rather than recomputing it. Recomputing looked
  // equivalent and was not: the backend counts a task parked on an approval as
  // still holding its slot (it resumes on a fresh job with the same worker),
  // so a frontend rule that excluded `approval` reported fewer busy slots than
  // the worker actually had in use.
  const busy = queue?.running ?? agents.filter((agent) => isOfficeLive(agent.status)).length;
  const dispatchQueue = agents
    .filter((agent) => agent.status === 'queued')
    .map((agent) => agent.id);
  const dispatching = agents.find((agent) => agent.justMoved)?.id ?? null;

  const state: OfficeOrchestrator['state'] = !live
    ? 'offline'
    : dispatching
      ? 'dispatching'
      : capacity > 0 && busy >= capacity
        ? 'saturated'
        : 'idle';

  return {
    id: 'dispatch',
    label: ORCHESTRATOR_LABEL,
    sublabel: ORCHESTRATOR_SUBLABEL,
    capacity,
    busy,
    dispatchQueue,
    dispatching,
    state,
  };
}

/**
 * Build the office from the read models.
 *
 * `movedTaskIds` is the set of tasks whose status changed since the previous
 * model: only those figures are drawn mid-stride, so movement always traces a
 * real transition rather than an animation loop.
 */
export function buildOfficeModel(input: {
  board: AiOfficeBoard | null;
  attention: AiOfficeAttentionItem[];
  queue: AiOfficeQueue | null;
  activity?: AiOfficeActivityItem[];
  live: boolean;
  movedTaskIds?: ReadonlySet<string>;
}): OfficeModel {
  const { board, attention, queue, live } = input;
  const movedTaskIds = input.movedTaskIds ?? new Set<string>();

  const approvalByTask = new Map<string, AiOfficeAttentionItem>();
  for (const item of attention) approvalByTask.set(item.taskId, item);

  const agents = (board?.cards ?? []).map((card) =>
    agentFromCard(card, { approval: approvalByTask.get(card.taskId) ?? null, movedTaskIds }),
  );
  const recent = (board?.recent ?? []).map(standingAgent);

  const departments = DEPARTMENTS.map((department) => {
    const occupants = agents.filter((agent) => agent.department === department.id);
    return {
      ...department,
      agentIds: occupants.map((agent) => agent.id),
      // Every occupied desk must be drawn, even past the room's usual four: a
      // task that goes unrendered because a room is "full" would be a
      // fabrication by omission, and ADR-066 forbids that as much as drawing a
      // task that is not there.
      desks: Math.max(DESKS_PER_ROOM, occupants.length),
      busy: occupants.length > 0,
    };
  });

  const status: OfficeStatusLevel =
    board === null ? 'loading' : agents.length === 0 ? 'empty' : live ? 'live' : 'reconnecting';

  return {
    status,
    agents,
    recent,
    departments,
    orchestrator: buildOrchestrator(agents, queue ?? null, live),
    connections: buildConnections(agents),
    totals: {
      agents: agents.length,
      running: agents.filter((agent) => agent.status === 'running').length,
      waiting: agents.filter((agent) => agent.status === 'waiting').length,
      approval: agents.filter((agent) => needsAttention(agent.status)).length,
      queued: agents.filter((agent) => agent.status === 'queued').length,
      completedToday: board?.summary.completedToday ?? 0,
      failedToday: board?.summary.failedToday ?? 0,
    },
    activity: input.activity ?? [],
  };
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

/** Whether an agent survives the current project filter. */
export function agentInScope(agent: OfficeAgent, filters: OfficeFilters): boolean {
  if (filters.projectId !== 'all' && agent.projectId !== filters.projectId) return false;
  return true;
}

/**
 * How strongly to draw an agent.
 *
 * Filters subdue rather than remove: a project filter dims other projects'
 * workers but leaves them on the floor, so the office never appears to lose
 * people the backend still reports.
 */
export function agentEmphasis(agent: OfficeAgent, filters: OfficeFilters): OfficeEmphasis {
  const departmentOn = filters.department === 'all' || filters.department === agent.department;
  const projectOn = agentInScope(agent, filters);
  if (departmentOn && projectOn) return 'focused';
  return 'dimmed';
}

/** How strongly to draw a room. An unfiltered office draws every room equally. */
export function departmentEmphasis(
  department: OfficeDepartment,
  filters: OfficeFilters,
): OfficeEmphasis {
  if (filters.department === 'all') return 'normal';
  return filters.department === department.id ? 'focused' : 'dimmed';
}

/**
 * The project ids present on the floor, for the toolbar's project selector.
 * Built from the floor rather than from the full project list so the filter can
 * only ever offer something the viewer can actually see.
 */
export function projectsOnFloor(agents: OfficeAgent[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const agent of agents)
    if (!seen.has(agent.projectId)) seen.set(agent.projectId, agent.projectName);
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The activity feed, restricted to what the filters admit. */
export function activityInScope(
  activity: AiOfficeActivityItem[],
  filters: OfficeFilters,
): AiOfficeActivityItem[] {
  if (filters.projectId === 'all') return activity;
  return activity.filter((item) => item.projectId === filters.projectId);
}

/**
 * The agents a small screen shows, in a fixed order: whoever wants a human
 * first, then whoever is working, then the queue. The spatial view is not
 * squeezed onto a phone; this is what replaces it.
 */
export function mobileAgents(model: OfficeModel, filters: OfficeFilters): OfficeAgent[] {
  const rank: Record<OfficeStatus, number> = {
    approval: 0,
    waiting: 1,
    running: 2,
    queued: 3,
    completed: 4,
    failed: 5,
    cancelled: 6,
    idle: 7,
  };
  return model.agents
    .filter((agent) => agentInScope(agent, filters))
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        b.progress - a.progress ||
        a.displayName.localeCompare(b.displayName),
    );
}
