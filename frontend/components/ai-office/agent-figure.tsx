'use client';

import { useId } from 'react';
import type { AgentTaskStatus } from '@/lib/types';

/**
 * An agent, drawn as a person at a desk (ADR-066 phase 4).
 *
 * One figure is one task - not a named agent, because Cartenz runs one agent
 * through a fixed state machine. The pose is the task's status and nothing else:
 * a figure types only while its task is running, raises a hand only while its
 * task is parked on an approval, and so on. There is no idle animation that
 * could suggest work a task is not doing.
 *
 * Inline SVG rather than image assets: it takes the theme's colours, needs no
 * asset pipeline or licence, and each part can be animated per state. The art
 * is exposed twice - `FigureArt` as a bare `<g>` for the office scene, which
 * places many figures in one drawing, and `AgentFigure` as a standalone `<svg>`
 * for the task drawer. Both use a 64x64 local coordinate space.
 */

export type Pose = 'working' | 'thinking' | 'waiting' | 'done' | 'failed';

export function poseFor(status: AgentTaskStatus): Pose {
  if (status === 'waiting_approval') return 'waiting';
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'created' || status === 'queued') return 'thinking';
  return 'working';
}

const SKIN_TONES = ['#f1c7a3', '#e0ac85', '#c68a62', '#9c6644', '#7a4e33'];
const HAIR_TONES = ['#2b211c', '#5a3a25', '#1d1b1c', '#8a5a34', '#c9a063', '#6b6b6b'];
const SHIRT_TONES = ['#2f6fb8', '#5f8f35', '#b85a2f', '#7a4f9e', '#2f8f8f', '#b8465f', '#c28a1c'];
const PANTS = '#353b48';

/**
 * A stable pseudo-random pick from a task id, so the same task keeps the same
 * person across reloads - a figure that changes face on every refresh reads as
 * a bug, not as variety.
 */
function pick<T>(tones: readonly T[], seed: string, salt: number): T {
  let hash = salt;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100_003;
  }
  return tones[hash % tones.length];
}

/** Desk, keyboard and monitor: shared by an occupied and an empty desk. */
function DeskArt({ screen, clipId, pose }: { screen: string; clipId: string; pose: Pose | null }) {
  return (
    <>
      {/* Monitor. */}
      <rect x="47" y="38" width="4" height="4.5" fill="rgb(var(--surface-strong))" />
      <rect
        x="38"
        y="22"
        width="22"
        height="16.5"
        rx="2"
        fill="rgb(var(--surface-overlay))"
        stroke="rgb(var(--surface-strong))"
        strokeWidth="1.4"
      />
      <rect x="40.5" y="24.5" width="17" height="11.5" rx="1" fill={screen} />
      <clipPath id={clipId}>
        <rect x="40.5" y="24.5" width="17" height="11.5" rx="1" />
      </clipPath>
      {pose === 'working' ? (
        <g clipPath={`url(#${clipId})`}>
          {/* Lines of code scrolling past: the screen of a task that is running. */}
          <g className="agent-code">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((row) => (
              <rect
                key={row}
                x={42 + (row % 3) * 1.5}
                y={26 + row * 2.4}
                width={[9, 6, 11, 5, 8, 10, 4, 7, 9, 6][row]}
                height="1"
                rx="0.5"
                fill="rgb(var(--state-running))"
                opacity={0.55 + (row % 2) * 0.35}
              />
            ))}
          </g>
        </g>
      ) : pose === 'waiting' ? (
        <g fill="rgb(var(--state-waiting))">
          <rect x="46" y="27" width="2" height="6.5" rx="0.6" />
          <rect x="50" y="27" width="2" height="6.5" rx="0.6" />
        </g>
      ) : pose === 'done' ? (
        <path
          d="M45 30.5 L48 33.5 L53.5 27.5"
          stroke="rgb(var(--state-success))"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ) : pose === 'failed' ? (
        <path
          d="M46 27.5 L52 33.5 M52 27.5 L46 33.5"
          stroke="rgb(var(--state-failure))"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      ) : null}

      {/* Desk top and leg, in front of the person's legs. */}
      <rect x="33.5" y="40.5" width="11" height="1.6" rx="0.6" fill="rgb(var(--surface-strong))" />
      <rect x="29" y="42" width="34" height="3" rx="1" fill="#b98b5e" />
      <rect x="29" y="44.5" width="34" height="1" fill="#9a7148" />
      <rect x="58.5" y="45" width="3" height="14" rx="0.8" fill="#9a7148" />
    </>
  );
}

function ChairArt() {
  return (
    <g fill="rgb(var(--surface-strong))">
      <rect x="7" y="29" width="8" height="21" rx="3" opacity="0.85" />
      <rect x="7" y="46" width="21" height="3.2" rx="1.4" />
      <rect x="16" y="49" width="3" height="8" />
      <rect x="10" y="57" width="15" height="2" rx="1" />
    </g>
  );
}

/**
 * A person at a desk, as a `<g>` in a 64x64 space. The caller positions it
 * with a transform on a wrapping group; the animated parts are nested inside
 * so a CSS transform never replaces the placement transform.
 */
export function FigureArt({
  taskId,
  status,
  variant = 0,
}: {
  taskId: string;
  status: AgentTaskStatus;
  variant?: number;
}) {
  const clipId = `screen-${useId().replace(/:/g, '')}`;
  const pose = poseFor(status);
  const skin = pick(SKIN_TONES, taskId, 3 + variant);
  const hair = pick(HAIR_TONES, taskId, 7 + variant);
  const shirt = pick(SHIRT_TONES, taskId, 13 + variant);
  const longHair = pick([false, true, false], taskId, 19 + variant);

  const screen =
    pose === 'failed'
      ? 'rgb(var(--state-failure) / 0.18)'
      : pose === 'done'
        ? 'rgb(var(--state-success) / 0.18)'
        : pose === 'waiting'
          ? 'rgb(var(--state-waiting) / 0.2)'
          : pose === 'working'
            ? 'rgb(var(--state-running) / 0.14)'
            : 'rgb(var(--surface-strong) / 0.35)';

  const headY = pose === 'failed' ? 22.5 : 20;

  return (
    <g className={`agent-figure agent-pose-${pose}`}>
      {/* Floor shadow. */}
      <ellipse cx="33" cy="59.5" rx="28" ry="2.2" fill="rgb(0 0 0 / 0.08)" />

      <ChairArt />

      {/* Legs, seated: thigh forward under the desk, shin down. */}
      <rect x="14" y="43.5" width="20" height="5" rx="2.2" fill={PANTS} />
      <rect x="29.5" y="46" width="4.6" height="11.5" rx="1.8" fill={PANTS} />
      <rect x="29.5" y="56.8" width="7.5" height="2.6" rx="1.2" fill="#22252c" />

      <g className="agent-body">
        {/* Back arm, darker, behind the torso. */}
        {pose === 'working' ? (
          <g className="agent-arm-back">
            <path
              d="M22.5 31 Q25.5 38.5 33 40.8"
              stroke={shirt}
              strokeWidth="3.4"
              strokeLinecap="round"
              fill="none"
              opacity="0.7"
            />
            <circle cx="33.6" cy="40.8" r="1.5" fill={skin} opacity="0.85" />
          </g>
        ) : null}

        {/* Torso. */}
        <path d="M13 46 L14 34 Q15 27 22 27 Q29 27 30 34 L31 46 Z" fill={shirt} />
        <path d="M19.5 27.4 L22 31 L24.5 27.4 Z" fill="rgb(255 255 255 / 0.55)" />

        {/* Head. */}
        <g className="agent-head">
          {longHair ? (
            <path
              d={`M15.5 ${headY - 1} Q14.5 ${headY + 8} 18 ${headY + 9} L20 ${headY} Z`}
              fill={hair}
            />
          ) : null}
          <rect x="20" y={headY + 4.5} width="4" height="3.5" fill={skin} />
          <circle cx="22" cy={headY} r="6.4" fill={skin} />
          <path
            d={`M15.4 ${headY - 0.5} Q15.4 ${headY - 7.6} 22 ${headY - 7.6} Q28.6 ${headY - 7.6} 28.6 ${headY - 2} Q25 ${headY - 4.6} 15.4 ${headY - 0.5} Z`}
            fill={hair}
          />
          <circle cx="16.5" cy={headY + 0.5} r="1.3" fill={skin} />
          {pose === 'failed' ? (
            <path
              d={`M24.8 ${headY + 1} L27 ${headY + 1}`}
              stroke="#2b2b2b"
              strokeWidth="0.8"
              strokeLinecap="round"
            />
          ) : (
            <circle cx="26" cy={headY - 0.3} r="0.8" fill="#2b2b2b" className="agent-eye" />
          )}
          {pose === 'done' ? (
            <path
              d={`M24.6 ${headY + 2.6} Q26.2 ${headY + 3.8} 27.6 ${headY + 2.4}`}
              stroke="#2b2b2b"
              strokeWidth="0.7"
              fill="none"
              strokeLinecap="round"
            />
          ) : null}
        </g>

        {/* Front arm: the pose itself. */}
        {pose === 'working' ? (
          <g className="agent-arm-front">
            <path
              d="M25 31 Q28 38.5 35.5 40.6"
              stroke={shirt}
              strokeWidth="3.6"
              strokeLinecap="round"
              fill="none"
            />
            <circle cx="36.2" cy="40.6" r="1.6" fill={skin} />
          </g>
        ) : pose === 'waiting' ? (
          <g className="agent-wave">
            <path
              d="M25.5 31 Q31 23 30 13.5"
              stroke={shirt}
              strokeWidth="3.6"
              strokeLinecap="round"
              fill="none"
            />
            <circle cx="30" cy="12.3" r="1.9" fill={skin} />
          </g>
        ) : pose === 'thinking' ? (
          <g>
            <path
              d="M25 31 Q31 31 28 25.2"
              stroke={shirt}
              strokeWidth="3.6"
              strokeLinecap="round"
              fill="none"
            />
            <circle cx="27.6" cy="24.6" r="1.6" fill={skin} />
          </g>
        ) : pose === 'done' ? (
          <g className="agent-cheer">
            <path
              d="M17 30.5 Q13 22 14 14.5"
              stroke={shirt}
              strokeWidth="3.4"
              strokeLinecap="round"
              fill="none"
            />
            <circle cx="14" cy="13.3" r="1.8" fill={skin} />
            <path
              d="M26.5 30.5 Q31 22 30 14.5"
              stroke={shirt}
              strokeWidth="3.4"
              strokeLinecap="round"
              fill="none"
            />
            <circle cx="30" cy="13.3" r="1.8" fill={skin} />
          </g>
        ) : (
          <g>
            <path
              d="M25 31 Q31 27 25.5 18.5"
              stroke={shirt}
              strokeWidth="3.6"
              strokeLinecap="round"
              fill="none"
            />
            <circle cx="25" cy="18" r="1.7" fill={skin} />
          </g>
        )}
      </g>

      <DeskArt screen={screen} clipId={clipId} pose={pose} />

      {/* A bubble for the states a human should notice at a glance. */}
      {pose === 'waiting' ? (
        <g className="agent-bubble">
          <rect x="34" y="0" width="11" height="11" rx="3" fill="rgb(var(--state-waiting))" />
          <path d="M37 10.5 L36 13.5 L39.5 10.5 Z" fill="rgb(var(--state-waiting))" />
          <rect x="38.7" y="2.2" width="1.6" height="4.6" rx="0.8" fill="#fff" />
          <circle cx="39.5" cy="8.6" r="0.95" fill="#fff" />
        </g>
      ) : pose === 'thinking' ? (
        <g fill="rgb(var(--surface-strong))">
          <circle className="agent-think agent-think-1" cx="31" cy="15" r="1.2" />
          <circle className="agent-think agent-think-2" cx="34.5" cy="10.5" r="1.7" />
          <circle className="agent-think agent-think-3" cx="39" cy="5.5" r="2.4" />
        </g>
      ) : pose === 'done' ? (
        <g className="agent-bubble">
          <circle cx="40" cy="7" r="5.5" fill="rgb(var(--state-success))" />
          <path
            d="M37.4 7 L39.3 8.9 L42.7 5.3"
            stroke="#fff"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </g>
      ) : pose === 'failed' ? (
        <g className="agent-bubble">
          <circle cx="40" cy="7" r="5.5" fill="rgb(var(--state-failure))" />
          <path
            d="M37.8 4.8 L42.2 9.2 M42.2 4.8 L37.8 9.2"
            stroke="#fff"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </g>
      ) : null}
    </g>
  );
}

/** A desk nobody is at: chair pushed in, monitor off. */
export function EmptyDeskArt() {
  const clipId = `screen-${useId().replace(/:/g, '')}`;
  return (
    <g opacity="0.75">
      <ellipse cx="33" cy="59.5" rx="27" ry="2" fill="rgb(0 0 0 / 0.05)" />
      <g transform="translate(-4 0)">
        <ChairArt />
      </g>
      <DeskArt screen="rgb(var(--surface-strong) / 0.3)" clipId={clipId} pose={null} />
    </g>
  );
}

/** A standalone figure, for places outside the office scene (the task drawer). */
export function AgentFigure({
  taskId,
  status,
  variant = 0,
  size = 64,
}: {
  taskId: string;
  status: AgentTaskStatus;
  /** Distinguishes figures when two tasks share an id prefix. */
  variant?: number;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 -2 64 64"
      fill="none"
      role="presentation"
      aria-hidden="true"
      className="overflow-visible"
    >
      <FigureArt taskId={taskId} status={status} variant={variant} />
    </svg>
  );
}

/** The pose, for a caller that wants to describe the figure in words. */
export function poseLabel(status: AgentTaskStatus): string {
  switch (poseFor(status)) {
    case 'waiting':
      return 'waiting for your approval';
    case 'done':
      return 'finished';
    case 'failed':
      return 'stopped after a failure';
    case 'thinking':
      return 'queued, not started';
    default:
      return 'working';
  }
}
