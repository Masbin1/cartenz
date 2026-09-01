import { owningAddon, rankModulesForModel } from './odoo-model-ownership';

/**
 * Choosing the module a new extension belongs in (ADR-028).
 *
 * Written from the repository that produced it. Two Odoo 19 modules:
 * `pos_discount_restrict` depending on `point_of_sale`, and
 * `vif_sales_incentive` depending on `base, hr, sale_management, account`.
 * Neither extends `sale.order`, so ADR-025 had nothing to rank and the choice
 * fell to the first name alphabetically — which is the POS module.
 */
describe('owningAddon', () => {
  it('knows the addon behind the models a consultancy is asked about', () => {
    expect(owningAddon('sale.order')).toBe('sale');
    expect(owningAddon('sale.order.line')).toBe('sale');
    expect(owningAddon('purchase.order')).toBe('purchase');
    expect(owningAddon('account.move')).toBe('account');
    expect(owningAddon('stock.picking')).toBe('stock');
    expect(owningAddon('pos.order')).toBe('point_of_sale');
    expect(owningAddon('hr.employee')).toBe('hr');
    expect(owningAddon('res.partner')).toBe('base');
  });

  it('admits it does not know, rather than guessing from the prefix', () => {
    // A wrong owner chosen confidently is worse than no preference: no preference
    // returns the previous behaviour, a wrong one sends the change to the wrong
    // module with an explanation attached.
    expect(owningAddon('vif.incentive.scheme')).toBeNull();
    expect(owningAddon('x_custom.thing')).toBeNull();
    expect(owningAddon('')).toBeNull();
  });
});

describe('rankModulesForModel', () => {
  const vania = [
    { technicalName: 'pos_discount_restrict', depends: ['point_of_sale'] },
    { technicalName: 'vif_sales_incentive', depends: ['base', 'hr', 'sale_management', 'account'] },
  ];

  it('puts the sales module first for a sale.order field', () => {
    // The case this exists for. Alphabetically the POS module wins; by what the
    // manifests declare, it does not.
    const ranked = rankModulesForModel(vania, 'sale.order');

    expect(ranked[0].technicalName).toBe('vif_sales_incentive');
    expect(ranked[0].fit).toBe('depends-on-owner');
    expect(ranked[1].fit).toBe('no-signal');
  });

  it('puts the POS module first for a pos.order field', () => {
    // The same repository, the other way round, so the rule is not just a
    // hard-coded preference for one module.
    expect(rankModulesForModel(vania, 'pos.order')[0].technicalName).toBe(
      'pos_discount_restrict',
    );
  });

  it('accepts an app module as satisfying its technical addon', () => {
    // sale_management depends on sale; in Odoo the app wraps the technical module.
    expect(
      rankModulesForModel([{ technicalName: 'm', depends: ['sale_management'] }], 'sale.order')[0]
        .fit,
    ).toBe('depends-on-owner');
  });

  it('does not let a bare prefix match', () => {
    // "accountant" must not satisfy "account", or a module is chosen confidently
    // for the wrong reason.
    expect(
      rankModulesForModel([{ technicalName: 'm', depends: ['accountant'] }], 'account.move')[0].fit,
    ).toBe('no-signal');
  });

  it('keeps the caller order when nothing gives a signal', () => {
    const ranked = rankModulesForModel(
      [
        { technicalName: 'first', depends: ['base'] },
        { technicalName: 'second', depends: ['web'] },
      ],
      'vif.incentive.scheme',
    );

    expect(ranked.map((entry) => entry.technicalName)).toEqual(['first', 'second']);
    expect(ranked.every((entry) => entry.fit === 'no-signal')).toBe(true);
  });

  it('returns an empty list for no modules rather than throwing', () => {
    expect(rankModulesForModel([], 'sale.order')).toEqual([]);
  });
});
