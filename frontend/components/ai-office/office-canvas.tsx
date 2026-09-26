'use client';

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import {
  agentEmphasis,
  departmentEmphasis,
  type OfficeAgent,
  type OfficeEmphasis,
  type OfficeFilters,
  type OfficeModel,
} from '@/lib/office/model';
import {
  DEFAULT_VIEWPORT,
  INITIAL_CAMERA,
  cameraReducer,
  cameraTransform,
} from '@/lib/office/camera';
import { ROOM_LAYOUT, WORLD, deskLayout } from '@/lib/office/layout';
import { RoomBlock } from './room-block';
import { OfficeDesk } from './office-desk';
import { DispatchNode } from './dispatch-node';
import { ConnectionLines } from './connection-lines';

/**
 * The isometric 2D renderer.
 *
 * It draws a `OfficeModel` and reports clicks. It knows nothing about REST
 * payloads, statuses or agents beyond the shape of `OfficeAgent`, which is what
 * would let a future Three.js renderer replace this file without touching the
 * mapping in `lib/office`.
 *
 * What the floor looks like, and why each moving part is allowed to move:
 *
 * - Desks are placed by `deskLayout` in floor space, so a room's size decides
 *   the spacing. Empty desks are still drawn: a quiet office should look quiet,
 *   not broken.
 * - Everything is painted in one depth order (projected y). Within a room the
 *   near desks paint over the far ones; across rooms the front rooms paint over
 *   the back ones. Without a single sorted pass, a person walks behind a wall.
 * - Animations: `office-flow` on an active route, `office-dispatch-pulse` while
 *   a task is changing state, and the figure's own pose classes. All are
 *   disabled under `prefers-reduced-motion` (globals.css).
 * - Dimming under a filter is opacity, never removal, so the floor always shows
 *   every task the backend reports.
 */
export const OfficeCanvas = memo(function OfficeCanvas({
  model,
  filters,
  selectedId,
  onSelect,
}: {
  model: OfficeModel;
  filters: OfficeFilters;
  selectedId: string | null;
  onSelect: (agent: OfficeAgent) => void;
}) {
  const [camera, setCamera] = useState(INITIAL_CAMERA);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const viewportOf = useCallback(() => {
    const box = frameRef.current?.getBoundingClientRect();
    return box ? { width: box.width, height: box.height } : DEFAULT_VIEWPORT;
  }, []);

  const byId = useMemo(() => {
    const map = new Map<string, OfficeAgent>();
    for (const agent of model.agents) map.set(agent.id, agent);
    return map;
  }, [model.agents]);

  const desks = useMemo(
    () =>
      ROOM_LAYOUT.flatMap((room) => {
        const department = model.departments.find((candidate) => candidate.id === room.id);
        const occupants = department?.agentIds ?? [];
        return deskLayout(room, department?.desks ?? 4).map((desk, index) => ({
          room,
          point: desk.point,
          depth: desk.depth,
          agent: byId.get(occupants[index] ?? '') ?? null,
        }));
      }).sort((a, b) => a.depth - b.depth),
    [byId, model.departments],
  );

  const roomEmphasis = useMemo(() => {
    const map = new Map<string, OfficeEmphasis>();
    for (const department of model.departments) {
      map.set(department.id, departmentEmphasis(department, filters));
    }
    return map;
  }, [filters, model.departments]);

  const dimmedConnections = useMemo(() => {
    const dimmed = new Set<string>();
    for (const connection of model.connections) {
      const all = connection.agentIds.every((id) => {
        const agent = byId.get(id);
        return agent ? agentEmphasis(agent, filters) === 'dimmed' : true;
      });
      if (all) dimmed.add(connection.id);
    }
    return dimmed;
  }, [byId, filters, model.connections]);

  const dispatch = useCallback(
    (action: Parameters<typeof cameraReducer>[1]) =>
      setCamera((current) => cameraReducer(current, action)),
    [],
  );

  return (
    <div
      ref={frameRef}
      className="office-canvas relative overflow-hidden rounded-card border border-surface-border bg-surface-raised"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragRef.current = { x: event.clientX, y: event.clientY };
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        dispatch({
          type: 'pan',
          dx: event.clientX - drag.x,
          dy: event.clientY - drag.y,
          viewport: viewportOf(),
        });
        dragRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      onWheel={(event) => {
        if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 4) return;
        dispatch({ type: 'wheel-zoom', delta: event.deltaY, viewport: viewportOf() });
      }}
    >
      <svg
        className="block h-[clamp(360px,64vh,720px)] w-full touch-pan-y select-none"
        viewBox={`${WORLD.x} ${WORLD.y} ${WORLD.width} ${WORLD.height}`}
        role="group"
        aria-label={`AI Office floor: ${model.agents.length} task${model.agents.length === 1 ? '' : 's'} on the floor`}
      >
        <g transform={cameraTransform(camera)}>
          <ConnectionLines connections={model.connections} dimmedIds={dimmedConnections} />

          {model.departments.map((department) => (
            <RoomBlock
              key={department.id}
              department={department}
              emphasis={departmentEmphasis(department, filters)}
            />
          ))}

          <DispatchNode orchestrator={model.orchestrator} />

          {desks.map((desk, index) => (
            <OfficeDesk
              key={desk.agent?.id ?? `empty-${desk.room.id}-${index}`}
              point={desk.point}
              agent={desk.agent}
              emphasis={
                desk.agent
                  ? agentEmphasis(desk.agent, filters)
                  : (roomEmphasis.get(desk.room.id) ?? 'normal')
              }
              selected={desk.agent !== null && desk.agent.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </g>
      </svg>

      <OfficeControls
        onZoomIn={() => dispatch({ type: 'zoom-in', viewport: viewportOf() })}
        onZoomOut={() => dispatch({ type: 'zoom-out', viewport: viewportOf() })}
        onReset={() => dispatch({ type: 'reset' })}
        zoom={camera.zoom}
      />
    </div>
  );
});

/**
 * Camera controls, as a small overlay. Zoom is never required: the office fits
 * the frame at the default camera, and the buttons exist for looking closer at
 * one room.
 */
function OfficeControls({
  onZoomIn,
  onZoomOut,
  onReset,
  zoom,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  zoom: number;
}) {
  return (
    <div className="absolute bottom-3 right-3 flex flex-col gap-1 rounded-control border border-surface-border bg-surface/90 p-1 backdrop-blur">
      <button type="button" className="office-control" onClick={onZoomIn} aria-label="Zoom in">
        <ZoomIn className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button type="button" className="office-control" onClick={onZoomOut} aria-label="Zoom out">
        <ZoomOut className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button type="button" className="office-control" onClick={onReset} aria-label="Reset view">
        <Maximize2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
      <span className="px-1 pb-0.5 text-center text-caption tabular-nums text-content-subtle">
        {`${Math.round(zoom * 100)}%`}
      </span>
    </div>
  );
}
