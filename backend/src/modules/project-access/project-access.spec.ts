import { describeProjectAccess } from './project-access.service';

/**
 * How the project access panel describes each organisation member (ADR-043).
 *
 * The distinction that matters is revocable versus not: an admin is in by rank,
 * so rendering them a filled checkbox would promise a revoke that would do
 * nothing when cleared.
 */
describe('describing a member access on the panel', () => {
  it('marks an owner as in by role, with nothing to revoke', () => {
    expect(describeProjectAccess('owner', false, false)).toEqual({
      hasAccess: true,
      source: 'role',
      revocable: false,
    });
  });

  it('marks an admin as in by role, with nothing to revoke', () => {
    expect(describeProjectAccess('admin', false, false)).toEqual({
      hasAccess: true,
      source: 'role',
      revocable: false,
    });
  });

  it('marks the creator as in by creation, with nothing to revoke', () => {
    expect(describeProjectAccess('developer', true, false)).toEqual({
      hasAccess: true,
      source: 'creator',
      revocable: false,
    });
  });

  it('marks a granted developer as revocable', () => {
    expect(describeProjectAccess('developer', false, true)).toEqual({
      hasAccess: true,
      source: 'grant',
      revocable: true,
    });
  });

  it('marks an ungranted viewer as having no access', () => {
    expect(describeProjectAccess('viewer', false, false)).toEqual({
      hasAccess: false,
      source: 'none',
      revocable: false,
    });
  });

  it('does not offer a revoke for a creator who also holds a grant', () => {
    // Revoking would leave them with access anyway, via the creator rule. A
    // toggle that does not change the outcome is worse than no toggle.
    expect(describeProjectAccess('developer', true, true)).toEqual({
      hasAccess: true,
      source: 'creator',
      revocable: false,
    });
  });
});
