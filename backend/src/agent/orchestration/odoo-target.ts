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

/** The search terms the analysis step looks for, given a prompt. */
export function searchTermsFor(prompt: string): readonly string[] {
  return inferOdooTarget(prompt).searchTerms;
}
