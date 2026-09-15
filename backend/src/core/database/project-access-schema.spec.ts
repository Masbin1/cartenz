import { PROJECT_ACCESS_REQUEST_STATUSES } from '../enums';
import { projectAccessRequests, projectMembers } from './schema';

/**
 * The shape of the access tables (ADR-043).
 *
 * A grant deliberately carries no role and no expiry: depth stays with the
 * organisation role, and a column added here would become a second source of
 * truth for it. These assertions fail if someone adds one.
 */
describe('project access tables', () => {
  it('declares a grant with no role and no expiry', () => {
    const columns = Object.keys(projectMembers);
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'projectId', 'userId', 'grantedByUserId']),
    );
    expect(columns).not.toContain('role');
    expect(columns).not.toContain('permissions');
    expect(columns).not.toContain('expiresAt');
  });

  it('keeps a decided request rather than only a pending one', () => {
    const columns = Object.keys(projectAccessRequests);
    expect(columns).toEqual(
      expect.arrayContaining([
        'projectId',
        'userId',
        'reason',
        'status',
        'decidedByUserId',
        'decidedAt',
        'decisionNote',
      ]),
    );
  });

  it('closes the request statuses', () => {
    expect([...PROJECT_ACCESS_REQUEST_STATUSES]).toEqual([
      'pending',
      'approved',
      'rejected',
      'cancelled',
    ]);
  });
});
