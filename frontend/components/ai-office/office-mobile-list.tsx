'use client';

import { memo } from 'react';
import { DEPARTMENTS, type OfficeAgent } from '@/lib/office/model';
import { STATUS_GLYPHS, STATUS_LABELS } from '@/lib/office/status';
import { AgentFigure } from './agent-figure';

/**
 * The office on a small screen (section 27).
 *
 * The isometric floor is not squeezed onto a phone. What replaces it is the same
 * model as a list grouped by room, ordered so whoever needs a human is first -
 * the same agents, statuses and click target as the floor, just not spatial.
 */
export const OfficeMobileList = memo(function OfficeMobileList({
  agents,
  onSelect,
}: {
  agents: OfficeAgent[];
  onSelect: (agent: OfficeAgent) => void;
}) {
  if (agents.length === 0) {
    return (
      <p className="rounded-card border border-surface-border bg-surface-raised px-4 py-6 text-center text-callout text-content-subtle">
        No task is on the floor right now.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {DEPARTMENTS.map((department) => {
        const inRoom = agents.filter((agent) => agent.department === department.id);
        if (inRoom.length === 0) return null;
        return (
          <section key={department.id}>
            <h3 className="mb-2 text-meta font-semibold uppercase tracking-wide text-content-subtle">
              {department.name}
              <span className="ml-1.5 tabular-nums">{inRoom.length}</span>
            </h3>
            <ul className="space-y-2">
              {inRoom.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(agent)}
                    className="flex w-full items-center gap-3 rounded-card border border-surface-border bg-surface-raised p-3 text-left transition-colors hover:bg-surface-overlay/60"
                    aria-label={`${agent.projectName} ${agent.taskReference}, ${STATUS_LABELS[agent.status]}. ${agent.taskTitleFull}`}
                  >
                    <AgentFigure taskId={agent.taskId} status={agent.taskStatus} size={48} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-callout font-medium text-content">
                        {agent.displayName}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-meta text-content-subtle">
                        {agent.taskTitle}
                      </p>
                      <p className="mt-1 text-caption text-content-muted">
                        <span aria-hidden="true">{STATUS_GLYPHS[agent.status]} </span>
                        {STATUS_LABELS[agent.status]}
                        {' · '}
                        {agent.currentAction}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
});
