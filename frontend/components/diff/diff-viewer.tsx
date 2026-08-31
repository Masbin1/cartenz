'use client';

import { useMemo, useState } from 'react';
import { parseUnifiedDiff, type DiffFile, type DiffLine } from './parse-diff';

/**
 * The diff review surface.
 *
 * "Review Diff" is a step in the documented product workflow, and Phase 2 is what
 * makes it real: the patch shown here is git's own output against the commit the
 * AI branch was created from.
 *
 * Rendered file by file with each file collapsible, because a reviewer works one
 * file at a time and a single scrolling wall of text is how review gets skipped.
 * Line numbers come from the hunk headers, so a reviewer can find the line in
 * their own editor.
 */
export function DiffViewer({
  patch,
  truncated = false,
}: {
  patch: string;
  truncated?: boolean;
}) {
  const files = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (files.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-xs text-content-subtle">
        The diff could not be parsed for display. The patch is available through the API.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {files.map((file) => (
        <FilePanel
          key={file.path}
          file={file}
          collapsed={collapsed.has(file.path)}
          onToggle={() => toggle(file.path)}
        />
      ))}

      {truncated ? (
        <p className="rounded-md border border-state-waiting/30 bg-state-waiting/10 px-3 py-2 text-2xs text-state-waiting">
          The diff was truncated at the size limit. The remainder is not shown; review the branch
          directly for the full change.
        </p>
      ) : null}
    </div>
  );
}

function FilePanel({
  file,
  collapsed,
  onToggle,
}: {
  file: DiffFile;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const tone =
    file.change === 'added'
      ? 'text-state-success'
      : file.change === 'deleted'
        ? 'text-state-failure'
        : 'text-state-running';

  return (
    <div className="overflow-hidden rounded-md border border-surface-border bg-surface">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-overlay"
        aria-expanded={!collapsed}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={`shrink-0 font-mono text-2xs ${tone}`}>
            {file.change === 'added' ? '+' : file.change === 'deleted' ? '-' : '~'}
          </span>
          <span className="truncate font-mono text-2xs text-content">{file.path}</span>
          {file.oldPath ? (
            <span className="shrink-0 font-mono text-2xs text-content-subtle">
              (was {file.oldPath})
            </span>
          ) : null}
        </span>

        <span className="flex shrink-0 items-center gap-2 font-mono text-2xs">
          <span className="text-state-success">+{file.linesAdded}</span>
          <span className="text-state-failure">-{file.linesRemoved}</span>
          <span className="text-content-subtle">{collapsed ? 'show' : 'hide'}</span>
        </span>
      </button>

      {collapsed ? null : file.binary ? (
        <p className="border-t border-surface-border px-3 py-3 text-2xs text-content-subtle">
          Binary file. No textual diff is available.
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-surface-border">
          <table className="w-full border-collapse font-mono text-2xs">
            <tbody>
              {file.hunks.map((hunk) => (
                <HunkRows key={hunk.header} header={hunk.header} lines={hunk.lines} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HunkRows({ header, lines }: { header: string; lines: readonly DiffLine[] }) {
  return (
    <>
      <tr>
        <td colSpan={3} className="bg-surface-overlay px-3 py-1 text-content-subtle">
          {header}
        </td>
      </tr>
      {lines.map((line, index) => (
        <LineRow key={`${header}-${index}`} line={line} />
      ))}
    </>
  );
}

function LineRow({ line }: { line: DiffLine }) {
  /**
   * Colour carries the meaning, but not alone: the leading +/- is kept in a
   * dedicated column so the diff is still readable without colour perception, and
   * so a copied line looks like a diff line.
   */
  const rowClass =
    line.kind === 'added'
      ? 'bg-state-success/10'
      : line.kind === 'removed'
        ? 'bg-state-failure/10'
        : line.kind === 'meta'
          ? 'bg-surface-overlay text-content-subtle'
          : '';

  const marker = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';

  const markerClass =
    line.kind === 'added'
      ? 'text-state-success'
      : line.kind === 'removed'
        ? 'text-state-failure'
        : 'text-content-subtle';

  return (
    <tr className={rowClass}>
      <td className="w-10 select-none px-2 text-right align-top text-content-subtle">
        {line.oldLine ?? ''}
      </td>
      <td className="w-10 select-none px-2 text-right align-top text-content-subtle">
        {line.newLine ?? ''}
      </td>
      <td className="whitespace-pre px-2 align-top">
        <span className={`select-none ${markerClass}`}>{marker}</span>
        <span className={line.kind === 'meta' ? 'italic' : ''}>{line.text}</span>
      </td>
    </tr>
  );
}
