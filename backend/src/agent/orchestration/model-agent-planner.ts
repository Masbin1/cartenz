import { Injectable, Logger } from '@nestjs/common';
import { type PromptPart } from '../model/model-provider.interface';
import { ModelProviderResolver } from '../model/model-provider-resolver';
import { buildSystemPrompt } from '../model/prompt-assembly';
import type { BoundaryFinding } from '../../core/ai-boundary/boundary-types';
import { implementationPlanSchema } from './plan-schema';
import type { ImplementationPlan } from './agent-plan';
import type { ProjectAnalysis } from '../analysis/odoo-project-analyser';
import type { CodeSearchMatch } from '../analysis/code-search';
import { inferOdooTarget } from './odoo-target';
import type { ModelRelevance } from '../analysis/odoo-model-index';

export interface ModelPlanningInput {
  /**
   * Whose model provider to use (ADR-023). The configuration is per
   * organisation, so the caller says which one rather than the planner assuming a
   * single provider bound at boot.
   */
  readonly organizationId: string;
  readonly prompt: string;
  readonly projectName: string;
  readonly taskReference: string;
  readonly branch: string;
  readonly declaredOdooVersion: string | null;
  readonly analysis: ProjectAnalysis | null;
  readonly searchMatches: readonly CodeSearchMatch[];
  /**
   * Candidate files ordered by how they relate to the target model, best first
   * (ADR-025). Separate from `searchMatches`, which is ordered by where the walker
   * happened to look.
   */
  readonly rankedCandidates: readonly { path: string; relevance: ModelRelevance }[];
  /** File contents the model should see, already read by the analysis step. */
  readonly excerpts: readonly { readonly path: string; readonly content: string }[];
  readonly grantedTools: readonly string[];
}

export interface PlanningOutcome {
  readonly plan: ImplementationPlan;
  readonly usage: { inputTokens: number; outputTokens: number; durationMs: number };
  readonly boundaryFindings: readonly BoundaryFinding[];
  readonly redactionCount: number;
  readonly providerId: string;
  readonly model: string;
  readonly calledExternalService: boolean;
}

/**
 * Produces the implementation plan by asking the model (ADR-020).
 *
 * Replaces the heuristic planner of Phase 2. What has not changed is everything
 * around it: the plan is validated against a schema, persisted, and put to a
 * person for approval before a single file is written. The model chooses what to
 * do; it does not decide whether it happens.
 *
 * The prompt is assembled from facts the platform has already established - the
 * detected Odoo version, the modules that exist, the search hits, the contents of
 * the candidate files - rather than from the raw repository. That keeps the prompt
 * bounded, and it means the model reasons about the same facts the portal shows
 * the user.
 */
@Injectable()
export class ModelAgentPlanner {
  private readonly logger = new Logger(ModelAgentPlanner.name);

  constructor(private readonly providers: ModelProviderResolver) {}

  async createPlan(input: ModelPlanningInput): Promise<PlanningOutcome> {
    const provider = await this.providers.forOrganization(input.organizationId);

    const system = buildSystemPrompt({
      projectName: input.projectName,
      odooVersion: input.analysis?.detectedOdooVersion ?? input.declaredOdooVersion,
      branch: input.branch,
      grantedTools: input.grantedTools,
    });

    const result = await provider.generateStructured({
      system: `${system}\n\n${PLANNING_INSTRUCTION}`,
      parts: this.buildParts(input),
      schema: implementationPlanSchema,
      schemaName: 'ImplementationPlan',
    });

    const plan: ImplementationPlan = {
      ...result.value,
      // Recorded by the platform, not by the model: a model asked to attribute
      // itself would sometimes get it wrong, and this is the field a reviewer uses
      // to judge how much weight to give the plan.
      generatedBy: provider.callsExternalService
        ? `${provider.id}/${provider.model}`
        : `scripted-provider (${provider.model}, no model call)`,
    };

    this.logger.log(
      `Planned ${input.taskReference} via ${plan.generatedBy}: ${plan.steps.length} step(s), ` +
        `${plan.filesToModify.length} file(s), ${result.redactionCount} boundary redaction(s)`,
    );

    return {
      plan,
      usage: result.usage,
      boundaryFindings: result.boundaryFindings,
      redactionCount: result.redactionCount,
      providerId: provider.id,
      model: provider.model,
      calledExternalService: provider.callsExternalService,
    };
  }

  /**
   * Builds the prompt parts.
   *
   * Each is labelled, because the AI data boundary names the part it refused and
   * "the prompt was refused" is not an actionable message. Repository excerpts are
   * marked untrusted so they are fenced (ADR-020).
   *
   * The analysis is supplied as JSON rather than prose. A model reads structured
   * facts more reliably than a paragraph describing them, and it keeps the
   * scripted provider able to read the same part.
   */
  private buildParts(input: ModelPlanningInput): PromptPart[] {
    const target = inferOdooTarget(input.prompt);

    const facts = {
      projectName: input.projectName,
      odooVersion: input.analysis?.detectedOdooVersion ?? input.declaredOdooVersion,
      declaredOdooVersion: input.declaredOdooVersion,
      pythonVersion: input.analysis?.pythonVersion ?? null,
      // A hint for the scripted provider and a starting point for a real one,
      // which is free to disagree with it after reading the code.
      targetModel: target.model,
      modules: (input.analysis?.modules ?? []).map((module) => module.technicalName),
      addonRoots: input.analysis?.structure.addonRoots ?? [],
      /**
       * Ordered by relation to the target model rather than by search order, and
       * labelled with that relation so a model can see the reasoning rather than
       * having to trust the order. "extends" means the file declares
       * `_inherit` for this model, which in Odoo is where a change to it belongs.
       */
      candidateFiles: input.rankedCandidates.map((candidate) => ({
        path: candidate.path,
        relation: candidate.relevance,
      })),
      candidatePaths: input.rankedCandidates.length
        ? input.rankedCandidates.map((candidate) => candidate.path)
        : [...new Set(input.searchMatches.map((match) => match.path))],
      analysisNotes: input.analysis?.notes ?? [],
    };

    const parts: PromptPart[] = [
      { label: 'Development request', content: input.prompt, untrusted: false },
      { label: 'Repository analysis', content: JSON.stringify(facts, null, 2), untrusted: false },
    ];

    if (input.searchMatches.length > 0) {
      const lines = input.searchMatches
        .slice(0, 40)
        .map((match) => `${match.path}:${match.line}: ${match.preview}`);
      parts.push({
        label: 'Search results',
        content: lines.join('\n'),
        untrusted: true,
      });
    }

    for (const excerpt of input.excerpts) {
      parts.push({
        label: `File: ${excerpt.path}`,
        content: excerpt.content,
        untrusted: true,
      });
    }

    return parts;
  }
}

/**
 * The planning instruction, appended to the shared system prompt.
 *
 * States what makes a plan usable rather than merely well formed. The two
 * constraints that matter most are that paths must be real - a plan naming a
 * non-existent module cannot be applied - and that the plan must not claim to do
 * more than the tools allow.
 */
const PLANNING_INSTRUCTION = [
  '# This request',
  'Produce an implementation plan for the development request below. You are planning,',
  'not implementing: no file will be changed until a person has approved this plan.',
  '',
  'Requirements for the plan:',
  '- Every path in filesToModify must be a file that exists in this repository, or a',
  '  new file inside a module that exists. Do not invent module names.',
  '- Base the plan on the files you have been shown. If the request needs a file you',
  '  have not seen, say so in the risks rather than guessing at its contents.',
  '- Follow the conventions of the Odoo version stated above.',
  '- The risks must be specific to this repository. "Test before deploying" is not a',
  '  risk; "omnisurge_sale already inherits this view, so the field will appear twice"',
  '  is.',
  '- validation should name the validation tools to run: run_linter, run_python_test,',
  '  run_odoo_test.',
].join('\n');
