'use client';

import { memo } from 'react';
import { AgentFigure } from './agent-figure';
import { STATUS_GLYPHS, STATUS_LABELS } from '@/lib/office/status';
import type { OfficeStatus } from '@/lib/office/status';

/**
 * The status legend (section 22).
 *
 * Status is never colour-only anywhere in the office, and this is the key that
 * makes the glyphs readable: each row carries the glyph, the word and the
 * colour, so a viewer who cannot distinguish the hues still gets the state from
 * the glyph and the text.
 */

const ORDER: OfficeStatus[] = ['running', 'waiting', 'approval', 'queued', 'completed', 'failed'];

export const OfficeLegend = memo(function OfficeLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-label="Status legend">
      {ORDER.map((status) => (
        <li key={status} className="flex items-center gap-1.5 text-caption text-content-muted">
          <span aria-hidden="true" className={`office-legend-dot office-tone-${tone(status)}`}>
            {STATUS_GLYPHS[status]}
          </span>
          {STATUS_LABELS[status]}
          <span className="sr-only"> status</span>
        </li>
      ))}
    </ul>
  );
});

function tone(status: OfficeStatus): string {
  if (status === 'running') return 'running';
  if (status === 'waiting' || status === 'approval') return 'waiting';
  if (status === 'completed') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'failure';
  return 'idle';
}

/**
 * The office's empty state: the floor is still there, it just has nobody on it.
 * The room drawing stays visible behind this line, because an office with no one
 * in it is a fact about the office, not an error.
 */
export const OfficeEmptyNote = memo(function OfficeEmptyNote({
  onGoToProjects,
}: {
  onGoToProjects: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <AgentFigure taskId="empty-office" status="queued" size={72} />
      <p className="text-headline text-content">The office is quiet</p>
      <p className="max-w-md text-callout text-content-subtle">
        No task is running right now, so every desk is empty. Start one from a project and a person
        sits down at a desk in the room for its phase.
      </p>
      <button type="button" className="btn-primary btn-sm mt-1" onClick={onGoToProjects}>
        Go to projects
      </button>
    </div>
  );
});
