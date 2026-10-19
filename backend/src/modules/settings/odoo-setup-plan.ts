import { z } from 'zod';
import type { OdooSetupCatalog } from './odoo-setup-catalog';

/**
 * Fit-gap setup plan from a project brief (ADR-073).
 *
 * The model chooses only from the menu `setupCatalogForPrompt` describes —
 * never from imagination — the same discipline `RECOMMENDATION_SCHEMA` +
 * `keepCatalogued` already apply to module names
 * (`odoo-module-recommendation.ts`). What it returns is filtered back against
 * that menu before anyone sees it or before any applier runs, so an invented
 * field or model name never reaches the applier, and the person still reviews
 * every item before it is sent for creation.
 */
/** One configuration entry, exported so a stored or client-sent item can be re-checked. */
export const SETUP_PLAN_ITEM_SCHEMA = z.object({
  kind: z.enum(['setting', 'record', 'company', 'language']),
  /** A field from the settings menu, when kind is "setting". */
  settingField: z.string().optional(),
  /** A model from the record menu, when kind is "record" or "company". */
  model: z.string().optional(),
  /** field -> value, copied from the brief where stated. */
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** A language code (e.g. "id_ID"), when kind is "language". */
  languageCode: z.string().optional(),
  /** Value names for a product.attribute record (e.g. ["18 mm", "25 mm"]). */
  attributeValues: z.array(z.string()).optional(),
  reason: z.string().describe('One short sentence tying this item to the brief.'),
});

export const SETUP_PLAN_SCHEMA = z.object({
  configuration: z
    .array(SETUP_PLAN_ITEM_SCHEMA)
    .describe('What Odoo can already do, applied through a setting or a record.'),
  gaps: z
    .array(
      z.object({
        title: z.string().describe('One short sentence describing what is missing.'),
        detail: z
          .string()
          .optional()
          .describe('The brief excerpt or extra context this gap came from.'),
      }),
    )
    .describe('What no combination of modules and configuration above can express.'),
});

export type SetupPlan = z.infer<typeof SETUP_PLAN_SCHEMA>;
export type ConfigurationItem = SetupPlan['configuration'][number];
export type GapItem = SetupPlan['gaps'][number];

export const SETUP_PLAN_SYSTEM =
  'You are an Odoo functional consultant. From the project brief, propose a starting ' +
  'configuration and list what the brief needs that Odoo configuration cannot do. ' +
  'For "configuration", choose only from the menu given: a setting field, a record model ' +
  'with field values, a company field, or a language code. Never invent a field or model name ' +
  'outside the menu. Copy values from the brief only when the brief actually states them — ' +
  'leave a value out rather than guessing one, especially legal or financial details. For ' +
  '"gaps", list what the brief needs that has no matching item in the menu: computed fields, ' +
  'business logic, optimisation routines, pricing rules. Respond with a JSON object and ' +
  'nothing else.';

/**
 * Drops any configuration item naming a field/model outside the catalog, and
 * any item whose shape does not match its declared kind — the same severity
 * `keepCatalogued` already applies to an invented module name: dropped, not
 * flagged, because there is nothing in the menu to flag it against.
 *
 * Independently floors every model/field name against a narrow pattern,
 * mirroring `sanitiseModuleNames`'s `TECHNICAL_NAME` check — defence in depth
 * ahead of the applier's own `_fields` revalidation (ADR-073 §3).
 */
const TECHNICAL_IDENTIFIER = /^[a-z][a-z0-9_.]*$/;

export function keepCataloguedConfiguration(
  configuration: readonly ConfigurationItem[],
  catalog: OdooSetupCatalog,
): ConfigurationItem[] {
  const settingFields = new Set(catalog.settings.map((s) => s.field));
  const recordModels = new Map(catalog.records.map((r) => [r.model, r] as const));

  return configuration.filter((item) => {
    if (item.kind === 'setting') {
      return (
        typeof item.settingField === 'string' &&
        TECHNICAL_IDENTIFIER.test(item.settingField) &&
        settingFields.has(item.settingField)
      );
    }

    if (item.kind === 'record') {
      if (typeof item.model !== 'string' || !TECHNICAL_IDENTIFIER.test(item.model)) return false;
      const kind = recordModels.get(item.model);
      if (!kind) return false;
      return everyFieldKnown(item.values, kind.fields);
    }

    if (item.kind === 'company') {
      // res.company is always in scope (requiresModule: 'base'); a company
      // item still must name only fields the catalog's res.company entry
      // knows about.
      const companyKind = catalog.records.find((r) => r.model === 'res.company');
      if (!companyKind) return false;
      return everyFieldKnown(item.values, companyKind.fields);
    }

    if (item.kind === 'language') {
      return (
        catalog.languageInstallAvailable &&
        typeof item.languageCode === 'string' &&
        /^[a-z]{2}_[A-Z]{2}$/.test(item.languageCode)
      );
    }

    return false;
  });
}

function everyFieldKnown(
  values: Record<string, string | number | boolean> | undefined,
  fields: OdooSetupCatalog['records'][number]['fields'],
): boolean {
  if (!values) return true;
  const known = new Map(fields.map((f) => [f.field, f] as const));
  for (const [field, value] of Object.entries(values)) {
    if (!TECHNICAL_IDENTIFIER.test(field)) return false;
    const spec = known.get(field);
    if (!spec) return false;
    if (spec.values && typeof value === 'string' && !spec.values.includes(value)) return false;
  }
  return true;
}
