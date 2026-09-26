'use client';

import { useEffect, useState } from 'react';
import type { AiOfficeCard, AiOfficePhase } from '@/lib/types';
import { EmptyDeskArt, FigureArt, poseLabel } from './agent-figure';

/**
 * One room of the office, drawn (ADR-066 phase 4).
 *
 * The furniture is decoration; the people are not. Every person in the room is
 * a live task in this phase, placed at a desk in the order the board returned
 * them, and a desk without a task stays empty with its chair pushed in. The
 * few moving parts of the room itself are tied to data too: the wall clock is
 * the viewer's real time, and the Operations server rack blinks only while an
 * Operations task is actually running.
 */

/** Desk slots in the room's 280x250 drawing, two rows of two. */
const SLOTS = [
  { x: 14, y: 70 },
  { x: 146, y: 70 },
  { x: 14, y: 156 },
  { x: 146, y: 156 },
] as const;

const DESK_SCALE = 1.45;

export const ROOM_DESKS = SLOTS.length;

export function RoomScene({
  phase,
  name,
  cards,
  selectedId,
  onSelect,
}: {
  phase: AiOfficePhase;
  name: string;
  cards: AiOfficeCard[];
  selectedId: string | null;
  onSelect: (card: AiOfficeCard) => void;
}) {
  const seated = cards.slice(0, SLOTS.length);
  const overflow = cards.length - seated.length;

  return (
    <svg
      viewBox="0 0 280 250"
      className="block h-auto w-full select-none"
      role="group"
      aria-label={`${name} room, ${cards.length === 0 ? 'no one working' : `${cards.length} working`}`}
    >
      <Wall phase={phase} busy={cards.length > 0} />

      {SLOTS.map((slot, index) => {
        const card = seated[index];
        const transform = `translate(${slot.x} ${slot.y}) scale(${DESK_SCALE})`;

        if (!card) {
          return (
            <g key={`empty-${index}`} transform={transform}>
              <EmptyDeskArt />
            </g>
          );
        }

        const selected = selectedId === card.taskId;
        return (
          <g
            key={card.taskId}
            transform={transform}
            role="button"
            tabIndex={0}
            aria-label={`${card.projectName}: ${poseLabel(card.status)}. ${card.prompt}`}
            className="office-seat cursor-pointer outline-none"
            onClick={() => onSelect(card)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(card);
              }
            }}
          >
            <title>{`${card.projectName} - ${poseLabel(card.status)}`}</title>
            {selected ? (
              <rect
                x="2"
                y="-3"
                width="62"
                height="66"
                rx="6"
                fill="rgb(var(--accent) / 0.08)"
                stroke="rgb(var(--accent))"
                strokeWidth="0.9"
              />
            ) : null}
            <g className="office-desk-arrive">
              <FigureArt taskId={card.taskId} status={card.status} variant={index} />
            </g>
            <NameTag text={card.projectName} />
          </g>
        );
      })}

      {overflow > 0 ? (
        <g transform="translate(236 226)">
          <rect x="0" y="0" width="36" height="18" rx="9" fill="rgb(var(--state-running))" />
          <text
            x="18"
            y="12.5"
            textAnchor="middle"
            fontSize="10"
            fontWeight="600"
            fill="#fff"
          >{`+${overflow}`}</text>
        </g>
      ) : null}
    </svg>
  );
}

/** The project name on a small plate under the desk, truncated to fit. */
function NameTag({ text }: { text: string }) {
  const label = text.length > 16 ? `${text.slice(0, 15)}…` : text;
  return (
    <g transform="translate(33 62.5)">
      <rect
        x={-label.length * 1.55 - 3}
        y="-4"
        width={label.length * 3.1 + 6}
        height="7"
        rx="3.5"
        fill="rgb(var(--surface-raised))"
        stroke="rgb(var(--surface-border))"
        strokeWidth="0.5"
      />
      <text
        x="0"
        y="1.4"
        textAnchor="middle"
        fontSize="4.6"
        fontWeight="500"
        fill="rgb(var(--content-muted))"
      >
        {label}
      </text>
    </g>
  );
}

/** Back wall, floor line and the room's furniture. */
function Wall({ phase, busy }: { phase: AiOfficePhase; busy: boolean }) {
  return (
    <g aria-hidden="true">
      {/* Wall and skirting. */}
      <rect x="0" y="0" width="280" height="64" fill="rgb(var(--surface-overlay))" />
      <rect x="0" y="62" width="280" height="3" fill="rgb(var(--surface-border))" />
      {/* Floor planks, faint. */}
      {[96, 132, 168, 204, 240].map((y) => (
        <line
          key={y}
          x1="0"
          x2="280"
          y1={y}
          y2={y}
          stroke="rgb(var(--surface-border))"
          strokeWidth="0.6"
          opacity="0.6"
        />
      ))}

      <Window x={16} />
      <WallClock x={138} />
      <Plant x={250} />

      {phase === 'research' ? <Bookshelf x={176} /> : null}
      {phase === 'development' ? <CodeBoard x={172} /> : null}
      {phase === 'quality' ? <ChecklistBoard x={176} busy={busy} /> : null}
      {phase === 'operations' ? <ServerRack x={180} busy={busy} /> : null}
    </g>
  );
}

function Window({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 10)`}>
      <rect
        width="52"
        height="40"
        rx="2"
        fill="rgb(var(--surface-raised))"
        stroke="rgb(var(--surface-strong))"
        strokeWidth="1.5"
      />
      <rect x="3" y="3" width="46" height="34" fill="#bfdcf2" opacity="0.75" />
      {/* Distant skyline. */}
      <path
        d="M3 37 L3 27 L9 27 L9 22 L15 22 L15 29 L22 29 L22 19 L28 19 L28 26 L35 26 L35 23 L41 23 L41 30 L49 30 L49 37 Z"
        fill="#8fb3cf"
        opacity="0.8"
      />
      <circle cx="40" cy="11" r="4" fill="#fff4c2" opacity="0.9" />
      <line x1="26" y1="3" x2="26" y2="37" stroke="rgb(var(--surface-strong))" strokeWidth="1.2" />
      <line x1="3" y1="20" x2="49" y2="20" stroke="rgb(var(--surface-strong))" strokeWidth="1.2" />
    </g>
  );
}

/** A clock showing the viewer's real local time, updated each minute. */
function WallClock({ x }: { x: number }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const minutes = now ? now.getMinutes() : 0;
  const hours = now ? (now.getHours() % 12) + minutes / 60 : 0;
  const minuteAngle = minutes * 6;
  const hourAngle = hours * 30;

  return (
    <g transform={`translate(${x} 30)`}>
      <circle
        r="14"
        fill="rgb(var(--surface-raised))"
        stroke="rgb(var(--surface-strong))"
        strokeWidth="2"
      />
      {[0, 90, 180, 270].map((angle) => (
        <line
          key={angle}
          x1="0"
          y1="-11"
          x2="0"
          y2="-9"
          stroke="rgb(var(--content-subtle))"
          strokeWidth="1.2"
          transform={`rotate(${angle})`}
        />
      ))}
      {now ? (
        <>
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="-6.5"
            stroke="rgb(var(--content))"
            strokeWidth="1.8"
            strokeLinecap="round"
            transform={`rotate(${hourAngle})`}
          />
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="-10"
            stroke="rgb(var(--content-muted))"
            strokeWidth="1.2"
            strokeLinecap="round"
            transform={`rotate(${minuteAngle})`}
          />
        </>
      ) : null}
      <circle r="1.4" fill="rgb(var(--accent))" />
    </g>
  );
}

function Plant({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 22)`}>
      <path d="M0 22 Q-10 10 -8 0 Q-2 8 0 14 Q2 4 8 -2 Q10 10 0 22 Z" fill="#5f9a4a" />
      <path d="M0 22 Q-4 6 2 -6 Q4 8 0 22 Z" fill="#78b35d" />
      <path d="M-7 22 L7 22 L5 38 L-5 38 Z" fill="#c07a4f" />
      <rect x="-8" y="20" width="16" height="4" rx="1" fill="#a9653e" />
    </g>
  );
}

function Bookshelf({ x }: { x: number }) {
  const books = ['#2f6fb8', '#b85a2f', '#5f8f35', '#7a4f9e', '#c28a1c', '#2f8f8f', '#b8465f'];
  return (
    <g transform={`translate(${x} 8)`}>
      <rect width="56" height="54" rx="2" fill="#a57a52" />
      {[0, 1, 2].map((shelf) => (
        <g key={shelf} transform={`translate(4 ${4 + shelf * 17})`}>
          <rect y="13" width="48" height="2" fill="#7d5a3a" />
          {books.map((color, index) => (
            <rect
              key={color}
              x={index * 6.6 + (shelf % 2) * 1.5}
              y={shelf === 1 && index === 3 ? 3 : 1 + ((index + shelf) % 3)}
              width="5"
              height={12 - ((index + shelf) % 3)}
              rx="0.6"
              fill={color}
              opacity={index + shelf === 6 ? 0 : 0.9}
            />
          ))}
        </g>
      ))}
    </g>
  );
}

function CodeBoard({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 10)`}>
      <rect
        width="62"
        height="42"
        rx="2"
        fill="#23272f"
        stroke="rgb(var(--surface-strong))"
        strokeWidth="1.5"
      />
      <g fontFamily="ui-monospace, monospace" fontSize="5" fill="#9fd08a">
        <text x="5" y="10">
          {'def action():'}
        </text>
        <text x="11" y="18" fill="#8fb8e8">
          {'self.ensure()'}
        </text>
        <text x="11" y="26" fill="#e8c38f">
          {'return True'}
        </text>
      </g>
      <rect x="5" y="31" width="20" height="2" rx="1" fill="#555c68" />
      <rect x="5" y="35" width="32" height="2" rx="1" fill="#555c68" />
    </g>
  );
}

/** A test board. Its ticks are static; only the "running" light reflects data. */
function ChecklistBoard({ x, busy }: { x: number; busy: boolean }) {
  return (
    <g transform={`translate(${x} 8)`}>
      <rect
        width="56"
        height="48"
        rx="2"
        fill="#fbfaf4"
        stroke="rgb(var(--surface-strong))"
        strokeWidth="1.5"
      />
      {[0, 1, 2, 3].map((row) => (
        <g key={row} transform={`translate(6 ${8 + row * 10})`}>
          <rect width="6" height="6" rx="1" fill="none" stroke="#8a8f99" strokeWidth="0.8" />
          {row < 3 ? (
            <path
              d="M1.2 3 L2.7 4.6 L5 1.4"
              stroke="rgb(var(--state-success))"
              strokeWidth="1"
              fill="none"
              strokeLinecap="round"
            />
          ) : null}
          <rect x="10" y="2" width={row === 1 ? 22 : 30} height="2" rx="1" fill="#c9ccd2" />
        </g>
      ))}
      <circle
        cx="49"
        cy="7"
        r="2.6"
        fill={busy ? 'rgb(var(--state-running))' : '#c9ccd2'}
        className={busy ? 'office-blink' : undefined}
      />
    </g>
  );
}

/** A server rack whose lights blink only while an Operations task runs. */
function ServerRack({ x, busy }: { x: number; busy: boolean }) {
  return (
    <g transform={`translate(${x} 4)`}>
      <rect width="42" height="58" rx="2" fill="#2d3139" />
      {[0, 1, 2, 3, 4].map((unit) => (
        <g key={unit} transform={`translate(4 ${5 + unit * 10.5})`}>
          <rect width="34" height="8" rx="1" fill="#3b404a" />
          <rect x="3" y="3" width="14" height="2" rx="1" fill="#555c68" />
          <circle
            cx="24"
            cy="4"
            r="1.4"
            fill={busy ? '#6fdc7a' : '#4a5a4c'}
            className={busy ? `office-blink office-blink-${unit % 3}` : undefined}
          />
          <circle
            cx="29"
            cy="4"
            r="1.4"
            fill={busy ? '#6fb8ff' : '#48525e'}
            className={busy ? `office-blink office-blink-${(unit + 1) % 3}` : undefined}
          />
        </g>
      ))}
    </g>
  );
}
