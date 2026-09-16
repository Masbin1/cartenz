import { describeProjectAccess } from './project-access.service';

/**
 * How the project access panel describes each account (ADR-043).
 *
 * The distinction that matters is revocable versus not: an admin is in by rank,
 * so rendering them a filled checkbox would promise a revoke that would do
 * nothing when cleared.
 */
describe('describing a member access on the panel', () => {
  it('marks an admin as in by rank, with nothing to revoke', () => {
    expect(describeProjectAccess(true, false, false)).toEqual({
      hasAccess: true,
      source: 'admin',
      revocable: false,
    });
  });

  it('marks the creator as in by creation, with nothing to revoke', () => {
    expect(describeProjectAccess(false, true, false)).toEqual({
      hasAccess: true,
      source: 'creator',
      revocable: false,
    });
  });

  it('marks a granted user as revocable', () => {
    expect(describeProjectAccess(false, false, true)).toEqual({
      hasAccess: true,
      source: 'grant',
      revocable: true,
    });
  });

  it('marks an ungranted user as having no access', () => {
    expect(describeProjectAccess(false, false, false)).toEqual({
      hasAccess: false,
      source: 'none',
      revocable: false,
    });
  });

  it('does not offer a revoke for a creator who also holds a grant', () => {
    // Revoking would leave them with access anyway, via the creator rule. A
    // toggle that does not change the outcome is worse than no toggle.
    expect(describeProjectAccess(false, true, true)).toEqual({
      hasAccess: true,
      source: 'creator',
      revocable: false,
    });
  });

  it('lets the admin flag win over any grant', () => {
    // Rank is not revocable, and it must not read as if it were.
    expect(describeProjectAccess(true, false, true)).toEqual({
      hasAccess: true,
      source: 'admin',
      revocable: false,
    });
  });
});
