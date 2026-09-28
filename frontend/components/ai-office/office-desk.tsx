'use client';

import { memo } from 'react';
import type { OfficeAgent, OfficeEmphasis } from '@/lib/office/model';
import { STATUS_GLYPHS, STATUS_LABELS } from '@/lib/office/status';
import { project, type Point } from '@/lib/office/layout';
import { FigureArt, EmptyDeskArt } from './agent-figure';

/**
 * A desk and whoever is at it.
 *
 * The figure is the same `FigureArt` used everywhere else in the office, so a
 * person's pose means the same thing on the floor as it does in the drawer. The
 * status chip under it repeats the status in words and a glyph, so the state is
 * never carried by colour alone.
 *
 * The task bubble is drawn only for the states where a human should see what is
 * being worked on without clicking: an approval that has stopped the task, and a
 * running task. A bubble on every desk would turn the floor into a wall of text.
 */
export const OfficeDesk = memo(function OfficeDesk({
  point,
  agent,
  emphasis,
  selected,
  onSelect,
}: {
  point: Point;
  agent: OfficeAgent | null;
  emphasis: OfficeEmphasis;
  selected: boolean;
  onSelect: (agent: OfficeAgent) => void;
}) {
  const at = project({ x: point.x, y: point.y });
  const dimmed = emphasis === 'dimmed';

  return (
    <g
      className="office-desk-slot"
      transform={`translate(${at.x} ${at.y})`}
      style={{ opacity: dimmed ? 0.45 : 1 }}
    >
      {/* Desk shadow and top. */}
      <ellipse cx="4" cy="20" rx="34" ry="9" fill="rgb(0 0 0 / 0.1)" />

      {/* The monitor's light on the desk and floor: the status as light, so a
          working desk glows blue and a failed one red before any text is read. */}
      {agent !== null ? (
        <ellipse
          cx="16"
          cy="4"
          rx="30"
          ry="14"
          fill={`rgb(var(--state-${tone(agent.status)}) / ${agent.status === 'queued' ? 0.06 : 0.16})`}
          className={agent.status === 'running' ? 'office-screen-glow' : undefined}
        />
      ) : null}

      {agent === null ? (
        <g transform="translate(-32 -42)">
          <EmptyDeskArt />
        </g>
      ) : (
        <>
          <g transform="translate(-32 -42)">
            {selected ? (
              <rect
                x="2"
                y="-4"
                width="62"
                height="68"
                rx="7"
                fill="rgb(var(--accent) / 0.1)"
                stroke="rgb(var(--accent))"
                strokeWidth="1"
              />
            ) : null}
            <FigureArt taskId={agent.taskId} status={agent.taskStatus} />
          </g>

          {agent.status === 'approval' || agent.status === 'running' ? (
            <TaskBubble agent={agent} />
          ) : null}

          <StatusChip agent={agent} />
        </>
      )}

      {/* The clickable target. It wraps the desk so the whole workstation is a
          hit area, not just the person's body. */}
      {agent ? (
        <g
          role="button"
          tabIndex={0}
          className="office-seat cursor-pointer outline-none"
          aria-label={`${agent.projectName} ${agent.taskReference}, ${STATUS_LABELS[agent.status]}. ${agent.taskTitleFull}`}
          onClick={() => onSelect(agent)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(agent);
            }
          }}
        >
          <title>{`${agent.projectName} · ${agent.taskReference} — ${STATUS_LABELS[agent.status]}`}</title>
          <rect x="-38" y="-62" width="84" height="82" fill="transparent" />
        </g>
      ) : null}
    </g>
  );
});

/** What the agent is doing, clipped to two short lines. */
function TaskBubble({ agent }: { agent: OfficeAgent }) {
  const width = 116;
  const lines = wrap(agent.taskTitle, 26, 2);
  const cardHeight = lines.length === 1 ? 20 : 30;
  // The figure's head sits around desk-space y ≈ -28 (FigureArt's own local
  // head circle, offset by the desk's -42 placement). The tail should stop
  // just short of that, not float a badge's height above it. An approval
  // figure carries its own "!" badge right above the head, so its card sits
  // higher to leave that badge visible.
  const top = (agent.status === 'approval' ? -47 : -34) - cardHeight;

  return (
    <g transform={`translate(-64 ${top})`} className="office-bubble">
      {/* A soft drop shadow, so the card floats above the floor it sits over. */}
      <rect
        x="1.5"
        y="3"
        width={width}
        height={lines.length === 1 ? 20 : 30}
        rx="6"
        fill="rgb(0 0 0 / 0.38)"
      />
      {/* The tail, pointing down at the person the card belongs to. */}
      <path
        d={`M${width / 2 - 5} ${lines.length === 1 ? 19.5 : 29.5} L${width / 2} ${lines.length === 1 ? 25 : 35} L${width / 2 + 5} ${lines.length === 1 ? 19.5 : 29.5} Z`}
        fill="rgb(var(--surface-raised))"
        stroke={
          agent.status === 'approval'
            ? 'rgb(var(--state-waiting) / 0.6)'
            : 'rgb(var(--surface-strong) / 0.8)'
        }
        strokeWidth="1"
      />
      <rect
        width={width}
        height={lines.length === 1 ? 20 : 30}
        rx="6"
        fill="rgb(var(--surface-raised))"
        stroke={
          agent.status === 'approval'
            ? 'rgb(var(--state-waiting) / 0.6)'
            : 'rgb(var(--surface-strong) / 0.8)'
        }
        strokeWidth="1"
      />
      {/* A status stripe down the card's left edge. */}
      <rect
        x="0"
        y="0"
        width="3"
        height={lines.length === 1 ? 20 : 30}
        rx="1.5"
        fill={`rgb(var(--state-${tone(agent.status)}))`}
      />
      {lines.map((line, index) => (
        <text
          key={index}
          x={width / 2}
          y={index === 0 ? 13 : 23}
          textAnchor="middle"
          fontSize="8.4"
          fontWeight="500"
          fill="rgb(var(--content))"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

/** The status, as a glyph and a word, on a plate under the desk. */
function StatusChip({ agent }: { agent: OfficeAgent }) {
  const label = `${STATUS_GLYPHS[agent.status]} ${STATUS_LABELS[agent.status]}`;
  const width = label.length * 4.9 + 16;
  const state = tone(agent.status);
  // The idle grey is a fine chip fill but too faint as small text on the light
  // floor, so an idle chip writes its label in the muted content colour.
  const ink = state === 'idle' ? 'rgb(var(--content-muted))' : `rgb(var(--state-${state}))`;

  return (
    <g transform="translate(0 30)">
      <rect
        x={-width / 2}
        y="-8"
        width={width}
        height="14"
        rx="7"
        fill={`rgb(var(--surface) / 0.9)`}
        stroke={`rgb(var(--state-${state}) / 0.55)`}
        strokeWidth="0.8"
      />
      <rect
        x={-width / 2}
        y="-8"
        width={width}
        height="14"
        rx="7"
        fill={`rgb(var(--state-${state}) / 0.14)`}
      />
      <text x="0" y="2" textAnchor="middle" fontSize="8.6" fontWeight="600" fill={ink}>
        {label}
      </text>
    </g>
  );
}

function tone(status: OfficeAgent['status']): string {
  if (status === 'running') return 'running';
  if (status === 'waiting') return 'waiting';
  if (status === 'approval') return 'waiting';
  if (status === 'failed' || status === 'cancelled') return 'failure';
  if (status === 'completed') return 'success';
  return 'idle';
}

/** Break a clipped title onto at most `max` lines of `width` characters. */
export function wrap(text: string, width: number, max: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === max) break;
  }

  if (line && lines.length < max) lines.push(line);

  if (lines.length === max) {
    const last = lines[max - 1];
    const consumed = lines.join(' ').length;
    if (consumed < text.length && last.length > width - 1) {
      lines[max - 1] = `${last.slice(0, width - 1)}…`;
    }
  }

  return lines;
}
