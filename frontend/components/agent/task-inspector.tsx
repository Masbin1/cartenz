import type { ReactNode } from 'react';
import { ListChecks } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { Alert } from '@/components/ui/alert';
import { Disclosure } from '@/components/ui/disclosure';
import { DetailItem, DetailList } from '@/components/ui/detail-list';
import { EmptyState } from '@/components/ui/empty-state';
import { ModelProvenance } from './model-provenance';
import { humanise, relativeTime } from '@/lib/format';
import type { TaskDetail } from '@/lib/types';

/** How many changed files are listed before the rest move behind a disclosure. */
const VISIBLE_FILES = 6;

/**
 * The task details column: task status, modified files, test results and
 * approval state.
 *
 * Everything here is the outcome of the run rather than its narration, which is
 * what the conversation column carries. Keeping them apart means a user can
 * check what changed without re-reading the log.
 *
 * Summary first: the status and anything that limits how far the result can be
 * trusted (a failure, simulated capabilities). Identifiers (reference, branch,
 * commits), long file lists, per-suite results and model details follow behind
 * disclosures.
 */
export function TaskInspector({ task }: { task: TaskDetail | null }) {
  if (!task) {
    return (
      <EmptyState
        compact
        icon={ListChecks}
        title="No request selected"
        description="Select a request, or send one, to see its status, changes and checks."
      />
    );
  }

  const visibleFiles = task.modifiedFiles.slice(0, VISIBLE_FILES);
  const hiddenFiles = task.modifiedFiles.slice(VISIBLE_FILES);

  return (
    <div className="space-y-8">
      <div>
        <StatusBadge status={task.status} size="default" />
        <p className="mt-1.5 text-meta text-content-subtle">
          Created {relativeTime(task.createdAt)}
          {task.completedAt ? ` · settled ${relativeTime(task.completedAt)}` : ''}
        </p>

        {task.environment ? (
          <DetailList className="mt-4">
            <DetailItem label="Target">
              {task.environment.name}{' '}
              <span className="font-mono text-meta text-content-muted">({task.environment.branch})</span>
            </DetailItem>
          </DetailList>
        ) : null}

        {task.failureReason ? (
          <div className="mt-4">
            <Alert tone="error">{task.failureReason}</Alert>
          </div>
        ) : null}

        <SimulationNotice task={task} />

        <Disclosure className="mt-4" summary="Technical details">
          <DetailList>
            <DetailItem label="Reference" mono>
              {task.reference}
            </DetailItem>
            {task.branch ? (
              <DetailItem label="Branch" mono>
                {task.branch}
              </DetailItem>
            ) : null}
            {task.baseCommit ? (
              <DetailItem label="Base" mono>
                {task.baseCommit.slice(0, 12)}
              </DetailItem>
            ) : null}
            {task.commitHash ? (
              <DetailItem label="Commit" mono>
                {task.commitHash.slice(0, 12)}
              </DetailItem>
            ) : null}
          </DetailList>
        </Disclosure>
      </div>

      <InspectorSection
        title="Changed files"
        aside={
          task.diffStats ? (
            <DiffCount added={task.diffStats.linesAdded} removed={task.diffStats.linesRemoved} />
          ) : (
            <span className="text-meta tabular-nums text-content-subtle">
              {task.modifiedFiles.length}
            </span>
          )
        }
      >
        {task.modifiedFiles.length === 0 ? (
          <p className="text-callout text-content-subtle">No file changes reported yet.</p>
        ) : (
          <>
            <FileList files={visibleFiles} />
            {hiddenFiles.length > 0 ? (
              <Disclosure
                className="mt-3"
                summary={`Show ${hiddenFiles.length} more file${hiddenFiles.length === 1 ? '' : 's'}`}
              >
                <FileList files={hiddenFiles} />
              </Disclosure>
            ) : null}
          </>
        )}
      </InspectorSection>

      <InspectorSection
        title="Validation"
        aside={
          task.simulatedCapabilities?.includes('validation') ? (
            <StatusDot tone="waiting" size="small">
              Simulated
            </StatusDot>
          ) : null
        }
      >
        {!task.testResults ? (
          <p className="text-callout text-content-subtle">Validation has not run yet.</p>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <StatusDot tone="success" size="small">
                {task.testResults.passed} passed
              </StatusDot>
              {task.testResults.failed > 0 ? (
                <StatusDot tone="failure" size="small">
                  {task.testResults.failed} failed
                </StatusDot>
              ) : null}
              {task.testResults.skipped > 0 ? (
                <StatusDot tone="idle" size="small">
                  {task.testResults.skipped} skipped
                </StatusDot>
              ) : null}
            </p>
            {task.testResults.suites.length > 0 ? (
              <Disclosure
                className="mt-3"
                summary="Suites"
                hint={task.testResults.suites.length}
                // A failing suite is what the reader is looking for, so it is
                // shown without an extra click.
                defaultOpen={task.testResults.failed > 0}
              >
                <ul className="space-y-2">
                  {task.testResults.suites.map((suite) => (
                    <li key={suite.name} className="flex items-center justify-between gap-3">
                      <span className="mono-meta min-w-0 break-all">{suite.name}</span>
                      <StatusDot
                        tone={suite.status === 'passed' ? 'success' : 'failure'}
                        size="small"
                        className="shrink-0"
                      >
                        {humanise(suite.status)}
                      </StatusDot>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
          </>
        )}
      </InspectorSection>

      <InspectorSection title="Agent">
        <ModelProvenance calls={task.modelCalls ?? []} />
      </InspectorSection>

      <InspectorSection title="Approvals">
        {task.approvals.length === 0 ? (
          <p className="text-callout text-content-subtle">None requested.</p>
        ) : (
          <ul className="space-y-3">
            {task.approvals.map((approval) => (
              <li key={approval.id}>
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 break-all font-mono text-meta text-content-muted">
                    {approval.action}
                  </span>
                  <StatusDot tone={approvalTone(approval.status)} size="small" className="shrink-0">
                    {humanise(approval.status)}
                  </StatusDot>
                </div>
                {approval.decisionNote ? (
                  <p className="mt-1 text-meta text-content-subtle">{approval.decisionNote}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
    </div>
  );
}

/**
 * A titled group inside the column. Smaller than a page section (callout, not
 * headline) so the column keeps one clear level below the column's own title.
 */
function InspectorSection({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-surface-border pt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-callout font-semibold text-content">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function FileList({ files }: { files: TaskDetail['modifiedFiles'] }) {
  return (
    <ul className="space-y-3">
      {files.map((file) => (
        <li key={file.path} className="min-w-0">
          <p className="flex min-w-0 gap-2 font-mono text-caption">
            <span className={`shrink-0 ${changeColour(file.change)}`}>
              {changeMark(file.change)}
            </span>
            <span className="min-w-0 break-all text-content">{file.path}</span>
          </p>
          <p className="ml-4 mt-0.5 text-meta text-content-subtle">
            {file.summary}
            {file.linesAdded + file.linesRemoved > 0 ? (
              <span className="ml-2">
                <DiffCount added={file.linesAdded} removed={file.linesRemoved} />
              </span>
            ) : null}
          </p>
        </li>
      ))}
    </ul>
  );
}

function DiffCount({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-caption tabular-nums">
      <span className="text-state-success">+{added}</span>{' '}
      <span className="text-state-failure">-{removed}</span>
    </span>
  );
}

/**
 * States precisely which results were fabricated.
 *
 * A single "simulated" flag could not answer the two different questions a reader
 * has - did anything real happen, and which of these numbers can I trust - so the
 * capability categories are named (ADR-019).
 */
function SimulationNotice({ task }: { task: TaskDetail }) {
  const simulated = task.simulatedCapabilities ?? [];

  if (task.simulated) {
    return (
      <div className="mt-4">
        <Alert tone="info" title="Simulated run">
          Nothing in this task had a real effect. No file was written, no command was executed and
          no repository was contacted.
        </Alert>
      </div>
    );
  }

  if (simulated.length === 0) return null;

  const described: Record<string, string> = {
    validation: 'the linter and test results are not from a real run',
    push: 'the commit exists on the branch but was not sent to the remote',
  };

  return (
    <div className="mt-4">
      <Alert tone="info" title="Partly simulated">
        <p>The repository was cloned, read and modified for real, and the commit is real.</p>
        <ul className="mt-1.5 space-y-0.5">
          {simulated.map((capability) => (
            <li key={capability}>
              <span className="font-medium text-state-waiting">Simulated:</span>{' '}
              {described[capability] ?? capability}
            </li>
          ))}
        </ul>
      </Alert>
    </div>
  );
}

function changeMark(change: 'added' | 'modified' | 'deleted'): string {
  if (change === 'added') return '+';
  if (change === 'deleted') return '-';
  return '~';
}

function changeColour(change: 'added' | 'modified' | 'deleted'): string {
  if (change === 'added') return 'text-state-success';
  if (change === 'deleted') return 'text-state-failure';
  return 'text-state-running';
}

function approvalTone(status: string): StatusTone {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'failure';
  return 'waiting';
}
