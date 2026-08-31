import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { projectEnvironments } from '../../core/database/schema';
import { assertSafeRefName, UnsafeRemoteUrlError } from '../../agent/git/git-url';
import {
  ENVIRONMENT_KINDS,
  TARGETABLE_ENVIRONMENT_KINDS,
  type EnvironmentKind,
} from '../../core/enums';

export interface EnvironmentInput {
  readonly name: string;
  readonly branch: string;
  readonly kind: EnvironmentKind;
  readonly isDefaultTarget?: boolean;
}

/** A row as this service reads it: the resolved shape plus its scope and flag. */
interface TrackedEnvironment extends ResolvedEnvironment {
  readonly organizationId: string;
  readonly isDefaultTarget: boolean;
}

/** What the portal reads: the environment plus which one is the default target. */
export interface ListedEnvironment extends ResolvedEnvironment {
  readonly isDefaultTarget: boolean;
}

export interface ResolvedEnvironment {
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  readonly kind: EnvironmentKind;
}

/**
 * Target environments for a project (ADR-021).
 *
 * In Odoo.sh an environment is a branch, so this is the mapping from a name a
 * person uses to the branch the platform clones. The class exists because two
 * decisions belong in one place: which environment a task targets when none is
 * named, and the refusal of production.
 */
@Injectable()
export class ProjectEnvironmentsService {
  private readonly logger = new Logger(ProjectEnvironmentsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listForProject(projectId: string): Promise<ListedEnvironment[]> {
    const rows = await this.listWithFlags(projectId);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      branch: row.branch,
      kind: row.kind,
      isDefaultTarget: row.isDefaultTarget,
    }));
  }

  /**
   * Creates the environments for a project.
   *
   * Called from project creation inside its transaction, so a project either has
   * its environments or does not exist.
   *
   * A project declared with no environments gets one `development` environment
   * from its default branch. That is deliberate: the alternative is a project with
   * no target, and defaulting the *kind* to development rather than production
   * means nothing is silently treated as production.
   */
  buildForCreation(
    projectId: string,
    organizationId: string,
    defaultBranch: string,
    declared: readonly EnvironmentInput[] | undefined,
  ) {
    const inputs =
      declared && declared.length > 0
        ? declared
        : [
            {
              name: 'Development',
              branch: defaultBranch,
              kind: 'development' as EnvironmentKind,
              isDefaultTarget: true,
            },
          ];

    this.assertValid(inputs);

    /**
     * The default target is never production, whatever was declared.
     *
     * A person who marks production as the default has almost certainly not
     * thought it through, and the platform refuses production as a target anyway -
     * so honouring the flag would produce a project whose default target is
     * refused on every task.
     */
    const explicit = inputs.find(
      (input) => input.isDefaultTarget && input.kind !== 'production',
    );
    const fallback = inputs.find((input) => TARGETABLE_ENVIRONMENT_KINDS.includes(input.kind));
    const defaultTarget = explicit ?? fallback;

    return inputs.map((input) => ({
      projectId,
      organizationId,
      name: input.name.trim(),
      branch: input.branch.trim(),
      kind: input.kind,
      isDefaultTarget: input === defaultTarget,
    }));
  }

  /**
   * Checks one environment on its own terms: name, kind and branch.
   *
   * Separate from the whole-set rules below because the two are different
   * questions, and conflating them produced a bug worth remembering: `add` reused
   * the set validation, so declaring a production branch on an existing project
   * was refused ("every environment declared is production" - true of the
   * one-item set, irrelevant to the project) while declaring the same branch as
   * *development* was accepted. The safe declaration was blocked and the
   * dangerous one waved through.
   */
  private assertValidOne(input: EnvironmentInput): void {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Every environment needs a name.');

    if (!ENVIRONMENT_KINDS.includes(input.kind)) {
      throw new BadRequestException(
        `"${input.kind}" is not an environment kind. Use one of: ${ENVIRONMENT_KINDS.join(', ')}.`,
      );
    }

    try {
      assertSafeRefName(input.branch ?? '');
    } catch (error) {
      throw new BadRequestException(
        error instanceof UnsafeRemoteUrlError
          ? `Environment "${name}": ${error.message}`
          : `Environment "${name}" has an invalid branch.`,
      );
    }
  }

  /**
   * Checks a complete set, as declared at project creation.
   *
   * The rules here are properties of the whole project - uniqueness across the
   * set, and that at least one environment can be worked on - so they belong only
   * where a whole set is being decided.
   */
  private assertValid(inputs: readonly EnvironmentInput[]): void {
    if (inputs.length > 20) {
      throw new BadRequestException('A project may declare at most 20 environments.');
    }

    const names = new Set<string>();
    const branches = new Set<string>();
    let targetable = 0;

    for (const input of inputs) {
      this.assertValidOne(input);
      const name = input.name.trim();
      if (names.has(name.toLowerCase())) {
        throw new BadRequestException(`Two environments are both called "${name}".`);
      }
      names.add(name.toLowerCase());

      if (branches.has(input.branch.trim())) {
        throw new BadRequestException(
          `Two environments both point at the branch "${input.branch.trim()}".`,
        );
      }
      branches.add(input.branch.trim());

      if (TARGETABLE_ENVIRONMENT_KINDS.includes(input.kind)) targetable += 1;
    }

    /**
     * A project whose only environment is production cannot be worked on.
     *
     * Refused at creation rather than at the first task, because the person
     * creating the project is the one who can add a staging branch, and telling
     * them later means a task that fails for a reason they cannot act on.
     */
    if (targetable === 0) {
      throw new BadRequestException(
        'Every environment declared is production, so no task could ever run. ' +
          'Declare at least one staging or development environment.',
      );
    }
  }

  /**
   * Resolves the environment a task will target, and refuses production.
   *
   * This is the guard the whole class exists for. In Odoo.sh the `production`
   * branch *is* the live business, and the MVP has no production deployment path
   * (chapter 17 puts it out of scope). So production is refused outright rather
   * than gated on an approval - a gate in front of a capability that does not
   * exist is worse than a closed door, because it suggests the door opens.
   */
  async resolveTarget(
    projectId: string,
    requestedEnvironmentId: string | undefined,
    actorUserId?: string,
  ): Promise<ResolvedEnvironment> {
    const environments = await this.listWithFlags(projectId);

    if (environments.length === 0) {
      throw new BadRequestException(
        'This project has no environments declared, so there is no branch to work on. ' +
          'Add one in the project settings.',
      );
    }

    if (requestedEnvironmentId) {
      const requested = environments.find((entry) => entry.id === requestedEnvironmentId);
      if (!requested) {
        throw new NotFoundException('That environment does not belong to this project.');
      }
      await this.assertTargetable(projectId, requested, actorUserId);
      return requested;
    }

    const defaultTarget =
      environments.find((entry) => entry.isDefaultTarget) ??
      environments.find((entry) => TARGETABLE_ENVIRONMENT_KINDS.includes(entry.kind));

    if (!defaultTarget) {
      throw new BadRequestException(
        'This project has only a production environment, so no task can run. ' +
          'Add a staging or development environment.',
      );
    }

    await this.assertTargetable(projectId, defaultTarget, actorUserId);
    return defaultTarget;
  }

  private async assertTargetable(
    projectId: string,
    environment: TrackedEnvironment,
    actorUserId?: string,
  ): Promise<void> {
    if (TARGETABLE_ENVIRONMENT_KINDS.includes(environment.kind)) return;

    this.logger.warn(
      `Refused a task targeting "${environment.name}" (${environment.kind}, branch ${environment.branch})`,
    );

    await this.audit.record({
      event: AUDIT_EVENTS.ENVIRONMENT_TARGET_REFUSED,
      organizationId: environment.organizationId,
      projectId,
      userId: actorUserId ?? null,
      metadata: {
        environmentId: environment.id,
        environmentName: environment.name,
        environmentKind: environment.kind,
        branch: environment.branch,
        reason: 'production environments are not targetable (ADR-021 s2)',
      },
    });

    throw new BadRequestException(
      `"${environment.name}" is a ${environment.kind} environment on branch ` +
        `"${environment.branch}", and the platform will not run a task against it. ` +
        'On Odoo.sh that branch is the live business. Target a staging or development ' +
        'environment instead.',
    );
  }

  private async listWithFlags(projectId: string): Promise<TrackedEnvironment[]> {
    const rows = await this.database.db
      .select()
      .from(projectEnvironments)
      .where(eq(projectEnvironments.projectId, projectId))
      .orderBy(projectEnvironments.name);

    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      branch: row.branch,
      kind: row.kind as EnvironmentKind,
      isDefaultTarget: row.isDefaultTarget,
    }));
  }

  /** Adds one environment to an existing project. */
  async add(
    projectId: string,
    organizationId: string,
    input: EnvironmentInput,
  ): Promise<ResolvedEnvironment> {
    // The item's own rules only. Whether the project ends up with something
    // targetable is a project-wide question, answered at task time with a message
    // that says what to add - and declaring a production branch, which leaves a
    // project temporarily unusable, is protective and must not be refused.
    this.assertValidOne(input);

    const existing = await this.listWithFlags(projectId);
    if (existing.some((entry) => entry.name.toLowerCase() === input.name.trim().toLowerCase())) {
      throw new BadRequestException(`An environment called "${input.name}" already exists.`);
    }
    if (existing.some((entry) => entry.branch === input.branch.trim())) {
      throw new BadRequestException(
        `An environment already points at the branch "${input.branch.trim()}".`,
      );
    }

    const [created] = await this.database.db
      .insert(projectEnvironments)
      .values({
        projectId,
        organizationId,
        name: input.name.trim(),
        branch: input.branch.trim(),
        kind: input.kind,
        // Never on creation: changing the default is a separate, deliberate act.
        isDefaultTarget: false,
      })
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.ENVIRONMENT_ADDED,
      organizationId,
      projectId,
      metadata: { environmentId: created.id, name: created.name, branch: created.branch, kind: created.kind },
    });

    return {
      id: created.id,
      name: created.name,
      branch: created.branch,
      kind: created.kind as EnvironmentKind,
    };
  }

  /** Moves the default target. Refuses to point it at production. */
  async setDefaultTarget(projectId: string, environmentId: string): Promise<void> {
    const environments = await this.listWithFlags(projectId);
    const target = environments.find((entry) => entry.id === environmentId);

    if (!target) throw new NotFoundException('That environment does not belong to this project.');
    await this.assertTargetable(projectId, target);

    await this.database.transaction(async (tx) => {
      await tx
        .update(projectEnvironments)
        .set({ isDefaultTarget: false, updatedAt: new Date() })
        .where(eq(projectEnvironments.projectId, projectId));

      await tx
        .update(projectEnvironments)
        .set({ isDefaultTarget: true, updatedAt: new Date() })
        .where(
          and(
            eq(projectEnvironments.projectId, projectId),
            eq(projectEnvironments.id, environmentId),
          ),
        );
    });

    await this.audit.record({
      event: AUDIT_EVENTS.ENVIRONMENT_DEFAULT_CHANGED,
      organizationId: target.organizationId,
      projectId,
      metadata: { environmentId: target.id, name: target.name, branch: target.branch },
    });
  }
}
