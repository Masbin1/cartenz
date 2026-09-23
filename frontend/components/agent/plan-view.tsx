import { Alert } from '@/components/ui/alert';
import type { ImplementationPlan } from '@/lib/types';

/**
 * The implementation plan, as the user sees it before approving.
 *
 * Steps, files and risks are shown together and in full: an approval against a
 * summary is not an informed approval.
 *
 * Laid out openly rather than boxed: the summary first as body text, then the
 * numbered steps, then the files and validation side by side, then any risks
 * as a warning. Which model produced the plan closes it, quietly, unless no
 * model did, in which case that is stated as a warning.
 */
export function PlanView({ plan }: { plan: ImplementationPlan }) {
  return (
    <section aria-labelledby="plan-title" className="animate-fade-in">
      <h2 id="plan-title" className="text-headline text-content">
        Implementation plan
      </h2>
      <p className="mt-1.5 max-w-3xl text-body text-content-muted">{plan.summary}</p>

      <ol className="mt-6 space-y-4">
        {plan.steps.map((step) => (
          <li key={step.order} className="flex gap-3.5">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-meta font-medium tabular-nums text-content-muted"
              aria-hidden="true"
            >
              {step.order}
            </span>
            <span className="min-w-0 pt-0.5">
              <span className="block text-callout font-medium text-content">{step.title}</span>
              <span className="mt-0.5 block text-callout text-content-muted">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-8 grid gap-8 sm:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-callout font-semibold text-content">Files to change</h3>
          <ul className="mt-2.5 space-y-1.5">
            {plan.filesToModify.map((file) => (
              <li key={file.path} className="flex min-w-0 gap-2 font-mono text-caption">
                <span
                  className={`shrink-0 ${
                    file.change === 'added'
                      ? 'text-state-success'
                      : file.change === 'deleted'
                        ? 'text-state-failure'
                        : 'text-state-running'
                  }`}
                >
                  {file.change === 'added' ? '+' : file.change === 'deleted' ? '-' : '~'}
                </span>
                <span className="min-w-0 break-all text-content">{file.path}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="min-w-0">
          <h3 className="text-callout font-semibold text-content">Validation</h3>
          <ul className="mt-2.5 space-y-1.5">
            {plan.validation.map((tool) => (
              <li key={tool} className="break-all font-mono text-caption text-content-muted">
                {tool}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {plan.risks.length > 0 ? (
        <div className="mt-8">
          <Alert tone="warning" title="Risks">
            <ul className="list-disc space-y-1 pl-4">
              {plan.risks.map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      <div className="mt-6">
        {plan.generatedBy.includes('scripted-provider') ? (
          <Alert tone="warning" title="Produced without a model call">
            This deployment has no AI provider configured, so the plan follows a fixed template
            over the repository analysis rather than reasoning about the code. Review it
            accordingly.
          </Alert>
        ) : (
          <p className="text-meta text-content-subtle">
            Produced by <span className="font-mono text-caption">{plan.generatedBy}</span>.
            Repository content passed through the AI data boundary before it reached the provider.
          </p>
        )}
      </div>
    </section>
  );
}
