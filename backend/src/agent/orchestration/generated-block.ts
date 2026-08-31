/**
 * The marked block the scripted provider writes into a file.
 *
 * Every generated edit is fenced by these markers, for two reasons: a reviewer
 * reading the diff can see exactly what the platform added, and a later task can
 * find and replace its own previous block instead of appending a second one.
 *
 * Extracted from the planner so the scripted provider can use it. A real model
 * writes whatever it decides to write and does not use this at all.
 */

const BLOCK_START = '# --- LinkedERP AI: begin generated block ---';
const BLOCK_END = '# --- LinkedERP AI: end generated block ---';
const XML_BLOCK_START = '<!-- LinkedERP AI: begin generated block -->';
const XML_BLOCK_END = '<!-- LinkedERP AI: end generated block -->';

/**
 * Inserts a marked block into an existing file, replacing any previous one.
 *
 * The block is placed at the end rather than spliced into the middle of a
 * declaration: a scripted writer cannot reliably locate the right insertion point
 * in arbitrary source, and a wrong splice produces a syntactically broken file.
 *
 * "The end" means something different for XML. Appending after the closing root
 * element produces a document with two roots, which is not well-formed XML and
 * which Odoo refuses to load - so for XML the block goes immediately before the
 * closing root tag instead. That distinction is why this is not a concatenation.
 */
export function insertGeneratedBlock(current: string, path: string, summary: string): string {
  const isXml = path.endsWith('.xml');
  const start = isXml ? XML_BLOCK_START : BLOCK_START;
  const end = isXml ? XML_BLOCK_END : BLOCK_END;
  const body = isXml ? xmlBody(summary) : pythonBody(summary);
  const block = `${start}\n${body}\n${end}`;

  // Replace a block this platform wrote previously, so a second task on the same
  // file updates its own block rather than adding another one.
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  if (startIndex !== -1 && endIndex > startIndex) {
    return current.slice(0, startIndex) + block + current.slice(endIndex + end.length);
  }

  return isXml ? insertBeforeClosingRoot(current, block) : appendAtEnd(current, block);
}

/** Content for a file that does not exist yet. */
export function generatedFileTemplate(path: string, summary: string): string {
  if (path.endsWith('.xml')) {
    return [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<odoo>',
      XML_BLOCK_START,
      xmlBody(summary),
      XML_BLOCK_END,
      '</odoo>',
      '',
    ].join('\n');
  }

  return ['from odoo import fields, models', '', '', BLOCK_START, pythonBody(summary), BLOCK_END, ''].join(
    '\n',
  );
}

function appendAtEnd(current: string, block: string): string {
  const separator = current.endsWith('\n') ? '\n' : '\n\n';
  return `${current}${separator}${block}\n`;
}

/**
 * Places a block immediately before an XML document's closing root element.
 *
 * The root is found as the last closing tag in the document, which is correct for
 * the Odoo data files this applies to. If no closing tag is found the document is
 * not what was expected, and the block is appended rather than silently dropped: a
 * visibly odd file is better than a lost change.
 */
function insertBeforeClosingRoot(current: string, block: string): string {
  const closingTag = /<[/][A-Za-z_][A-Za-z0-9_.:-]*>\s*$/.exec(current);
  if (!closingTag) return appendAtEnd(current, block);

  const head = current.slice(0, closingTag.index);
  const tail = current.slice(closingTag.index);
  const separator = head.endsWith('\n') ? '' : '\n';

  return `${head}${separator}${block}\n${tail}`;
}

function pythonBody(summary: string): string {
  return [
    `# ${summary}`,
    '# Reviewed and approved through the LinkedERP approval workflow before it was written.',
    '#',
    '# Written by the scripted provider, which does not reason about code. Configure',
    '# an AI provider for a model-authored change.',
  ].join('\n');
}

function xmlBody(summary: string): string {
  return `  <!-- ${summary.replace(/--+/g, '-')} -->`;
}
