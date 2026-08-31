import { humanise } from '@/lib/format';
import type { ModelCall } from '@/lib/types';

/**
 * What produced this task's work, and what the AI data boundary removed.
 *
 * Two questions a reviewer needs answered before weighing a plan, and neither is
 * visible anywhere else: whether a model actually reasoned about the code, and
 * whether the material it saw had been stripped of anything.
 *
 * A redaction is not a warning. It means the boundary did its job. But it also
 * means the model reasoned about less than the whole file, which is context a
 * reviewer should have.
 */
export function ModelProvenance({ calls }: { calls: ModelCall[] }) {
  if (calls.length === 0) {
    return <p className="text-2xs text-content-subtle">No model call has been made yet.</p>;
  }

  const external = calls.some((call) => call.calledExternalService);
  const totalRedactions = calls.reduce((sum, call) => sum + call.redactionCount, 0);
  const totalTokens = calls.reduce(
    (sum, call) => sum + call.inputTokens + call.outputTokens,
    0,
  );
  const refused = calls.some((call) => call.boundaryRefused);

  const findings = new Map<string, number>();
  for (const call of calls) {
    for (const finding of call.boundaryFindings ?? []) {
      findings.set(finding.rule, (findings.get(finding.rule) ?? 0) + finding.occurrences);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="panel-title mb-1.5">Produced by</p>
        {external ? (
          <p className="font-mono text-2xs text-content">
            {calls[0].providerId}/{calls[0].model}
          </p>
        ) : (
          <p className="text-2xs leading-relaxed text-state-waiting">
            No model was called. This deployment has no AI provider configured, so the plan and the
            changes were produced by the scripted provider, which does not reason about code.
          </p>
        )}
      </div>

      <dl className="space-y-1 text-2xs">
        {calls.map((call) => (
          <div key={`${call.operation}-${call.createdAt}`} className="flex justify-between gap-2">
            <dt className="text-content-subtle">{humanise(call.operation)}</dt>
            <dd className="text-right font-mono">
              {call.steps} step{call.steps === 1 ? '' : 's'}
              {call.toolCalls > 0 ? `, ${call.toolCalls} tool calls` : ''}
              {call.inputTokens + call.outputTokens > 0
                ? `, ${call.inputTokens + call.outputTokens} tokens`
                : ''}
            </dd>
          </div>
        ))}
        {totalTokens > 0 && !external ? (
          <p className="pt-0.5 text-2xs text-content-subtle">
            Token counts are estimated: no provider reported them.
          </p>
        ) : null}
      </dl>

      {calls.some((call) => call.haltReason) ? (
        <div className="rounded border border-state-waiting/30 bg-state-waiting/10 px-2.5 py-2">
          <p className="text-2xs text-state-waiting">
            {calls.find((call) => call.haltReason)?.haltReason}
          </p>
        </div>
      ) : null}

      <div>
        <p className="panel-title mb-1.5">AI data boundary</p>

        {refused ? (
          <p className="rounded border border-state-failure/30 bg-state-failure/10 px-2.5 py-2 text-2xs leading-relaxed text-state-failure">
            A call was refused: the material contained customer data, which chapter 12 forbids
            sending to an AI provider.
          </p>
        ) : totalRedactions === 0 ? (
          <p className="text-2xs text-content-subtle">
            Nothing was removed. The repository content sent to the model contained no credential
            or personal data.
          </p>
        ) : (
          <>
            <p className="text-2xs leading-relaxed text-content-muted">
              {totalRedactions} item{totalRedactions === 1 ? '' : 's'} removed before the request
              left the platform. The model reasoned about the file without them.
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {[...findings.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([rule, count]) => (
                  <li key={rule} className="flex justify-between gap-2 text-2xs">
                    <span className="font-mono text-content-subtle">{rule}</span>
                    <span className="text-content-muted">{count}</span>
                  </li>
                ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
