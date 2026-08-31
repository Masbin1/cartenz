import { StatusBadge } from '@/components/ui/status-badge';
import { ModelProvenance } from './model-provenance';
import { relativeTime } from '@/lib/format';
import type { TaskDetail } from '@/lib/types';

/**
 * The right pane: task status, modified files, test results and approval state.
 *
 * Everything here is the outcome of the run rather than its narration, which is
 * what the middle pane carries. Keeping them apart means a user can check what
 * changed without re-reading the log.
 */
export function TaskInspector({ task }: { task: TaskDetail | null }) {
  if (!task) {
    return (
      <div className="px-4 py-8 text-center text-xs text-content-subtle">
        Select or submit a task to see its status, file changes and test results.
      </div>
    );
  }

  return (
    <div className="divide-y divide-surface-border">
      <section className="px-4 py-4">
        <p className="panel-title mb-2">Status</p>
        <StatusBadge status={task.status} />

        <dl className="mt-3 space-y-1.5 text-2xs">
          <Row label="Reference" value={task.reference} mono />
          {task.environment ? (
            <Row
              label="Target"
              value={`${task.environment.name} (${task.environment.branch})`}
            />
          ) : null}
          {task.branch ? <Row label="Branch" value={task.branch} mono /> : null}
          {task.baseCommit ? (
            <Row label="Base" value={task.baseCommit.slice(0, 12)} mono />
          ) : null}
          {task.commitHash ? (
            <Row label="Commit" value={task.commitHash.slice(0, 12)} mono />
          ) : null}
          <Row label="Created" value={relativeTime(task.createdAt)} />
          {task.completedAt ? <Row label="Settled" value={relativeTime(task.completedAt)} /> : null}
        </dl>

        <SimulationNotice task={task} />

        {task.failureReason ? (
          <p className="mt-3 rounded border border-state-failure/30 bg-state-failure/10 px-2.5 py-2 text-2xs text-state-failure">
            {task.failureReason}
          </p>
        ) : null}
      </section>

      <section className="px-4 py-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="panel-title">Modified files</p>
          {task.diffStats ? (
            <span className="font-mono text-2xs">
              <span className="text-state-success">+{task.diffStats.linesAdded}</span>{' '}
              <span className="text-state-failure">-{task.diffStats.linesRemoved}</span>
            </span>
          ) : (
            <span className="text-2xs text-content-subtle">{task.modifiedFiles.length}</span>
          )}
        </div>
        {task.modifiedFiles.length === 0 ? (
          <p className="text-2xs text-content-subtle">No file changes reported yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {task.modifiedFiles.map((file) => (
              <li key={file.path}>
                <p className="font-mono text-2xs">
                  <span className={changeColour(file.change)}>{changeMark(file.change)}</span>{' '}
                  {file.path}
                </p>
                <p className="ml-3 mt-0.5 text-2xs text-content-subtle">
                  {file.summary}
                  {file.linesAdded + file.linesRemoved > 0 ? (
                    <span className="ml-1.5">
                      <span className="text-state-success">+{file.linesAdded}</span>{' '}
                      <span className="text-state-failure">-{file.linesRemoved}</span>
                    </span>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="px-4 py-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="panel-title">Validation</p>
          {task.simulatedCapabilities?.includes('validation') ? (
            <span className="rounded border border-state-waiting/30 bg-state-waiting/10 px-1.5 py-0.5 text-2xs text-state-waiting">
              simulated
            </span>
          ) : null}
        </div>
        {!task.testResults ? (
          <p className="text-2xs text-content-subtle">Validation has not run yet.</p>
        ) : (
          <>
            <p className="mb-2 text-2xs">
              <span className="text-state-success">{task.testResults.passed} passed</span>
              {task.testResults.failed > 0 ? (
                <span className="ml-2 text-state-failure">{task.testResults.failed} failed</span>
              ) : null}
              {task.testResults.skipped > 0 ? (
                <span className="ml-2 text-content-subtle">
                  {task.testResults.skipped} skipped
                </span>
              ) : null}
            </p>
            <ul className="space-y-1">
              {task.testResults.suites.map((suite) => (
                <li key={suite.name} className="flex items-center justify-between text-2xs">
                  <span className="font-mono text-content-muted">{suite.name}</span>
                  <span
                    className={
                      suite.status === 'passed' ? 'text-state-success' : 'text-state-failure'
                    }
                  >
                    {suite.status}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="px-4 py-4">
        <p className="panel-title mb-2">Agent</p>
        <ModelProvenance calls={task.modelCalls ?? []} />
      </section>

      <section className="px-4 py-4">
        <p className="panel-title mb-2">Approvals</p>
        {task.approvals.length === 0 ? (
          <p className="text-2xs text-content-subtle">None requested.</p>
        ) : (
          <ul className="space-y-2">
            {task.approvals.map((approval) => (
              <li key={approval.id} className="text-2xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-content-muted">{approval.action}</span>
                  <span className={approvalColour(approval.status)}>{approval.status}</span>
                </div>
                {approval.decisionNote ? (
                  <p className="mt-0.5 text-content-subtle">{approval.decisionNote}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
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
      <p className="mt-3 rounded border border-surface-border bg-surface px-2.5 py-2 text-2xs leading-relaxed text-content-subtle">
        Nothing in this task had a real effect. No file was written, no command was executed and no
        repository was contacted.
      </p>
    );
  }

  if (simulated.length === 0) return null;

  const described: Record<string, string> = {
    validation: 'the linter and test results are not from a real run',
    push: 'the commit exists on the branch but was not sent to the remote',
  };

  return (
    <div className="mt-3 rounded border border-surface-border bg-surface px-2.5 py-2 text-2xs leading-relaxed text-content-subtle">
      <p className="text-content-muted">
        The repository was cloned, read and modified for real, and the commit is real.
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {simulated.map((capability) => (
          <li key={capability}>
            <span className="text-state-waiting">Simulated:</span>{' '}
            {described[capability] ?? capability}
          </li>
        ))}
      </ul>
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

function approvalColour(status: string): string {
  if (status === 'approved') return 'text-state-success';
  if (status === 'rejected') return 'text-state-failure';
  return 'text-state-waiting';
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <dt className="shrink-0 text-content-subtle">{label}</dt>
      <dd className={`min-w-0 break-all text-right ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
