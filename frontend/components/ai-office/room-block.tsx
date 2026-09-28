'use client';

import { memo } from 'react';
import type { AiOfficePhase } from '@/lib/types';
import type { OfficeDepartment, OfficeEmphasis } from '@/lib/office/model';
import {
  floorPath,
  floorSlabPaths,
  project,
  roomById,
  signAnchor,
  SIGN_LIFT_OVER_WALL,
  type Point,
  type RoomLayout,
} from '@/lib/office/layout';

/**
 * One room, drawn as a diorama: a floor slab with visible thickness, two back
 * walls with a lit cap, its own furniture, and a signage plate.
 *
 * Only the room is drawn here. People are drawn by the canvas afterwards, in
 * depth order across every room, so a figure standing at the front of one room
 * is never painted over by the wall of the room behind it.
 *
 * The room's own moving parts are tied to data: Quality's test light and the
 * Operations server rack blink only while a task occupies that room.
 */
export const RoomBlock = memo(function RoomBlock({
  department,
  emphasis,
}: {
  department: OfficeDepartment;
  emphasis: OfficeEmphasis;
}) {
  const room = roomById(department.id);
  const { origin, width, depth, wallHeight } = room;

  const back = project(origin);
  const right = project({ x: origin.x + width, y: origin.y });
  const left = project({ x: origin.x, y: origin.y + depth });
  const floor = floorPath(origin, width, depth);
  const slab = floorSlabPaths(origin, width, depth, 10);
  const signAt = signAnchor(room);

  const focused = emphasis === 'focused';

  return (
    <g
      className="office-room"
      style={{ opacity: emphasis === 'dimmed' ? 0.4 : 1 }}
      data-room={department.id}
      data-emphasis={emphasis}
      aria-hidden="true"
    >
      {/* The slab's side faces, under the floor, so the room stands on ground.
          `surface-strong` rather than `surface-overlay`: on the light theme the
          overlay is near-white and the slab vanished into the page. */}
      <path d={slab.right} fill="rgb(var(--surface-strong) / 0.55)" />
      <path d={slab.front} fill="rgb(var(--surface-strong) / 0.4)" />

      {/* Floor: a base tone, then the room's tint, then its own light pool. */}
      <path d={floor} fill="rgb(var(--surface-raised))" />
      <path d={floor} fill={ROOM_TINT[department.id]} />
      <path d={floor} fill={`url(#pool-${department.id})`} opacity={department.busy ? 1 : 0.55} />
      <FloorGrid room={room} />

      {/* Two back walls meeting at the room's back corner. The right wall is
          lighter than the left, so the corner reads as a corner. */}
      <path
        d={wallPath(back, left, wallHeight)}
        fill="rgb(var(--surface-overlay) / 0.85)"
        stroke="rgb(var(--surface-border))"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path
        d={wallPath(back, right, wallHeight)}
        fill="rgb(var(--surface-overlay) / 0.45)"
        stroke="rgb(var(--surface-border))"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* Lit wall caps: the top edge of each wall, brighter than the wall. */}
      <path d={wallCap(back, left, wallHeight)} fill="rgb(var(--surface-strong) / 0.9)" />
      <path d={wallCap(back, right, wallHeight)} fill="rgb(var(--surface-strong) / 0.65)" />

      <RoomAccent id={department.id} room={room} busy={department.busy} />

      <path
        d={floor}
        fill="none"
        stroke={
          focused
            ? `rgb(${ROOM_LIGHT[department.id]} / 0.85)`
            : department.busy
              ? `rgb(${ROOM_LIGHT[department.id]} / 0.5)`
              : 'rgb(var(--surface-strong) / 0.8)'
        }
        strokeWidth={focused ? 1.8 : 1.1}
      />

      <RoomSign
        x={signAt.x}
        y={signAt.y - wallHeight - SIGN_LIFT}
        name={department.name}
        active={department.agentIds.length}
        desks={department.desks}
        focused={focused}
      />
    </g>
  );
});

/** How far the sign plate hangs above the wall's top. */
const SIGN_LIFT = SIGN_LIFT_OVER_WALL;

/**
 * The room's name plate: a signage board carrying the room's name and its
 * occupancy, rather than bare floating text.
 */
function RoomSign({
  x,
  y,
  name,
  active,
  desks,
  focused,
}: {
  x: number;
  y: number;
  name: string;
  active: number;
  desks: number;
  focused: boolean;
}) {
  const label = name.toUpperCase();
  const count = `${active}/${desks}`;
  // Generous per-character estimates (bold, letter-spaced uppercase for the
  // name; bold tabular digits for the count) plus an explicit margin either
  // side of the divider. Tight math here is what let "DEVELOPMENT" run into its
  // own count badge; a wide estimate costs nothing but a slightly longer plate.
  const labelWidth = label.length * 9.6;
  const countWidth = count.length * 7.2;
  const gap = 22;
  const padding = 22;
  const width = labelWidth + countWidth + gap + padding;
  const dividerX = width / 2 - padding / 2 - countWidth - gap / 2;
  const height = 19;

  return (
    <g transform={`translate(${x} ${y})`}>
      {/* A short hanger from the plate down to the wall's top corner, so the
          sign visibly belongs to this room instead of floating near it. */}
      <line
        x1="0"
        x2="0"
        y1={height / 2}
        y2={SIGN_LIFT}
        stroke="rgb(var(--content-subtle))"
        strokeWidth="1.2"
      />
      <circle cx="0" cy={SIGN_LIFT} r="2" fill="rgb(var(--content-subtle))" />
      <rect
        x={-width / 2}
        y={-height / 2}
        width={width}
        height={height}
        rx="4"
        fill="rgb(var(--surface))"
        stroke={focused ? 'rgb(var(--accent) / 0.6)' : 'rgb(var(--surface-strong))'}
        strokeWidth="1"
      />
      <text
        x={-width / 2 + padding / 2}
        y="4"
        fontSize="10.5"
        fontWeight="600"
        letterSpacing="0.09em"
        fill="rgb(var(--content-muted))"
      >
        {label}
      </text>
      <line
        x1={dividerX}
        x2={dividerX}
        y1={-5}
        y2={5}
        stroke="rgb(var(--surface-strong))"
        strokeWidth="1"
      />
      <text
        x={width / 2 - padding / 2}
        y="4"
        textAnchor="end"
        fontSize="9"
        fontWeight="600"
        className="tabular-nums"
        fill={active > 0 ? 'rgb(var(--state-running))' : 'rgb(var(--content-subtle))'}
      >
        {count}
      </text>
    </g>
  );
}

/** The lit strip capping a wall, in drawing coordinates. */
function wallCap(from: Point, to: Point, height: number, cap = 3): string {
  const topFrom = from.y - height;
  const topTo = to.y - height;
  return `M${from.x} ${topFrom} L${to.x} ${topTo} L${to.x} ${topTo - cap} L${from.x} ${topFrom - cap} Z`;
}

function wallPath(from: Point, to: Point, height: number): string {
  return `M${from.x} ${from.y} L${to.x} ${to.y} L${to.x} ${to.y - height} L${from.x} ${from.y - height} Z`;
}

/** Faint floor tiles, drawn in floor space so they follow the perspective. */
function FloorGrid({ room }: { room: RoomLayout }) {
  const lines: string[] = [];
  const step = 40;
  for (let x = room.origin.x + step; x < room.origin.x + room.width; x += step) {
    const a = project({ x, y: room.origin.y });
    const b = project({ x, y: room.origin.y + room.depth });
    lines.push(`M${a.x} ${a.y}L${b.x} ${b.y}`);
  }
  for (let y = room.origin.y + step; y < room.origin.y + room.depth; y += step) {
    const a = project({ x: room.origin.x, y });
    const b = project({ x: room.origin.x + room.width, y });
    lines.push(`M${a.x} ${a.y}L${b.x} ${b.y}`);
  }
  return (
    <path d={lines.join('')} stroke="rgb(var(--surface-border))" strokeWidth="0.6" opacity="0.55" />
  );
}

const ROOM_TINT: Readonly<Record<AiOfficePhase, string>> = {
  research: 'rgb(96 165 250 / 0.16)',
  development: 'rgb(74 222 128 / 0.14)',
  quality: 'rgb(250 204 21 / 0.17)',
  operations: 'rgb(192 132 252 / 0.16)',
};

/** The colour a room's own ceiling light pools on its floor. */
export const ROOM_LIGHT: Readonly<Record<AiOfficePhase, string>> = {
  research: '96 165 250',
  development: '74 222 128',
  quality: '250 204 21',
  operations: '192 132 252',
};

/**
 * A department's one distinctive piece, hung high on its right-hand back wall.
 *
 * The wall runs back -> right, so a point along it is `origin + t * width` on
 * x, and the piece is skewed to the wall's slope so it reads as mounted rather
 * than floating. It hangs from just under the wall's lit cap and sits past the
 * room's name plate (near t=0.3), sized small enough to stay on the wall face.
 * Task cards are drawn later, in front of the walls, so a card may cover part
 * of a piece; it never covers the reverse.
 */
const WALL_PROP: Readonly<Record<AiOfficePhase, { width: number; height: number; along: number }>> =
  {
    research: { width: 34, height: 30, along: 0.42 },
    development: { width: 44, height: 26, along: 0.42 },
    quality: { width: 34, height: 30, along: 0.42 },
    operations: { width: 28, height: 34, along: 0.42 },
  };

function RoomAccent({ id, room, busy }: { id: AiOfficePhase; room: RoomLayout; busy: boolean }) {
  const prop = WALL_PROP[id];
  const at = project({ x: room.origin.x + room.width * prop.along, y: room.origin.y });
  // Mounted 2px below the wall's lit cap, so the piece hangs on the wall face.
  const top = at.y - room.wallHeight + 2;
  // Wall slope in the drawing: dy/dx of the back->right edge.
  const skew = Math.atan2(0.5, 0.866) * (180 / Math.PI);
  const transform = `translate(${at.x} ${top}) skewY(${skew.toFixed(2)})`;
  const { width, height } = prop;

  if (id === 'research') {
    return (
      <g transform={transform}>
        <rect width={width} height={height} rx="1.5" fill="#a57a52" />
        {[0, 1].map((shelf) => (
          <g key={shelf} transform={`translate(3 ${3 + shelf * 13.5})`}>
            <rect y="10.5" width={width - 6} height="1.4" fill="#7d5a3a" />
            {[0, 1, 2, 3].map((book) => (
              <rect
                key={book}
                x={book * 7}
                y={2 - ((book + shelf) % 2)}
                width="5.5"
                height={9 + ((book + shelf) % 2)}
                rx="0.5"
                fill={BOOK_COLORS[(book + shelf * 2) % BOOK_COLORS.length]}
              />
            ))}
          </g>
        ))}
      </g>
    );
  }

  if (id === 'development') {
    return (
      <g transform={transform}>
        <rect width={width} height={height} rx="1.5" fill="#23272f" />
        <g fontFamily="ui-monospace, monospace" fontSize="4.4" fill="#9fd08a">
          <text x="3" y="8.5">
            {'def action():'}
          </text>
          <text x="7" y="15" fill="#8fb8e8">
            {'self.ensure()'}
          </text>
          <text x="7" y="21.5" fill="#e8c38f">
            {'return True'}
          </text>
        </g>
      </g>
    );
  }

  if (id === 'quality') {
    return (
      <g transform={transform}>
        <rect
          width={width}
          height={height}
          rx="1.5"
          fill="rgb(var(--surface-raised))"
          stroke="rgb(var(--surface-strong))"
          strokeWidth="0.8"
        />
        {[0, 1, 2].map((row) => (
          <g key={row} transform={`translate(3 ${5 + row * 8})`}>
            <rect
              width="4.5"
              height="4.5"
              rx="0.8"
              fill="none"
              stroke="#8a8f99"
              strokeWidth="0.8"
            />
            {row < 2 ? (
              <path
                d="M0.8 2.2 L1.9 3.4 L3.5 0.9"
                stroke="rgb(var(--state-success))"
                strokeWidth="0.9"
                fill="none"
                strokeLinecap="round"
              />
            ) : null}
            <rect x="7" y="1.4" width={row === 1 ? 16 : 21} height="1.5" rx="0.8" fill="#c9ccd2" />
          </g>
        ))}
        <circle
          cx={width - 5}
          cy="5"
          r="2.1"
          fill={busy ? 'rgb(var(--state-running))' : '#c9ccd2'}
          className={busy ? 'office-blink' : undefined}
        />
      </g>
    );
  }

  return (
    <g transform={transform}>
      <rect width={width} height={height} rx="1.5" fill="#2d3139" />
      {[0, 1, 2, 3].map((unit) => (
        <g key={unit} transform={`translate(3 ${3 + unit * 7.8})`}>
          <rect width={width - 6} height="6" rx="1" fill="#3b404a" />
          <rect x="3" y="2.2" width="9" height="1.6" rx="0.8" fill="#555c68" />
          <circle
            cx={width - 12}
            cy="3"
            r="1.2"
            fill={busy ? '#6fdc7a' : '#4a5a4c'}
            className={busy ? `office-blink office-blink-${unit % 3}` : undefined}
          />
          <circle
            cx={width - 8}
            cy="3"
            r="1.2"
            fill={busy ? '#6fb8ff' : '#48525e'}
            className={busy ? `office-blink office-blink-${(unit + 1) % 3}` : undefined}
          />
        </g>
      ))}
    </g>
  );
}

const BOOK_COLORS = ['#2f6fb8', '#b85a2f', '#5f8f35', '#7a4f9e', '#c28a1c', '#2f8f8f'];
