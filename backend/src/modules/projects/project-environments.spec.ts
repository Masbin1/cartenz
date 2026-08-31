import { BadRequestException } from '@nestjs/common';
import { ProjectEnvironmentsService } from './project-environments.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuditService } from '../../core/audit/audit.service';

/**
 * The production refusal (ADR-021).
 *
 * On Odoo.sh the `production` branch is the live business, and the MVP has no
 * production deployment path. So a task targeting production is refused outright
 * rather than gated on an approval - a gate in front of a capability that does not
 * exist suggests the door opens.
 *
 * The validation and defaulting tests use no database: `buildForCreation` is pure,
 * and keeping it pure is what makes the refusal easy to be certain of.
 */
describe('ProjectEnvironmentsService', () => {
  // buildForCreation touches neither the database nor the audit trail, so both
  // dependencies stay unused here. A stub that throws would be equally fine.
  const service = new ProjectEnvironmentsService({} as DatabaseService, {} as AuditService);

  const build = (environments: Parameters<typeof service.buildForCreation>[3]) =>
    service.buildForCreation('project-1', 'org-1', 'main', environments);

  describe('defaulting', () => {
    it('gives a project with no declared environments one development environment', () => {
      const result = build(undefined);

      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('development');
      expect(result[0].branch).toBe('main');
      expect(result[0].isDefaultTarget).toBe(true);
    });

    /**
     * The defaulting decision that matters: an undeclared project must not be
     * treated as production, because that would make its default target refused.
     */
    it('never defaults the kind to production', () => {
      expect(build(undefined)[0].kind).not.toBe('production');
      expect(build([])[0].kind).not.toBe('production');
    });

    it('chooses the declared default target', () => {
      const result = build([
        { name: 'Production', branch: 'production', kind: 'production' },
        { name: 'Staging', branch: 'staging', kind: 'staging', isDefaultTarget: true },
        { name: 'Dev', branch: 'dev', kind: 'development' },
      ]);

      expect(result.find((entry) => entry.isDefaultTarget)?.name).toBe('Staging');
    });

    /**
     * A person who marks production as the default has almost certainly not thought
     * it through, and the platform refuses production anyway - so honouring the flag
     * would produce a project whose default target fails on every task.
     */
    it('refuses to make production the default target, and picks another', () => {
      const result = build([
        { name: 'Production', branch: 'production', kind: 'production', isDefaultTarget: true },
        { name: 'Staging', branch: 'staging', kind: 'staging' },
      ]);

      expect(result.find((entry) => entry.isDefaultTarget)?.name).toBe('Staging');
      expect(result.find((entry) => entry.name === 'Production')?.isDefaultTarget).toBe(false);
    });

    it('falls back to the first targetable environment when none is marked', () => {
      const result = build([
        { name: 'Production', branch: 'production', kind: 'production' },
        { name: 'Staging', branch: 'staging', kind: 'staging' },
      ]);

      expect(result.find((entry) => entry.isDefaultTarget)?.name).toBe('Staging');
    });
  });

  describe('validation', () => {
    /**
     * Refused at creation rather than at the first task: the person creating the
     * project is the one who can add a staging branch, and telling them later means
     * a task that fails for a reason they cannot act on.
     */
    it('refuses a project whose every environment is production', () => {
      expect(() =>
        build([
          { name: 'Production', branch: 'production', kind: 'production' },
          { name: 'Prod EU', branch: 'production-eu', kind: 'production' },
        ]),
      ).toThrow(/no task could ever run/);
    });

    it('refuses a duplicate name or branch', () => {
      expect(() =>
        build([
          { name: 'Staging', branch: 'staging', kind: 'staging' },
          { name: 'staging', branch: 'other', kind: 'development' },
        ]),
      ).toThrow(/both called/);

      expect(() =>
        build([
          { name: 'Staging', branch: 'staging', kind: 'staging' },
          { name: 'Other', branch: 'staging', kind: 'development' },
        ]),
      ).toThrow(/both point at the branch/);
    });

    it('refuses a branch name that could be read as a command option', () => {
      for (const branch of ['--upload-pack=evil', '-x', 'a b', 'a;b', 'a..b']) {
        expect(() => build([{ name: 'Bad', branch, kind: 'staging' }])).toThrow(
          BadRequestException,
        );
      }
    });

    it('refuses an unknown kind', () => {
      expect(() =>
        build([{ name: 'X', branch: 'x', kind: 'preprod' as never }]),
      ).toThrow(/not an environment kind/);
    });

    it('refuses an empty name and an unreasonable count', () => {
      expect(() => build([{ name: '  ', branch: 'x', kind: 'staging' }])).toThrow(/needs a name/);
      expect(() =>
        build(
          Array.from({ length: 21 }, (_, index) => ({
            name: `E${index}`,
            branch: `b${index}`,
            kind: 'staging' as const,
          })),
        ),
      ).toThrow(/at most 20/);
    });
  });

  /**
   * Adding one environment to an existing project.
   *
   * These exist because of a real inversion: `add` reused the whole-set
   * validation, so declaring a production branch on an existing project was
   * refused - "every environment declared is production", true of the one-item
   * set and irrelevant to the project - while declaring the same branch as
   * *development* was accepted. The protective declaration was blocked and the
   * dangerous one waved through, and every existing test passed.
   */
  describe('adding one environment', () => {
    const one = (input: Parameters<typeof service.buildForCreation>[3]) =>
      // buildForCreation applies the set rules; assertValidOne applies the item's.
      // Reaching through the private member is deliberate: the point is that these
      // two are different, and a test that could only see the set rules is what
      // let the inversion through.
      (service as unknown as { assertValidOne: (i: unknown) => void }).assertValidOne(
        (input as unknown[])[0],
      );

    it('accepts a production environment on its own', () => {
      expect(() =>
        one([{ name: 'production', branch: 'main', kind: 'production' }]),
      ).not.toThrow();
    });

    it('still refuses an unnamed environment', () => {
      expect(() => one([{ name: '  ', branch: 'main', kind: 'production' }])).toThrow(
        /needs a name/,
      );
    });

    it('still refuses a kind that does not exist', () => {
      expect(() =>
        one([{ name: 'x', branch: 'main', kind: 'preprod' as never }]),
      ).toThrow(/not an environment kind/);
    });

    it('still refuses an unsafe branch name', () => {
      for (const branch of ['--upload-pack=evil', 'a b', '-x', '']) {
        expect(() => one([{ name: 'x', branch, kind: 'development' }])).toThrow();
      }
    });

    it('does not apply the whole-project rule to a single addition', () => {
      // The set rule says a project needs something targetable. Applied to one
      // production environment it refuses the very declaration that makes the
      // platform leave that branch alone.
      expect(() => service.buildForCreation('p', 'o', 'main', [
        { name: 'production', branch: 'main', kind: 'production' },
      ])).toThrow(/no task could ever run/);

      expect(() => one([{ name: 'production', branch: 'main', kind: 'production' }])).not.toThrow();
    });
  });
});
