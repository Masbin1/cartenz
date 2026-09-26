'use client';

import { memo } from 'react';
import type { AiOfficePhase } from '@/lib/types';
import type { OfficeDepartment, OfficeEmphasis } from '@/lib/office/model';
import { floorPath, project, roomById, type Point, type RoomLayout } from '@/lib/office/layout';

/**
 * One room's floor, back walls, furniture and label.
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

  return (
    <g
      className="office-room"
      style={{ opacity: emphasis === 'dimmed' ? 0.4 : 1 }}
      data-room={department.id}
      data-emphasis={emphasis}
      aria-hidden="true"
    >
      {/* Floor first, so the walls sit on it. */}
      <path d={floor} fill="rgb(var(--surface-raised))" />
      <path d={floor} fill={ROOM_TINT[department.id]} />
      <FloorGrid room={room} />

      {/* Two back walls meeting at the room's back corner. */}
      <path
        d={wallPath(back, left, wallHeight)}
        fill="rgb(var(--surface-overlay))"
        stroke="rgb(var(--surface-border))"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path
        d={wallPath(back, right, wallHeight)}
        fill="rgb(var(--surface-overlay) / 0.7)"
        stroke="rgb(var(--surface-border))"
        strokeWidth="1"
        strokeLinejoin="round"
      />

      <RoomAccent id={department.id} room={room} busy={department.busy} />

      <path
        d={floor}
        fill="none"
        stroke={emphasis === 'focused' ? 'rgb(var(--accent) / 0.55)' : 'rgb(var(--surface-border))'}
        strokeWidth={emphasis === 'focused' ? 1.6 : 1}
      />

      {/* Above the back corner, the walls' highest point, so it never sits on a wall.
          A route can still cross the open floor a label sits on; drawn as two texts
          rather than relying on `paint-order` support, the halo is guaranteed to sit
          behind the glyphs in every renderer. */}
      <RoomLabel x={back.x} y={back.y - wallHeight - 10} text={department.name.toUpperCase()} />
    </g>
  );
});

function RoomLabel({ x, y, text }: { x: number; y: number; text: string }) {
  const shared = {
    x,
    y,
    textAnchor: 'middle' as const,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.08em',
  };
  return (
    <>
      <text {...shared} stroke="rgb(var(--surface))" strokeWidth="3.5" strokeLinejoin="round">
        {text}
      </text>
      <text {...shared} fill="rgb(var(--content-muted))">
        {text}
      </text>
    </>
  );
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
    <path d={lines.join('')} stroke="rgb(var(--surface-border))" strokeWidth="0.6" opacity="0.7" />
  );
}

const ROOM_TINT: Readonly<Record<AiOfficePhase, string>> = {
  research: 'rgb(96 165 250 / 0.07)',
  development: 'rgb(74 222 128 / 0.06)',
  quality: 'rgb(250 204 21 / 0.07)',
  operations: 'rgb(192 132 252 / 0.07)',
};

/**
 * A department's one distinctive piece, hung on its right-hand back wall. The
 * wall runs back -> right, so a point along it is `origin + t * width` on x.
 * The piece is skewed to the wall's slope so it reads as mounted, not floating.
 */
function RoomAccent({ id, room, busy }: { id: AiOfficePhase; room: RoomLayout; busy: boolean }) {
  const at = project({ x: room.origin.x + room.width * 0.62, y: room.origin.y });
  const lift = room.wallHeight * 0.82;
  // Wall slope in the drawing: dy/dx of the back->right edge.
  const skew = Math.atan2(0.5, 0.866) * (180 / Math.PI);
  const transform = `translate(${at.x} ${at.y - lift}) skewY(${skew.toFixed(2)})`;

  if (id === 'research') {
    return (
      <g transform={transform}>
        <rect width="42" height="36" rx="1.5" fill="#a57a52" />
        {[0, 1].map((shelf) => (
          <g key={shelf} transform={`translate(3 ${3 + shelf * 16})`}>
            <rect y="12.5" width="36" height="1.6" fill="#7d5a3a" />
            {[0, 1, 2, 3, 4].map((book) => (
              <rect
                key={book}
                x={book * 7}
                y={2 - ((book + shelf) % 2)}
                width="5.5"
                height={10.5 + ((book + shelf) % 2)}
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
        <rect width="54" height="34" rx="1.5" fill="#23272f" />
        <g fontFamily="ui-monospace, monospace" fontSize="5" fill="#9fd08a">
          <text x="4" y="10">
            {'def action():'}
          </text>
          <text x="9" y="17.5" fill="#8fb8e8">
            {'self.ensure()'}
          </text>
          <text x="9" y="25" fill="#e8c38f">
            {'return True'}
          </text>
        </g>
      </g>
    );
  }

  if (id === 'quality') {
    return (
      <g transform={transform}>
        <rect width="42" height="34" rx="1.5" fill="#fbfaf4" stroke="#c9ccd2" strokeWidth="0.8" />
        {[0, 1, 2].map((row) => (
          <g key={row} transform={`translate(4 ${6 + row * 9})`}>
            <rect width="5" height="5" rx="0.8" fill="none" stroke="#8a8f99" strokeWidth="0.8" />
            {row < 2 ? (
              <path
                d="M1 2.5 L2.2 3.8 L4 1"
                stroke="rgb(var(--state-success))"
                strokeWidth="0.9"
                fill="none"
                strokeLinecap="round"
              />
            ) : null}
            <rect x="8" y="1.5" width={row === 1 ? 18 : 24} height="1.6" rx="0.8" fill="#c9ccd2" />
          </g>
        ))}
        <circle
          cx="36"
          cy="6"
          r="2.3"
          fill={busy ? 'rgb(var(--state-running))' : '#c9ccd2'}
          className={busy ? 'office-blink' : undefined}
        />
      </g>
    );
  }

  return (
    <g transform={transform}>
      <rect width="34" height="44" rx="1.5" fill="#2d3139" />
      {[0, 1, 2, 3].map((unit) => (
        <g key={unit} transform={`translate(3 ${4 + unit * 9.8})`}>
          <rect width="28" height="7.5" rx="1" fill="#3b404a" />
          <rect x="3" y="2.8" width="10" height="1.8" rx="0.9" fill="#555c68" />
          <circle
            cx="20"
            cy="3.7"
            r="1.3"
            fill={busy ? '#6fdc7a' : '#4a5a4c'}
            className={busy ? `office-blink office-blink-${unit % 3}` : undefined}
          />
          <circle
            cx="24.5"
            cy="3.7"
            r="1.3"
            fill={busy ? '#6fb8ff' : '#48525e'}
            className={busy ? `office-blink office-blink-${(unit + 1) % 3}` : undefined}
          />
        </g>
      ))}
    </g>
  );
}

const BOOK_COLORS = ['#2f6fb8', '#b85a2f', '#5f8f35', '#7a4f9e', '#c28a1c', '#2f8f8f'];
