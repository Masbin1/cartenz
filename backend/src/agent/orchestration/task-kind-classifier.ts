import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ModelProviderResolver } from '../model/model-provider-resolver';

/**
 * Chooses `chat` or `change` for a prompt the person did not label (ADR-088,
 * extended to every project type by ADR-095).
 *
 * The two task kinds differ in one safety-relevant way: `chat` runs
 * immediately and asks for approval only when it actually reaches a write
 * tool, mid-run; `change` plans first, puts the whole plan to a person once,
 * and only then runs. This classifier used to be restricted to Odoo Online
 * because that was the only mode where neither kind skipped validation - on
 * a repository-backed project, `chat` used to also skip the test run
 * `change` ran, so a misclassification there would have silently landed an
 * untested change. ADR-095 closed that gap directly (`implementChat` and
 * `completeChat` in `agent-workflow.ts` now run the same `validate()` a
 * change task does, on any chat that wrote files), which is what makes this
 * classifier safe to use everywhere: a wrong guess now costs at most one
 * extra approval moment, never a skipped test, in any mode.
 *
 * A wrong call here still costs nothing but a less convenient approval
 * moment, so this fails toward `change` on any doubt: a parse failure, a
 * timeout, or a model that cannot produce structured output all come back as
 * `change` rather than throw, because the alternative - guessing `chat` - is
 * the only one of the two guesses that can surprise someone (a change they
 * expected to see planned hits a write tool mid-run instead).
 */
@Injectable()
export class TaskKindClassifier {
  private readonly logger = new Logger(TaskKindClassifier.name);

  constructor(private readonly providers: ModelProviderResolver) {}

  async classify(prompt: string, projectId: string): Promise<'chat' | 'change'> {
    try {
      // `fast: true` - this is one word of output standing in for a toggle the
      // person didn't click, not a step worth the main chain's slowest, most
      // capable member.
      const provider = await this.providers.forProject(projectId, { fast: true });

      const result = await provider.generateStructured({
        system: CLASSIFIER_SYSTEM,
        parts: [{ label: 'Request', content: prompt }],
        schema: CLASSIFIER_SCHEMA,
        schemaName: 'TaskKindClassification',
        maxTokens: 20,
      });

      return result.value.kind;
    } catch (error) {
      this.logger.warn(
        `Task kind classification failed, defaulting to change: ${(error as Error).message}`,
      );
      return 'change';
    }
  }
}

const CLASSIFIER_SCHEMA = z.object({
  kind: z
    .enum(['chat', 'change'])
    .describe(
      '"change" if the request asks to create, add, modify, remove or configure anything - ' +
        'a field, a model, a view, a record, a setting, a file, a module, an automation. ' +
        '"chat" only if it asks a question, requests an explanation, or asks to look something ' +
        'up with no change intended. When genuinely unsure, answer "change".',
    ),
});

const CLASSIFIER_SYSTEM =
  'Classify one request against an Odoo project as "chat" or "change". The project may be a ' +
  'live Odoo Online instance (field, model, record, setting) or a codebase (module, file, ' +
  'function, automation rule, test). "change": creates, adds, modifies, removes or configures ' +
  'anything, in either kind of project. "chat": asks a question, asks for an explanation, or ' +
  'asks to look something up, with no change intended. Answer "change" whenever the request is ' +
  'ambiguous or you are not sure.';
