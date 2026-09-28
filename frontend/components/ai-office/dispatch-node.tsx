'use client';

import { memo } from 'react';
import type { OfficeOrchestrator } from '@/lib/office/model';
import {
  DISPATCH_HEIGHT,
  DISPATCH_LAYOUT,
  DISPATCH_RX,
  DISPATCH_RY,
  project,
} from '@/lib/office/layout';

/**
 * The dispatch point: where a task is picked up by a worker.
 *
 * This is not "Hermes the orchestrator" - Cartenz has no multi-agent
 * coordinator; Hermes is one LLM provider among several a task can be
 * configured to use (ADR-018). What is real here is the worker pool: a fixed
 * number of concurrent slots (`AGENT_WORKER_CONCURRENCY`) that pick queued
 * tasks up one at a time. This node draws that pool, named for what it does.
 *
 * Drawn as a round plinth on the open floor, in the same isometric projection
 * as the rooms, so it reads as a physical place tasks pass through. Around its
 * top sits one segment per worker slot: a lit segment is a slot the backend
 * reports as held (`queue.running`), never a count recomputed here.
 */
export const DispatchNode = memo(function DispatchNode({
  orchestrator,
}: {
  orchestrator: OfficeOrchestrator;
}) {
  const centre = project(DISPATCH_LAYOUT.center);
  const rx = DISPATCH_RX;
  const ry = DISPATCH_RY;
  const height = DISPATCH_HEIGHT;
  const tone = DISPATCH_TONE[orchestrator.state];
  const slots = Math.max(orchestrator.capacity, 0);

  return (
    <g transform={`translate(${centre.x} ${centre.y})`} aria-hidden="true">
      {/* Ground shadow. */}
      <ellipse cx="0" cy={height + 4} rx={rx + 10} ry={ry + 5} fill="rgb(0 0 0 / 0.14)" />

      {/* Plinth side: an ellipse band between the top and bottom rims. */}
      <path
        d={`M${-rx} 0 L${-rx} ${height} A${rx} ${ry} 0 0 0 ${rx} ${height} L${rx} 0 Z`}
        fill="rgb(var(--surface-overlay))"
        stroke="rgb(var(--surface-border))"
        strokeWidth="1"
      />
      {/* Plinth top. */}
      <ellipse
        cx="0"
        cy="0"
        rx={rx}
        ry={ry}
        fill="rgb(var(--surface-raised))"
        stroke="rgb(var(--surface-strong))"
        strokeWidth="1.2"
      />
      {/* A soft light on the top, in the pool's state colour. */}
      <ellipse cx="0" cy="0" rx={rx - 6} ry={ry - 3.5} fill={tone} opacity="0.08" />

      {/* One segment per worker slot around the rim. */}
      <g className={orchestrator.state === 'dispatching' ? 'office-dispatch-pulse' : undefined}>
        {Array.from({ length: slots }, (_, index) => (
          <path
            key={index}
            d={slotArc(index, slots, rx - 3, ry - 1.8)}
            stroke={index < orchestrator.busy ? tone : 'rgb(var(--surface-strong) / 0.7)'}
            strokeWidth="3"
            strokeLinecap="round"
            fill="none"
            data-slot={index < orchestrator.busy ? 'busy' : 'free'}
          />
        ))}
      </g>

      <text
        textAnchor="middle"
        fontSize="8.5"
        fontWeight="700"
        letterSpacing="0.1em"
        y="-1"
        fill="rgb(var(--content-muted))"
      >
        {orchestrator.label}
      </text>
      <text
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="600"
        y="9"
        fill={orchestrator.busy > 0 ? tone : 'rgb(var(--content-subtle))'}
        className="tabular-nums"
      >
        {`${orchestrator.busy}/${orchestrator.capacity} busy`}
      </text>
    </g>
  );
});

/**
 * An arc for slot `index` of `count` around an ellipse, with a small gap
 * between neighbours so each slot reads as one.
 */
function slotArc(index: number, count: number, rx: number, ry: number): string {
  if (count <= 0) return '';
  const gap = count > 1 ? 0.22 : 0;
  const span = (Math.PI * 2) / count;
  const start = -Math.PI / 2 + index * span + gap / 2;
  const end = start + span - gap;
  const point = (angle: number) => ({ x: Math.cos(angle) * rx, y: Math.sin(angle) * ry });
  const a = point(start);
  if (count === 1) {
    const b = point(start + Math.PI);
    return `M${a.x.toFixed(2)} ${a.y.toFixed(2)} A${rx} ${ry} 0 1 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)} A${rx} ${ry} 0 1 1 ${a.x.toFixed(2)} ${a.y.toFixed(2)}`;
  }
  const b = point(end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M${a.x.toFixed(2)} ${a.y.toFixed(2)} A${rx} ${ry} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

const DISPATCH_TONE: Readonly<Record<OfficeOrchestrator['state'], string>> = {
  idle: 'rgb(var(--state-running))',
  dispatching: 'rgb(var(--state-running))',
  saturated: 'rgb(var(--state-waiting))',
  offline: 'rgb(var(--content-subtle))',
};
