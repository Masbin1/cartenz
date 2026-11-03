/**
 * Maps prompt vocabulary to an Odoo model.
 *
 * A small, explicit table rather than a general parser. Its two consumers are the
 * analysis step, which uses it to choose a search term, and the scripted provider,
 * which uses it to name a target. A real model reads the prompt itself and is free
 * to disagree with the table entirely.
 */

export interface OdooTarget {
  readonly label: string;
  readonly model: string;
  readonly searchTerms: readonly string[];
  readonly keywords: readonly string[];
}

const TARGETS: readonly OdooTarget[] = [
  {
    keywords: ['sales order', 'sale order', 'sale.order', 'quotation'],
    label: 'the Sales Order',
    model: 'sale.order',
    searchTerms: ['sale.order'],
  },
  {
    keywords: ['invoice', 'account.move', 'billing', 'credit note'],
    label: 'the Invoice',
    model: 'account.move',
    searchTerms: ['account.move'],
  },
  {
    keywords: ['partner', 'customer', 'contact', 'res.partner', 'supplier', 'vendor'],
    label: 'the Contact',
    model: 'res.partner',
    searchTerms: ['res.partner'],
  },
  {
    keywords: ['product', 'product.template', 'variant'],
    label: 'the Product',
    model: 'product.template',
    searchTerms: ['product.template'],
  },
  {
    keywords: ['picking', 'delivery', 'stock', 'warehouse', 'transfer'],
    label: 'the Stock Picking',
    model: 'stock.picking',
    searchTerms: ['stock.picking'],
  },
  {
    keywords: ['employee', 'hr.employee', 'staff'],
    label: 'the Employee',
    model: 'hr.employee',
    searchTerms: ['hr.employee'],
  },
  {
    keywords: ['purchase order', 'purchase.order'],
    label: 'the Purchase Order',
    model: 'purchase.order',
    searchTerms: ['purchase.order'],
  },
];

const FALLBACK_TARGET: OdooTarget = {
  keywords: [],
  label: 'the affected model',
  model: 'res.config.settings',
  searchTerms: ['models.Model'],
};

export function inferOdooTarget(prompt: string): OdooTarget {
  const normalised = prompt.toLowerCase();
  for (const target of TARGETS) {
    if (target.keywords.some((keyword) => normalised.includes(keyword))) {
      return target;
    }
  }
  return FALLBACK_TARGET;
}

/**
 * A custom model's technical name (`x_nota_pk`, `x_hpp_batch`, ...), found by
 * pattern rather than a keyword table.
 *
 * `inferOdooTarget`'s table only knows Odoo's own standard models
 * (`sale.order`, `res.partner`, ...) - it has no way to know a custom model a
 * project created exists at all, let alone match a prompt to it. A follow-up
 * like "ya bikinkan sample datanya dong" names no model and falls through
 * `inferOdooTarget` to `res.config.settings`, even when the model was named
 * two messages ago in the same conversation (task_819929: the agent had
 * just listed `x_nota_pk` for the person in its own previous answer, then
 * read `res.config.settings` for this one). This matches Odoo's own naming
 * rule for a custom field/model's technical name (ADR-068:
 * `x_[a-z][a-z0-9_]*`) wherever it appears - the current prompt or an
 * earlier turn - so a name once stated keeps being understood without the
 * person repeating it on every message.
 */
const CUSTOM_MODEL_PATTERN = /\bx_[a-z][a-z0-9_]*\b/g;

/** Every distinct `x_...` technical name mentioned anywhere in `text`, in order of first appearance. */
export function customModelNamesIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.toLowerCase().matchAll(CUSTOM_MODEL_PATTERN)) {
    seen.add(match[0]);
  }
  return [...seen];
}

/**
 * Resolves the model a request is about, a custom model named anywhere in
 * `history` taking priority over `inferOdooTarget`'s standard-model table -
 * but only when the *current* prompt itself names nothing at all.
 *
 * Priority, most specific first:
 * 1. A custom (`x_...`) model named in the *current* prompt.
 * 2. A standard model `inferOdooTarget` matches in the *current* prompt - a
 *    prompt that explicitly pivots ("now add a field to the Sales Order")
 *    must win over a custom name from several turns ago, even though that
 *    custom name is not in `inferOdooTarget`'s table at all.
 * 3. The custom model discussed most in the conversation's earlier turns
 *    (see `mostDiscussedCustomModel`) - this is what makes a follow-up ("ya
 *    bikinkan sample datanya dong") keep working after the model was named
 *    once, since the current prompt alone gives `inferOdooTarget` nothing to
 *    match and it would otherwise fall all the way to the generic fallback.
 * 4. The same `res.config.settings` fallback `inferOdooTarget` already used.
 */
export function resolveOdooTarget(prompt: string, history: readonly string[] = []): OdooTarget {
  const ownNames = customModelNamesIn(prompt);
  if (ownNames.length > 0) return customTarget(ownNames[ownNames.length - 1]);

  const standard = inferOdooTarget(prompt);
  if (standard !== FALLBACK_TARGET) return standard;

  const fromHistory = mostDiscussedCustomModel(history);
  if (fromHistory) return customTarget(fromHistory);

  return FALLBACK_TARGET;
}

/**
 * The custom model name mentioned the most across `history`, a later turn
 * breaking a tie.
 *
 * Not "the last `x_...` name to appear in the text": a model-listing answer
 * (task_885626's own reply named roughly twenty custom models, in no
 * particular order of relevance) makes the textually-last name arbitrary -
 * in that real answer it was one of the QC worksheet templates, not the
 * `x_nota_pk` the person actually went on to discuss. What does distinguish
 * the model under discussion from the rest of a list is that it gets
 * mentioned more than once (there, once in the bullet list and again in the
 * sentence confirming it: "Jadi model x_nota_pk memang ada dan benar.").
 * Frequency, not position, is the signal; recency only breaks a tie between
 * equally-mentioned names.
 */
function mostDiscussedCustomModel(history: readonly string[]): string | null {
  const counts = new Map<string, number>();
  const lastTurnIndex = new Map<string, number>();

  history.forEach((turn, turnIndex) => {
    for (const match of turn.toLowerCase().matchAll(CUSTOM_MODEL_PATTERN)) {
      const name = match[0];
      counts.set(name, (counts.get(name) ?? 0) + 1);
      lastTurnIndex.set(name, turnIndex);
    }
  });

  let best: string | null = null;
  for (const name of counts.keys()) {
    if (
      best === null ||
      counts.get(name)! > counts.get(best)! ||
      (counts.get(name)! === counts.get(best)! && lastTurnIndex.get(name)! > lastTurnIndex.get(best)!)
    ) {
      best = name;
    }
  }
  return best;
}

function customTarget(model: string): OdooTarget {
  return { keywords: [], label: model, model, searchTerms: [model] };
}

/** The search terms the analysis step looks for, given a prompt. */
export function searchTermsFor(prompt: string): readonly string[] {
  return inferOdooTarget(prompt).searchTerms;
}
