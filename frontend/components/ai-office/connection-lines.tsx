'use client';

import { memo } from 'react';
import type { OfficeConnection } from '@/lib/office/model';
import {
  DISPATCH_LAYOUT,
  bowPath,
  edgeAnchor,
  project,
  roomById,
  type Point,
} from '@/lib/office/layout';

/**
 * The routes tasks are actually taking.
 *
 * Each line is an edge from `buildOfficeModel`: a room occupied through the
 * dispatch point, or a room a task walked out of into the next. No line joins
 * two agents - Cartenz runs one agent per task, so there is no agent-to-agent
 * relationship to draw. An edge flows only while a task on it is moving or
 * running; otherwise it is a faint presence line.
 *
 * Colour: the track is drawn in the running-state blue rather than the brand
 * accent. The accent is a red, and a red line across the floor reads as an
 * alarm rather than as traffic; failure is the only thing on this floor allowed
 * to be red.
 */
export const ConnectionLines = memo(function ConnectionLines({
  connections,
  dimmedIds,
}: {
  connections: OfficeConnection[];
  /** Connections whose every agent is filtered out; drawn faint, never removed. */
  dimmedIds: ReadonlySet<string>;
}) {
  return (
    <g aria-hidden="true" fill="none">
      {connections.map((connection) => {
        const path = bowPath(
          anchor(connection.from, connection.to),
          anchor(connection.to, connection.from),
        );
        const dimmed = dimmedIds.has(connection.id);
        return (
          <g
            key={connection.id}
            data-connection={connection.id}
            style={{ opacity: dimmed ? 0.25 : 1 }}
          >
            {/* The bed of the route: a wide, soft pass that makes the line feel
                laid into the floor rather than drawn on top of it. */}
            <path
              d={path}
              stroke="rgb(var(--state-running) / 0.1)"
              strokeWidth={9 + Math.min(connection.agentIds.length, 4)}
              strokeLinecap="round"
            />
            <path
              d={path}
              stroke={
                connection.active
                  ? 'rgb(var(--state-running) / 0.7)'
                  : 'rgb(var(--state-running) / 0.28)'
              }
              strokeWidth={2.6 + Math.min(connection.agentIds.length, 4) * 0.5}
              strokeLinecap="round"
            />
            {/* The travelling dashes: only while something really is moving. */}
            <path
              d={path}
              stroke={
                connection.active ? 'rgb(var(--state-running))' : 'rgb(var(--state-running) / 0.4)'
              }
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeDasharray="6 8"
              className={connection.active ? 'office-flow' : undefined}
            />
          </g>
        );
      })}
    </g>
  );
});

type End = OfficeConnection['from'];

/** A floor point for an end, so a room can pick the edge facing the other end. */
function floorPoint(end: End): Point {
  if (end === 'dispatch') return DISPATCH_LAYOUT.center;
  const room = roomById(end);
  return { x: room.origin.x + room.width / 2, y: room.origin.y + room.depth / 2 };
}

/** Where a route attaches: the dispatch centre, or the room edge facing `other`. */
function anchor(end: End, other: End): Point {
  if (end === 'dispatch') return project(DISPATCH_LAYOUT.center);
  return edgeAnchor(roomById(end), floorPoint(other));
}
