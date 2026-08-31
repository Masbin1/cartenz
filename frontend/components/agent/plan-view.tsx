import type { ImplementationPlan } from '@/lib/types';

/**
 * The implementation plan, as the user sees it before approving.
 *
 * Steps, files and risks are shown together and in full: an approval against a
 * summary is not an informed approval.
 */
export function PlanView({ plan }: { plan: ImplementationPlan }) {
  return (
    <div className="space-y-4 rounded-md border border-surface-border bg-surface px-4 py-4">
      <div>
        <p className="panel-title mb-1.5">Implementation plan</p>
        <p className="text-xs leading-relaxed text-content">{plan.summary}</p>
      </div>

      <div>
        <p className="panel-title mb-2">Steps</p>
        <ol className="space-y-2">
          {plan.steps.map((step) => (
            <li key={step.order} className="flex gap-2.5">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-surface-overlay font-mono text-2xs text-content-muted">
                {step.order}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium">{step.title}</span>
                <span className="mt-0.5 block text-2xs leading-relaxed text-content-muted">
                  {step.detail}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="panel-title mb-2">Files to change</p>
          <ul className="space-y-1">
            {plan.filesToModify.map((file) => (
              <li key={file.path} className="font-mono text-2xs">
                <span
                  className={
                    file.change === 'added'
                      ? 'text-state-success'
                      : file.change === 'deleted'
                        ? 'text-state-failure'
                        : 'text-state-running'
                  }
                >
                  {file.change === 'added' ? '+' : file.change === 'deleted' ? '-' : '~'}
                </span>{' '}
                <span className="text-content">{file.path}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="panel-title mb-2">Validation</p>
          <ul className="space-y-1">
            {plan.validation.map((tool) => (
              <li key={tool} className="font-mono text-2xs text-content-muted">
                {tool}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {plan.risks.length > 0 ? (
        <div>
          <p className="panel-title mb-2">Risks</p>
          <ul className="space-y-1">
            {plan.risks.map((risk) => (
              <li key={risk} className="text-2xs leading-relaxed text-state-waiting">
                {risk}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="border-t border-surface-border pt-3">
        {plan.generatedBy.includes('scripted-provider') ? (
          <p className="text-2xs leading-relaxed text-state-waiting">
            Produced without a model call. This deployment has no AI provider configured, so the
            plan follows a fixed template over the repository analysis rather than reasoning about
            the code. Review it accordingly.
          </p>
        ) : (
          <p className="font-mono text-2xs text-content-subtle">
            Produced by {plan.generatedBy}. Repository content passed through the AI data boundary
            before it reached the provider.
          </p>
        )}
      </div>
    </div>
  );
}
