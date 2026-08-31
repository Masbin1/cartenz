/**
 * Which files declare or extend which Odoo models (ADR-025).
 *
 * Written after the first run against a real customer repository planned a change
 * to `sale.order` in `linkederp_dashboard_studio/models/dashboard.py` - a file that
 * mentions the words but does not extend the model - while
 * `linkederp_sales_modifier/models/sale_order.py`, which begins
 * `_inherit = 'sale.order'`, sat unused.
 *
 * The cause was that candidate files came from a text search and were ranked by
 * the order the walker happened to return them. A text search cannot tell the
 * difference between a file that extends a model and a file that mentions it in a
 * comment. This can, because in Odoo the difference is declared: `_name` defines a
 * model and `_inherit` extends one.
 *
 * Parsed as text, never executed. The parsing is deliberately shallow - it reads
 * assignments to `_name` and `_inherit` and nothing else - because a Python parser
 * would be a large dependency for a question this narrow, and a shallow read that
 * is wrong about an unusual file only costs a worse ranking.
 */

/** Declarations found in one file. */
export interface ModelDeclarations {
  readonly path: string;
  /** Models this file defines with `_name`. */
  readonly defines: readonly string[];
  /** Models this file extends with `_inherit`. */
  readonly extends: readonly string[];
}

/**
 * `_name = 'x'` and `_inherit = 'x'`, in single or double quotes.
 *
 * Written as literals rather than built from strings: a pattern assembled from a
 * string source needs its backslashes doubled, and getting that wrong produces a
 * regex that silently matches nothing.
 */
const SINGLE_ASSIGNMENT = /^\s*(_name|_inherit)\s*=\s*['"]([A-Za-z0-9_.]+)['"]/gm;

/** `_inherit = ['a.b', "c.d"]`, possibly spread over several lines. */
const LIST_ASSIGNMENT = /^\s*(_inherit)\s*=\s*\[([^\]]*)\]/gms;

/** The quoted entries inside such a list. */
const QUOTED_ENTRY = /['"]([A-Za-z0-9_.]+)['"]/g;

/**
 * An Odoo view or action record naming the model it applies to:
 * `<field name="model">sale.order</field>`.
 *
 * The XML equivalent of `_inherit`, and read for the same reason. Without it a
 * view file could only ever be ranked as "mentions", and on the repository this
 * was written against three different view files mention `sale.order` while only
 * two declare it.
 *
 * `ir.ui.view` and `ir.actions.act_window` are excluded, because that is the
 * record's own type rather than the business model it concerns.
 */
const XML_MODEL_FIELD = /<field\s+name=["']model["']\s*>([A-Za-z0-9_.]+)<\/field>/g;

const RECORD_TYPES = new Set(['ir.ui.view', 'ir.actions.act_window', 'ir.model.access']);

/** Reads one Python file's model declarations. */
export function readModelDeclarations(path: string, source: string): ModelDeclarations {
  const defines = new Set<string>();
  const extended = new Set<string>();

  // XML declares its target differently, and a view file is where the other half
  // of an Odoo change goes, so it has to be read rather than left as "mentions".
  if (path.endsWith('.xml')) {
    for (const match of source.matchAll(XML_MODEL_FIELD)) {
      if (!RECORD_TYPES.has(match[1])) extended.add(match[1]);
    }
    return { path, defines: [], extends: [...extended] };
  }

  for (const match of source.matchAll(SINGLE_ASSIGNMENT)) {
    const [, keyword, model] = match;
    (keyword === '_name' ? defines : extended).add(model);
  }

  for (const match of source.matchAll(LIST_ASSIGNMENT)) {
    for (const entry of match[2].matchAll(QUOTED_ENTRY)) {
      extended.add(entry[1]);
    }
  }

  return {
    path,
    defines: [...defines],
    extends: [...extended],
  };
}

/** How well a file matches the model a request is about. */
export type ModelRelevance = 'extends' | 'defines' | 'mentions' | 'unrelated';

export function relevanceTo(
  declarations: ModelDeclarations,
  model: string,
  source: string,
): ModelRelevance {
  // Extending is ranked above defining: a request to add a field to `sale.order`
  // in a customer's repository almost always belongs in the module that already
  // extends it, not in Odoo's own definition, which is not in the repository at all.
  if (declarations.extends.includes(model)) return 'extends';
  if (declarations.defines.includes(model)) return 'defines';
  return source.includes(model) ? 'mentions' : 'unrelated';
}

const RELEVANCE_ORDER: Record<ModelRelevance, number> = {
  extends: 0,
  defines: 1,
  mentions: 2,
  unrelated: 3,
};

export interface RankedCandidate {
  readonly path: string;
  readonly relevance: ModelRelevance;
}

/**
 * The file Odoo convention puts a model's extension in: `sale.order` in
 * `sale_order.py`.
 *
 * Used only to break a tie between files that all extend the model. It is a
 * convention, not a rule - a repository is free to ignore it - which is why it
 * ranks below the declaration and never overrides it. On the repository this was
 * written against, two files extend `sale.order`: `sale_order_sla.py`, which adds
 * service-level fields, and `sale_order.py`, which is where a general field
 * belongs. Nothing in the code says so; the filename is the only signal there is.
 */
function matchesConventionalFilename(path: string, model: string): boolean {
  const basename = path.split('/').pop() ?? '';
  const slug = model.replace(/[.]/g, '_');

  // `sale_order.py` for the model, `sale_order_views.xml` for its views: the two
  // halves of an Odoo change, each with its own convention.
  return basename === `${slug}.py` || basename === `${slug}_views.xml`;
}

/**
 * Orders candidate files by how they relate to the model, best first.
 *
 * Sorted on the declaration first, then on the filename convention, then on the
 * caller's order - which the search produced by its own relevance, and about
 * which there is nothing better to say.
 */
export function rankCandidates(
  candidates: readonly { path: string; source: string }[],
  model: string,
): RankedCandidate[] {
  return candidates
    .map((candidate, index) => ({
      path: candidate.path,
      relevance: relevanceTo(
        readModelDeclarations(candidate.path, candidate.source),
        model,
        candidate.source,
      ),
      conventional: matchesConventionalFilename(candidate.path, model),
      index,
    }))
    .sort(
      (a, b) =>
        RELEVANCE_ORDER[a.relevance] - RELEVANCE_ORDER[b.relevance] ||
        Number(b.conventional) - Number(a.conventional) ||
        a.index - b.index,
    )
    .map(({ path, relevance }) => ({ path, relevance }));
}
