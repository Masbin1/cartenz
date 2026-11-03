import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ModelProviderResolver } from '../model/model-provider-resolver';

/**
 * Chooses `chat` or `change` for a prompt the person did not label, on Odoo
 * Online only (ADR-088).
 *
 * The two task kinds differ in one safety-relevant way on Odoo Online: `chat`
 * runs immediately and asks for approval only when it actually reaches a
 * write tool, mid-run; `change` plans first, puts the whole plan to a person
 * once, and only then runs. Neither skips validation there - Odoo Online has
 * none to skip, unlike a repository-backed project, which is why this
 * classifier is odoo_online-only (`tasks.service.ts` keeps the manual toggle
 * everywhere else: on odoo.sh and on-premise, `chat` skips the test run that
 * `change` does not, and a misclassification there would be a silently
 * unvalidated change rather than one more inline approval).
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
      '"change" if the request asks to create, add, modify, remove or configure anything ' +
        'in the Odoo instance. "chat" only if it asks a question, requests an explanation, ' +
        'or asks to look something up with no change intended. When genuinely unsure, answer "change".',
    ),
});

const CLASSIFIER_SYSTEM =
  'Classify one request against a live Odoo Online instance as "chat" or "change". ' +
  '"change": creates, adds, modifies, removes or configures a field, model, view, record or ' +
  'setting. "chat": asks a question, asks for an explanation, or asks to look something up, ' +
  'with no change intended. Answer "change" whenever the request is ambiguous or you are not sure.';
