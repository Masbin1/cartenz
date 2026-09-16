import { decideProjectAccess } from './project-access';

/**
 * The rule that decides whether a member may open a project (ADR-043, ADR-044).
 *
 * Extracted from the authorisation service so it can be asserted without a
 * database. Each test is one branch of the order the service applies them in,
 * and the order matters: a change that lets an ungranted user through fails
 * here.
 */
describe('deciding project access', () => {
  const base = { userId: 'user-1', isAdmin: false, createdByUserId: null, hasGrant: false };

  it('lets an admin in without a grant', () => {
    expect(decideProjectAccess({ ...base, isAdmin: true })).toEqual({
      allowed: true,
      reason: 'admin',
    });
  });

  it('lets the person who created the project in without a grant', () => {
    // Being locked out of your own project is a bug, not a policy.
    expect(
      decideProjectAccess({ ...base, createdByUserId: 'user-1' }),
    ).toEqual({ allowed: true, reason: 'creator' });
  });

  it('lets a granted user in', () => {
    expect(decideProjectAccess({ ...base, hasGrant: true })).toEqual({
      allowed: true,
      reason: 'grant',
    });
  });

  it('refuses an ungranted user', () => {
    expect(decideProjectAccess(base)).toEqual({
      allowed: false,
      reason: 'none',
    });
  });

  it('does not treat a null creator as matching a caller', () => {
    // createdByUserId is nullable (the creator's account may have been deleted).
    // A null must never equal a caller who also has no id in some future shape.
    expect(
      decideProjectAccess({ ...base, createdByUserId: null }),
    ).toEqual({ allowed: false, reason: 'none' });
  });

  it('lets an admin through the creator and grant checks are never consulted', () => {
    // Order is policy: the admin flag must not depend on a grant being fetched.
    expect(
      decideProjectAccess({ ...base, isAdmin: true, hasGrant: false }),
    ).toEqual({ allowed: true, reason: 'admin' });
  });
});
