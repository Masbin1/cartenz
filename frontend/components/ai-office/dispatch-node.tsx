'use client';

import { memo } from 'react';
import type { OfficeOrchestrator } from '@/lib/office/model';
import { DISPATCH_LAYOUT, project } from '@/lib/office/layout';

/**
 * The dispatch point: where a task is picked up by a worker.
 *
 * This is not "Hermes the orchestrator" - Cartenz has no multi-agent
 * coordinator; Hermes is one LLM provider among several a task can be
 * configured to use (ADR-018). What is real here is the worker pool: a fixed
 * number of concurrent slots (`AGENT_WORKER_CONCURRENCY`) that pick queued
 * tasks up one at a time. This node draws that pool, named for what it does.
 *
 * Visually distinct from a desk on purpose - a ring rather than a room - so it
 * reads as infrastructure the tasks pass through, not another worker.
 */
export const DispatchNode = memo(function DispatchNode({
  orchestrator,
}: {
  orchestrator: OfficeOrchestrator;
}) {
  const centre = project(DISPATCH_LAYOUT.center);
  const load = orchestrator.capacity > 0 ? orchestrator.busy / orchestrator.capacity : 0;

  return (
    <g transform={`translate(${centre.x} ${centre.y})`} aria-hidden="true">
      <ellipse cx="0" cy="6" rx="44" ry="14" fill="rgb(0 0 0 / 0.06)" />

      <circle
        r="30"
        fill="rgb(var(--surface-raised))"
        stroke="rgb(var(--surface-strong))"
        strokeWidth="1.4"
      />
      {/* Load ring: how much of the worker pool is occupied right now. */}
      <circle
        r="30"
        fill="none"
        stroke={DISPATCH_TONE[orchestrator.state]}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${2 * Math.PI * 30 * load} ${2 * Math.PI * 30}`}
        transform="rotate(-90)"
        className={orchestrator.state === 'dispatching' ? 'office-dispatch-pulse' : undefined}
      />

      <text textAnchor="middle" fontSize="13" y="-7">
        {'⇄'}
      </text>
      <text
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="600"
        y="5"
        fill="rgb(var(--content-muted))"
      >
        {orchestrator.label}
      </text>

      {/* Inside the ring: below it is the Operations room label. */}
      <text
        textAnchor="middle"
        fontSize="7"
        y="16"
        fill="rgb(var(--content-subtle))"
        className="tabular-nums"
      >
        {`${orchestrator.busy}/${orchestrator.capacity} busy`}
      </text>
    </g>
  );
});

const DISPATCH_TONE: Readonly<Record<OfficeOrchestrator['state'], string>> = {
  idle: 'rgb(var(--state-idle))',
  dispatching: 'rgb(var(--state-running))',
  saturated: 'rgb(var(--state-waiting))',
  offline: 'rgb(var(--content-subtle))',
};
