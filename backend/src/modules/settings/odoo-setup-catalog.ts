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

/** The start of a `group_xxx = fields.Boolean(` declaration. */
const GROUP_BOOLEAN_START = /^[ \t]*(group_\w+)[ \t]*=[ \t]*fields\.Boolean\(/gm;

/**
 * Where a module declares its `res.config.settings` extension. Odoo has no
 * single convention: `models/` is the common case, but `sale` keeps its
 * settings in `wizard/`, `payment` and `account_payment` in `wizards/`, and a
 * few Enterprise modules in `model/` (all verified on this host's 19.0 source
 * and Enterprise checkout).
 */
const SETTINGS_FILE_DIRS = ['models', 'wizard', 'wizards', 'model'] as const;

/**
 * Every `group_*` Boolean declared in one settings file, with its label.
 *
 * Declarations are scanned with paren balancing rather than one regex,
 * because the label is written several ways across the Odoo source — inline
 * (`fields.Boolean("Variants", implied_group=...)`), on the next line
 * (`fields.Boolean(\n    "Quotation Templates", ...)`), or as a keyword
 * (`fields.Boolean(string='Multi-Currencies', ...)`). A single-line regex
 * caught 27 of the 38 toggles in this host's Community source; this catches
 * all 38. A declaration with no label falls back to its field name rather
 * than being dropped: the field is still a real, settable toggle.
 */
export function parseGroupToggles(source: string): { field: string; label: string }[] {
  const toggles: { field: string; label: string }[] = [];

  for (const match of source.matchAll(GROUP_BOOLEAN_START)) {
    const field = match[1];
    const open = (match.index ?? 0) + match[0].length - 1;
    const body = argumentsOf(source, open);
    if (body === null) continue; // Unbalanced: not a declaration we can read.
    toggles.push({ field, label: labelOf(body) ?? field });
  }

  return toggles;
}

/** The text between the paren at `open` and its match, skipping string literals. */
function argumentsOf(source: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/** A positional first-argument label, else a `string=` keyword label. */
function labelOf(body: string): string | null {
  const positional = /^\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(body);
  if (positional) return positional[2];
  const keyword = /\bstring\s*=\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(body);
  return keyword ? keyword[2] : null;
}

/**
 * Reads the settings-toggle menu for the given selected modules, from each
 * module's own settings file(s) where they exist. A module with no such file
 * (most of them) simply contributes nothing — not an error.
 */
async function settingsToggleMenu(
  addonPaths: readonly string[],
  selectedModules: readonly string[],
): Promise<SettingToggle[]> {
  const toggles: SettingToggle[] = [];
  const seen = new Set<string>();

  for (const moduleName of selectedModules) {
    for (const source of await settingsSources(addonPaths, moduleName)) {
      for (const { field, label } of parseGroupToggles(source)) {
        if (seen.has(field)) continue; // Already offered by an earlier module.
        seen.add(field);
        toggles.push({ field, label, module: moduleName });
      }
    }
  }

  return toggles;
}

/**
 * The settings files of one module, from the first addon path that holds the
 * module at all — the same first-match-wins rule Odoo applies to addons_path.
 */
async function settingsSources(
  addonPaths: readonly string[],
  moduleName: string,
): Promise<string[]> {
  for (const addonPath of addonPaths) {
    const moduleDir = join(addonPath, moduleName);
    const manifest = await readFile(join(moduleDir, '__manifest__.py'), 'utf8').catch(() => null);
    if (manifest === null) continue;

    const sources: string[] = [];
    for (const dir of SETTINGS_FILE_DIRS) {
      const source = await readFile(join(moduleDir, dir, 'res_config_settings.py'), 'utf8').catch(
        () => null,
      );
      if (source !== null) sources.push(source);
    }
    return sources;
  }
  return [];
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
