import { decideProjectAccess } from './project-access';

/**
 * The rule that decides whether a member may open a project (ADR-043).
 *
 * Extracted from the authorisation service so it can be asserted without a
 * database. Each test is one branch of the order the service applies them in,
 * and the order matters: a change that lets an ungranted developer through
 * fails here.
 */
describe('deciding project access', () => {
  const base = { userId: 'user-1', createdByUserId: null, hasGrant: false };

  it('lets an owner in without a grant', () => {
    expect(decideProjectAccess({ ...base, role: 'owner' })).toEqual({
      allowed: true,
      reason: 'role',
    });
  });

  it('lets an admin in without a grant', () => {
    expect(decideProjectAccess({ ...base, role: 'admin' })).toEqual({
      allowed: true,
      reason: 'role',
    });
  });

  it('lets the person who created the project in without a grant', () => {
    // Being locked out of your own project is a bug, not a policy.
    expect(
      decideProjectAccess({ ...base, role: 'developer', createdByUserId: 'user-1' }),
    ).toEqual({ allowed: true, reason: 'creator' });
  });

  it('lets a granted developer in', () => {
    expect(decideProjectAccess({ ...base, role: 'developer', hasGrant: true })).toEqual({
      allowed: true,
      reason: 'grant',
    });
  });

  it('lets a granted viewer in', () => {
    // A grant says "may open", not "may change": depth stays with the org role.
    expect(decideProjectAccess({ ...base, role: 'viewer', hasGrant: true })).toEqual({
      allowed: true,
      reason: 'grant',
    });
  });

  it('refuses an ungranted developer', () => {
    expect(decideProjectAccess({ ...base, role: 'developer' })).toEqual({
      allowed: false,
      reason: 'none',
    });
  });

  it('refuses an ungranted viewer', () => {
    expect(decideProjectAccess({ ...base, role: 'viewer' })).toEqual({
      allowed: false,
      reason: 'none',
    });
  });

  it('does not treat a null creator as matching a caller', () => {
    // createdByUserId is nullable (the creator's account may have been deleted).
    // A null must never equal a caller who also has no id in some future shape.
    expect(
      decideProjectAccess({ ...base, role: 'viewer', createdByUserId: null }),
    ).toEqual({ allowed: false, reason: 'none' });
  });
});
