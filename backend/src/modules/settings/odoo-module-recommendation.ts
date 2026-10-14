import { z } from 'zod';
import type { CatalogModule } from './odoo-module-catalog';

/**
 * Module recommendation from a project brief (ADR-056 addendum).
 *
 * The model only suggests: what it returns is filtered to the catalogue before
 * anyone sees it, so an invented or misspelled module name never reaches the
 * picker, and the person still confirms the selection before anything installs.
 */
export const RECOMMENDATION_SCHEMA = z.object({
  modules: z
    .array(
      z.object({
        technicalName: z.string().describe('A technical name copied from the catalogue.'),
        reason: z.string().describe('One short sentence tying the module to the brief.'),
      }),
    )
    .describe('The apps this project needs, most important first.'),
});

export type Recommendation = z.infer<typeof RECOMMENDATION_SCHEMA>['modules'];

export const RECOMMENDATION_SYSTEM =
  'You are an Odoo functional consultant. From the project brief, choose the Odoo apps ' +
  'the project needs. Choose only technical names that appear in the catalogue, prefer ' +
  'the fewest apps that cover the brief, and do not list dependencies: they are resolved ' +
  'automatically. Respond with a JSON object and nothing else.';

// ponytail: apps only, to keep the prompt small; send technical modules too if
// recommendations prove to miss ones a brief clearly needs.
export function catalogueForPrompt(catalogue: readonly CatalogModule[]): string {
  return catalogue
    .filter((module) => module.isApplication)
    .map((module) => `${module.technicalName}: ${module.name}${module.category ? ` (${module.category})` : ''}`)
    .join('\n');
}

/** Drops names outside the catalogue and duplicates, keeping the model's order. */
export function keepCatalogued(
  recommendation: Recommendation,
  catalogue: readonly CatalogModule[],
): Recommendation {
  const known = new Set(catalogue.map((module) => module.technicalName));
  const seen = new Set<string>();
  return recommendation.filter(({ technicalName }) => {
    if (!known.has(technicalName) || seen.has(technicalName)) return false;
    seen.add(technicalName);
    return true;
  });
}
