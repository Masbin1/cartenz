import { humanise } from '@/lib/format';
import { Alert } from '@/components/ui/alert';
import { Disclosure } from '@/components/ui/disclosure';
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
 *
 * The answers to both questions are shown in plain language. The per-call
 * breakdown (steps, tool calls, tokens) and the redaction rules that fired are
 * technical detail, kept behind disclosures. Anything that changes how far the
 * work can be trusted (no model, a halted run, a refused call) stays visible.
 */
export function ModelProvenance({ calls }: { calls: ModelCall[] }) {
  if (calls.length === 0) {
    return <p className="text-callout text-content-subtle">No model call has been made yet.</p>;
  }

  const external = calls.some((call) => call.calledExternalService);
  const totalRedactions = calls.reduce((sum, call) => sum + call.redactionCount, 0);
  const totalTokens = calls.reduce(
    (sum, call) => sum + call.inputTokens + call.outputTokens,
    0,
  );
  const refused = calls.some((call) => call.boundaryRefused);
  const haltReason = calls.find((call) => call.haltReason)?.haltReason;

  const findings = new Map<string, number>();
  for (const call of calls) {
    for (const finding of call.boundaryFindings ?? []) {
      findings.set(finding.rule, (findings.get(finding.rule) ?? 0) + finding.occurrences);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Produced by</p>
        {external ? (
          <p className="mt-1 break-all font-mono text-meta text-content">
            {calls[0].providerId}/{calls[0].model}
          </p>
        ) : (
          <div className="mt-2">
            <Alert tone="warning" title="No model was called">
              This deployment has no AI provider configured, so the plan and the changes were
              produced by the scripted provider, which does not reason about code.
            </Alert>
          </div>
        )}
      </div>

      {haltReason ? (
        <Alert tone="warning" title="The run stopped early">
          {haltReason}
        </Alert>
      ) : null}

      <div>
        <p className="eyebrow">AI data boundary</p>
        <div className="mt-1.5">
          {refused ? (
            <Alert tone="error" title="A call was refused">
              The material contained customer data, which chapter 12 forbids sending to an AI
              provider.
            </Alert>
          ) : totalRedactions === 0 ? (
            <p className="text-callout text-content-muted">
              Nothing was removed. The repository content sent to the model contained no credential
              or personal data.
            </p>
          ) : (
            <>
              <p className="text-callout text-content-muted">
                {totalRedactions} item{totalRedactions === 1 ? '' : 's'} removed before the request
                left the platform. The model reasoned about the file without them.
              </p>
              <Disclosure className="mt-2" summary="What was removed" hint={findings.size}>
                <ul className="space-y-1.5">
                  {[...findings.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([rule, count]) => (
                      <li key={rule} className="flex items-baseline justify-between gap-3">
                        <span className="mono-meta min-w-0 break-all">{rule}</span>
                        <span className="shrink-0 text-meta tabular-nums text-content-muted">
                          {count}
                        </span>
                      </li>
                    ))}
                </ul>
              </Disclosure>
            </>
          )}
        </div>
      </div>

      <Disclosure
        summary="Model calls"
        hint={`${calls.length} call${calls.length === 1 ? '' : 's'}`}
      >
        <dl className="space-y-2.5">
          {calls.map((call) => (
            <div key={`${call.operation}-${call.createdAt}`} className="min-w-0">
              <dt className="text-meta text-content-subtle">{humanise(call.operation)}</dt>
              <dd className="mt-0.5 font-mono text-caption text-content-muted">
                {call.steps} step{call.steps === 1 ? '' : 's'}
                {call.toolCalls > 0 ? `, ${call.toolCalls} tool calls` : ''}
                {call.inputTokens + call.outputTokens > 0
                  ? `, ${call.inputTokens + call.outputTokens} tokens`
                  : ''}
              </dd>
            </div>
          ))}
          {totalTokens > 0 && !external ? (
            <p className="text-meta text-content-subtle">
              Token counts are estimated: no provider reported them.
            </p>
          ) : null}
        </dl>
      </Disclosure>
    </div>
  );
}
