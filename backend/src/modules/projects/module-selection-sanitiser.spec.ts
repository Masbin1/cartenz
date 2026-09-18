import { BadRequestException } from '@nestjs/common';
import {
  resolveSelectionOrThrow,
  sanitiseModuleNames,
} from './module-selection-sanitiser';
import type { CatalogModule } from '../settings/odoo-module-catalog';

/**
 * ADR-056. This is the defence-in-depth floor: even though the catalog check
 * (Task 5) already rejects a module name that does not exist on the host, the
 * name still ends up as a single argument to a real shell command
 * (`create-project-db.sh` → `odoo-bin -i <names>`), and neither check should
 * have to be the only thing standing between a request body and a shell.
 */
describe('sanitiseModuleNames', () => {
  it('accepts an ordinary technical name', () => {
    expect(sanitiseModuleNames(['sale_management'])).toEqual(['sale_management']);
  });

  it('rejects a name carrying a shell command', () => {
    expect(() => sanitiseModuleNames(['sale; rm -rf /'])).toThrow(/invalid/i);
  });

  it('rejects a name carrying SQL', () => {
    expect(() => sanitiseModuleNames(["sale' ; DROP TABLE projects; --"])).toThrow(/invalid/i);
  });

  it('rejects an empty string', () => {
    expect(() => sanitiseModuleNames([''])).toThrow(/invalid/i);
  });

  it('rejects a name starting with a digit', () => {
    expect(() => sanitiseModuleNames(['9sale'])).toThrow(/invalid/i);
  });

  it('rejects a name starting with an underscore', () => {
    expect(() => sanitiseModuleNames(['_sale'])).toThrow(/invalid/i);
  });

  it('rejects a name containing a dash', () => {
    expect(() => sanitiseModuleNames(['sale-management'])).toThrow(/invalid/i);
  });

  it('rejects a name containing whitespace', () => {
    expect(() => sanitiseModuleNames(['sale management'])).toThrow(/invalid/i);
  });

  it('rejects an uppercase name', () => {
    expect(() => sanitiseModuleNames(['Sale_Management'])).toThrow(/invalid/i);
  });

  it('de-duplicates and sorts the result', () => {
    expect(sanitiseModuleNames(['stock', 'sale', 'stock'])).toEqual(['sale', 'stock']);
  });

  it('accepts an empty list', () => {
    expect(sanitiseModuleNames([])).toEqual([]);
  });
});

/**
 * ADR-056. What `createAiProject` actually calls: sanitise, then resolve
 * against the catalog, throwing one `BadRequestException` a person can act on
 * rather than the sanitiser's error for a shape problem and the catalog's for
 * a content problem.
 */
describe('resolveSelectionOrThrow', () => {
  const module = (technicalName: string, depends: readonly string[] = []): CatalogModule => ({
    technicalName,
    name: technicalName,
    category: null,
    isApplication: false,
    depends,
  });
  const catalog = [module('sale_management', ['sale']), module('sale'), module('stock')];

  it('returns undefined for an empty or omitted selection', () => {
    expect(resolveSelectionOrThrow(undefined, catalog)).toBeUndefined();
    expect(resolveSelectionOrThrow([], catalog)).toBeUndefined();
  });

  it('returns the resolved closure for a valid selection', () => {
    expect(resolveSelectionOrThrow(['sale_management'], catalog)).toEqual([
      'sale',
      'sale_management',
    ]);
  });

  it('rejects a shell-unsafe name before the catalog is even consulted', () => {
    expect(() => resolveSelectionOrThrow(['sale; rm -rf /'], catalog)).toThrow(
      BadRequestException,
    );
  });

  it('rejects a name absent from this version/edition catalog', () => {
    expect(() => resolveSelectionOrThrow(['not_on_this_host'], catalog)).toThrow(
      /not_on_this_host/,
    );
  });
});
