import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CatalogModule } from './odoo-module-catalog';

/**
 * ADR-073. The menu a setup plan may select from, read live from this host's
 * Odoo source for the project's own version/edition — never a hand-maintained
 * list that could drift from what the instance being created can actually do.
 *
 * Three kinds of item, each read a different way:
 *
 *  - `settings`: every `group_*` Boolean on `res.config.settings` contributed
 *    by a module in scope. Read from source text (never executed — same
 *    discipline `manifest-parser.ts` already applies to a manifest), because
 *    these are what the Settings screen itself writes through
 *    (`res.config.settings.create({...}).execute()`), so offering exactly
 *    this set means the plan can never ask for anything the Settings screen
 *    could not also set.
 *  - `records`: a short, fixed (not derived from a manifest) list of
 *    model/field combinations this ADR's phase 1 supports — product
 *    attributes, UoM, warehouse route steps, work centers, company fields —
 *    each carrying only the field names and, for a Selection field, the
 *    legal values an applier may need to validate against. There is
 *    deliberately no live introspection of `_fields` here: that happens in
 *    the root-run applier, against the real registry, as defence in depth
 *    (see ADR-073 §3) — this catalog only needs to tell the model and the
 *    sanitiser what a plan entry may name.
 *  - language: a fixed, single affordance (install one `res.lang` through the
 *    existing wizard), not a per-module toggle.
 */

export interface SettingToggle {
  readonly field: string;
  readonly label: string;
  readonly module: string;
}

export interface RecordFieldSpec {
  readonly field: string;
  /** Legal values for a Selection field; undefined for a free-form field. */
  readonly values?: readonly string[];
}

export interface RecordKind {
  readonly model: string;
  readonly label: string;
  /** Which module selection makes this record kind available. */
  readonly requiresModule: string;
  readonly fields: readonly RecordFieldSpec[];
}

export interface OdooSetupCatalog {
  readonly settings: readonly SettingToggle[];
  readonly records: readonly RecordKind[];
  readonly languageInstallAvailable: boolean;
}

/** Matches a `group_xxx = fields.Boolean("Label", ...)` declaration. */
const GROUP_BOOLEAN = /^\s*(group_\w+)\s*=\s*fields\.Boolean\(\s*(['"])((?:(?!\2).)*)\2/gm;

/**
 * Reads the settings-toggle menu for the given selected modules, from each
 * module's own `models/res_config_settings.py` where one exists. A module
 * with no such file (most of them) simply contributes nothing — not an error.
 */
async function settingsToggleMenu(
  addonPaths: readonly string[],
  selectedModules: readonly string[],
): Promise<SettingToggle[]> {
  const toggles: SettingToggle[] = [];
  const seen = new Set<string>();

  for (const moduleName of selectedModules) {
    let source: string | null = null;
    for (const addonPath of addonPaths) {
      source = await readFile(
        join(addonPath, moduleName, 'models', 'res_config_settings.py'),
        'utf8',
      ).catch(() => null);
      if (source !== null) break;
    }
    if (source === null) continue;

    for (const match of source.matchAll(GROUP_BOOLEAN)) {
      const [, field, , label] = match;
      if (seen.has(field)) continue; // Already offered by an earlier module.
      seen.add(field);
      toggles.push({ field, label, module: moduleName });
    }
  }

  return toggles;
}

/**
 * The fixed phase-1 record menu (ADR-073 §2). Not read from a manifest: these
 * are a hand-picked, reviewed set of model/field combinations judged safe and
 * useful to populate from a brief. Extending this list is a reviewed code
 * change, the same posture as `GUARDED_EXECUTABLES`.
 */
function recordMenu(): RecordKind[] {
  return [
    {
      model: 'product.attribute',
      label: 'Product attribute (with its values)',
      requiresModule: 'product',
      fields: [
        { field: 'name' },
        { field: 'create_variant', values: ['always', 'dynamic', 'no_variant'] },
      ],
    },
    {
      model: 'uom.uom',
      label: 'Unit of measure',
      requiresModule: 'uom',
      fields: [{ field: 'name' }, { field: 'relative_uom_id' }, { field: 'relative_factor' }],
    },
    {
      model: 'stock.warehouse',
      label: 'Warehouse route steps',
      requiresModule: 'stock',
      fields: [
        { field: 'reception_steps', values: ['one_step', 'two_steps', 'three_steps'] },
        { field: 'delivery_steps', values: ['ship_only', 'pick_ship', 'pick_pack_ship'] },
        // Only meaningful when mrp is also selected; the applier's own
        // _fields check (ADR-073 §3) is what actually refuses it otherwise.
        { field: 'manufacture_steps', values: ['mrp_one_step', 'pbm', 'pbm_sam'] },
      ],
    },
    {
      model: 'mrp.workcenter',
      label: 'Work center',
      requiresModule: 'mrp',
      fields: [{ field: 'name' }, { field: 'code' }, { field: 'costs_hour' }],
    },
    {
      model: 'res.company',
      label: 'Company field',
      requiresModule: 'base',
      fields: [{ field: 'name' }, { field: 'currency_id' }],
    },
  ];
}

/**
 * Builds the full setup catalog for a version/edition's selected modules.
 * `addonPaths` is the same resolved list `OdooVersionsService.modulesFor`
 * already passes to `enumerateModules` — one source of truth for where this
 * version's modules live.
 */
export async function buildSetupCatalog(
  addonPaths: readonly string[],
  selectedModules: readonly string[],
  catalogue: readonly CatalogModule[],
): Promise<OdooSetupCatalog> {
  const known = new Set(catalogue.map((m) => m.technicalName));
  const inScope = selectedModules.filter((name) => known.has(name));

  const settings = await settingsToggleMenu(addonPaths, inScope);
  const records = recordMenu().filter(
    (kind) => kind.requiresModule === 'base' || inScope.includes(kind.requiresModule),
  );

  return { settings, records, languageInstallAvailable: true };
}

/** Serialises a catalog compactly for a prompt, mirroring `catalogueForPrompt`. */
export function setupCatalogForPrompt(catalog: OdooSetupCatalog): string {
  const lines: string[] = [];

  lines.push('Settings toggles (field: label [module]):');
  for (const toggle of catalog.settings) {
    lines.push(`  ${toggle.field}: ${toggle.label} [${toggle.module}]`);
  }

  lines.push('Record kinds (model: label — fields):');
  for (const kind of catalog.records) {
    const fields = kind.fields
      .map((f) => (f.values ? `${f.field} (one of: ${f.values.join(', ')})` : f.field))
      .join(', ');
    lines.push(`  ${kind.model}: ${kind.label} — ${fields}`);
  }

  if (catalog.languageInstallAvailable) {
    lines.push('Language: one res.lang may be installed by its code (e.g. id_ID, en_US).');
  }

  return lines.join('\n');
}
