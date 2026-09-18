import { BadRequestException } from '@nestjs/common';
import {
  resolveDependencyClosure,
  type CatalogModule,
} from '../settings/odoo-module-catalog';

/**
 * ADR-056. Odoo technical names are lowercase, start with a letter, and use
 * only letters, digits and underscores (`sale_management`, `account_3way_match`).
 * Anything else is not a module this host could carry, and a name that fails
 * this pattern has no business reaching a shell command.
 *
 * This does not know about the catalog: the service layer runs the catalog
 * check and this check both, and neither substitutes for the other.
 */
const TECHNICAL_NAME = /^[a-z][a-z0-9_]*$/;

export function sanitiseModuleNames(names: readonly string[]): string[] {
  for (const name of names) {
    if (typeof name !== 'string' || !TECHNICAL_NAME.test(name)) {
      throw new BadRequestException(
        `Invalid module name: ${JSON.stringify(name)}. A module name is a lowercase ` +
          'technical name such as "sale_management".',
      );
    }
  }

  return [...new Set(names)].sort();
}

/**
 * What `createAiProject` actually calls: sanitise the raw selection, then
 * resolve it against this version/edition's catalog, throwing one
 * `BadRequestException` a person can act on either way. `undefined` means
 * "no selection made" (today's default: install everything), which is
 * distinct from an empty array only in that both mean the same thing here —
 * neither reaches the sanitiser or the catalog.
 */
export function resolveSelectionOrThrow(
  selection: readonly string[] | undefined,
  catalog: readonly CatalogModule[],
): string[] | undefined {
  if (!selection || selection.length === 0) return undefined;

  const sanitised = sanitiseModuleNames(selection);
  const { resolved, unknown } = resolveDependencyClosure(sanitised, catalog);

  if (unknown.length > 0) {
    throw new BadRequestException(
      `Unknown module(s) for this Odoo version and edition: ${unknown.join(', ')}.`,
    );
  }

  return resolved;
}
