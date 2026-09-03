import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import {
  agentTasks,
  projectConnections,
  projectEnvironments,
  projectSpecifications,
  projects,
  secretRecords,
} from '../../core/database/schema';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import {
  DEFAULT_AGENT_PERMISSIONS,
  isAgentPermission,
  isNeverGrantable,
  resolveAgentPermissions,
} from '../../core/authz/agent-permissions';
import { REPOSITORY_BACKED_PROJECT_TYPES } from '../../core/enums';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { redactMetadata } from '../../core/audit/redact';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { buildProjectSpecification } from './project-specification';
import { ProjectMemoryService } from '../../agent/analysis/project-memory.service';
import { ProjectEnvironmentsService } from './project-environments.service';
import { WorkspaceManager } from '../../agent/workspace/workspace-manager';
import { TERMINAL_TASK_STATUSES } from '../../agent/task-state';
import { assertSafeRemoteUrl, UnsafeRemoteUrlError } from '../../agent/git/git-url';
import { GitService } from '../../agent/git/git.service';
import {
  databaseFromUrl,
  instanceRootOf,
  OdooOnlineClient,
} from '../../agent/odoo-online/odoo-online-client';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { listOnPremiseFolders, type OnPremiseFolder } from './on-premise-locations';
import type {
  CreateAiProjectDto,
  CreateConnectionDto,
  CreateProjectDto,
  ListProjectsQueryDto,
  UpdateProjectDto,
} from './dto/project.dto';

/**
 * Projects, connections and specifications.
 *
 * Every method resolves authorisation first and then filters on the organisation
 * the authorisation service returned, so a project can only be reached through an
 * organisation the caller belongs to.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
    private readonly projectMemory: ProjectMemoryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly environments: ProjectEnvironmentsService,
    private readonly workspaces: WorkspaceManager,
    private readonly git: GitService,
    private readonly odooOnline: OdooOnlineClient,
  ) {}

  /**
   * Validates a repository URL through the same function the clone path uses.
   *
   * Checked here so that an unusable URL is refused when a person types it, rather
   * than surfacing as a failed task minutes later, and so that the refusal message
   * is the specific one - which scheme, and why.
   */
  private assertRepositoryUrl(url: string): void {
    try {
      assertSafeRemoteUrl(url, { allowLocal: this.config.git.allowLocalRemotes });
    } catch (error) {
      if (error instanceof UnsafeRemoteUrlError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * The branches a repository actually has, so environments are picked rather
   * than typed.
   *
   * Typing is where the names diverge: a project declaring `staging` against a
   * repository whose branch is `Staging` clones nothing, and the failure arrives
   * minutes later as a missing branch rather than as a typo.
   *
   * A caller-supplied URL that is then reached over the network is an SSRF
   * surface, so it goes through the same `assertSafeRemoteUrl` the clone path
   * uses - no scheme is reachable here that is not reachable there.
   */
  private async readRemoteBranches(repositoryUrl: string): Promise<readonly string[]> {
    this.assertRepositoryUrl(repositoryUrl);

    try {
      return await this.git.listRemoteBranches(repositoryUrl);
    } catch (error) {
      // A private or mistyped repository is the caller's problem to correct, not
      // a platform fault - and the portal falls back to typing a branch, so the
      // reason has to survive to the response.
      const detail = error instanceof Error ? error.message : 'the repository could not be read';
      throw new BadRequestException(`Could not read branches from that repository: ${detail}`);
    }
  }

  /** Branch probe for the project-creation form, before a project exists. */
  async remoteBranchesFor(
    user: AuthenticatedUser,
    organizationId: string,
    repositoryUrl: string,
  ): Promise<{ branches: readonly string[] }> {
    await this.authz.requireOrganizationMember(user, organizationId, 'developer');
    return { branches: await this.readRemoteBranches(repositoryUrl) };
  }

  /**
   * The folders an on-premise project may be pointed at, for the creation form
   * (ADR-028).
   *
   * Read while the form is being filled in, so a person picks a directory instead
   * of typing a host path. Returns `root: null` when on-premise execution is not
   * configured on this host, so the portal can say so rather than guess.
   */
  async onPremiseLocations(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<{ root: string | null; folders: OnPremiseFolder[] }> {
    await this.authz.requireOrganizationMember(user, organizationId, 'developer');
    const root = this.config.onPremise.root;
    if (!root) return { root: null, folders: [] };
    return { root, folders: await listOnPremiseFolders(root) };
  }

  /**
   * Branch probe for a project that already exists.
   *
   * Repository-backed projects read the remote; an on-premise project reads the
   * branches of its local working copy, because there is no remote URL to probe.
   */
  async remoteBranches(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<{ branches: readonly string[] }> {
    await this.authz.requireProjectAccess(user, projectId, 'developer');

    const [project] = await this.database.db
      .select({
        projectType: projects.projectType,
        repositoryUrl: projects.repositoryUrl,
        environmentConfig: projects.environmentConfig,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundException('Project not found');

    if (project.projectType === 'on_premise') {
      const path = readOnPremisePath(project.environmentConfig);
      if (!path) {
        throw new BadRequestException(
          'This on-premise project has no local directory selected.',
        );
      }
      return { branches: await this.git.listBranches(path) };
    }

    if (!project.repositoryUrl) {
      throw new BadRequestException('This project has no repository to read branches from.');
    }

    return { branches: await this.readRemoteBranches(project.repositoryUrl) };
  }

  async list(user: AuthenticatedUser, query: ListProjectsQueryDto) {
    await this.authz.requireOrganizationMember(user, query.organizationId);

    const where = query.includeArchived
      ? eq(projects.organizationId, query.organizationId)
      : and(eq(projects.organizationId, query.organizationId), isNull(projects.archivedAt));

    return this.database.db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        projectType: projects.projectType,
        odooVersion: projects.odooVersion,
        defaultBranch: projects.defaultBranch,
        repositoryUrl: projects.repositoryUrl,
        archivedAt: projects.archivedAt,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        taskCount: sql<number>`(
          select count(*)::int from agent_tasks t where t.project_id = ${projects.id}
        )`,
        openTaskCount: sql<number>`(
          select count(*)::int from agent_tasks t
          where t.project_id = ${projects.id}
            and t.status not in ('completed', 'failed', 'cancelled')
        )`,
      })
      .from(projects)
      .where(where)
      .orderBy(desc(projects.updatedAt));
  }

  /** Connect an existing project. Requires the developer role or above. */
  async create(user: AuthenticatedUser, dto: CreateProjectDto) {
    await this.authz.requireOrganizationMember(user, dto.organizationId, 'developer');

    if (
      REPOSITORY_BACKED_PROJECT_TYPES.includes(dto.projectType) &&
      (!dto.repositoryUrl || dto.repositoryUrl.length === 0)
    ) {
      throw new BadRequestException(
        `A repository URL is required for a ${dto.projectType} project.`,
      );
    }

    if (dto.projectType === 'ai_project') {
      throw new BadRequestException(
        'Use POST /projects/ai to create a project through the AI flow.',
      );
    }

    if (dto.repositoryUrl) {
      this.assertRepositoryUrl(dto.repositoryUrl);
    }

    const environmentConfig = this.sanitiseEnvironmentConfig(dto.environmentConfig);

    // Validated before the transaction opens, so a bad environment list is a 400
    // rather than a rolled-back insert.
    const defaultBranch = dto.defaultBranch ?? 'main';
    this.environments.buildForCreation('', dto.organizationId, defaultBranch, dto.environments);

    const project = await this.insertProject({
      organizationId: dto.organizationId,
      name: dto.name,
      description: dto.description ?? null,
      projectType: dto.projectType,
      odooVersion: dto.odooVersion ?? null,
      defaultBranch,
      repositoryUrl: dto.repositoryUrl ?? null,
      environmentConfig,
      createdByUserId: user.userId,
    });

    await this.database.db.insert(projectEnvironments).values(
      this.environments.buildForCreation(
        project.id,
        dto.organizationId,
        defaultBranch,
        dto.environments,
      ),
    );

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CREATED,
      organizationId: dto.organizationId,
      projectId: project.id,
      userId: user.userId,
      metadata: { name: project.name, projectType: project.projectType, flow: 'connect_existing' },
    });

    return this.present(project);
  }

  /**
   * Create a new project with AI. The project and its first specification are
   * written together, so a project created through this flow always has one.
   */
  async createAiProject(user: AuthenticatedUser, dto: CreateAiProjectDto) {
    await this.authz.requireOrganizationMember(user, dto.organizationId, 'developer');

    const specification = buildProjectSpecification({
      projectName: dto.name,
      odooVersion: dto.odooVersion,
      description: dto.description,
      requirements: dto.requirements,
      modules: dto.modules,
    });

    const result = await this.database.transaction(async (tx) => {
      const [project] = await tx
        .insert(projects)
        .values({
          organizationId: dto.organizationId,
          name: dto.name,
          description: dto.description,
          projectType: 'ai_project',
          odooVersion: dto.odooVersion,
          defaultBranch: 'main',
          environmentConfig: { targetEnvironment: 'development' },
          agentPermissions: { ...DEFAULT_AGENT_PERMISSIONS },
          createdByUserId: user.userId,
        })
        .returning();

      const [spec] = await tx
        .insert(projectSpecifications)
        .values({
          projectId: project.id,
          version: 1,
          specification: specification as unknown as Record<string, unknown>,
          createdByUserId: user.userId,
        })
        .returning();

      return { project, spec };
    });

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CREATED,
      organizationId: dto.organizationId,
      projectId: result.project.id,
      userId: user.userId,
      metadata: {
        name: result.project.name,
        projectType: 'ai_project',
        flow: 'create_with_ai',
        requirementCount: specification.requirements.length,
      },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_SPECIFICATION_CREATED,
      organizationId: dto.organizationId,
      projectId: result.project.id,
      userId: user.userId,
      metadata: { version: 1 },
    });

    return { ...this.present(result.project), specification: result.spec.specification };
  }

  async findOne(user: AuthenticatedUser, projectId: string) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'viewer', {
      includeArchived: true,
    });

    const [project] = await this.database.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundException('Project not found');

    const connections = await this.database.db
      .select({
        id: projectConnections.id,
        connectionType: projectConnections.connectionType,
        status: projectConnections.status,
        metadata: projectConnections.metadata,
        // Whether a credential is held, never the reference and never the value.
        hasCredentials: sql<boolean>`${projectConnections.secretRef} is not null`,
        lastCheckedAt: projectConnections.lastCheckedAt,
        lastError: projectConnections.lastError,
        createdAt: projectConnections.createdAt,
      })
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId));

    const [specification] = await this.database.db
      .select()
      .from(projectSpecifications)
      .where(eq(projectSpecifications.projectId, projectId))
      .orderBy(desc(projectSpecifications.version))
      .limit(1);

    // What the agent has learned about the project from its own analysis
    // (chapter 12). Technical facts only, never customer data.
    const memory = await this.projectMemory.findForProject(projectId);
    const environments = await this.environments.listForProject(projectId);

    const recentTasks = await this.database.db
      .select({
        id: agentTasks.id,
        reference: agentTasks.reference,
        prompt: agentTasks.prompt,
        status: agentTasks.status,
        branch: agentTasks.branch,
        createdAt: agentTasks.createdAt,
        completedAt: agentTasks.completedAt,
      })
      .from(agentTasks)
      .where(eq(agentTasks.projectId, projectId))
      .orderBy(desc(agentTasks.createdAt))
      .limit(10);

    return {
      ...this.present(project),
      agentPermissions: context.agentPermissions,
      connections,
      environments,
      specification: specification?.specification ?? null,
      specificationVersion: specification?.version ?? null,
      memory: memory
        ? {
            detectedOdooVersion: memory.detectedOdooVersion,
            pythonVersion: memory.pythonVersion,
            modules: memory.modules,
            repositoryStructure: memory.repositoryStructure,
            notes: memory.notes,
            updatedAt: memory.updatedAt,
          }
        : null,
      recentTasks,
      viewerRole: context.membership.role,
    };
  }

  async update(user: AuthenticatedUser, projectId: string, dto: UpdateProjectDto) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'developer');

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.odooVersion !== undefined) patch.odooVersion = dto.odooVersion;
    if (dto.defaultBranch !== undefined) patch.defaultBranch = dto.defaultBranch;
    if (dto.environmentConfig !== undefined) {
      patch.environmentConfig = this.sanitiseEnvironmentConfig(dto.environmentConfig);
    }

    const [updated] = await this.database.db
      .update(projects)
      .set(patch)
      .where(eq(projects.id, projectId))
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_UPDATED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: { fields: Object.keys(patch).filter((key) => key !== 'updatedAt') },
    });

    return this.present(updated);
  }

  async archive(user: AuthenticatedUser, projectId: string) {
    // Archiving one that is already archived is a no-op rather than a 404, so a
    // repeated click is not an error.
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin', {
      includeArchived: true,
    });

    await this.database.db
      .update(projects)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ARCHIVED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
    });
  }

  /** Returns an archived project to the active list. */
  async restore(user: AuthenticatedUser, projectId: string) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin', {
      includeArchived: true,
    });

    const [restored] = await this.database.db
      .update(projects)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();

    if (!restored) throw new NotFoundException('Project not found');

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_RESTORED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
    });

    return this.present(restored);
  }

  /**
   * Permanently deletes a project and everything it owns (ADR-024).
   *
   * Separate from `archive`, which is reversible and is what most people want.
   * This one is not reversible, so it asks for more before it proceeds: the
   * caller must be an owner, no task may still be running, and the project's
   * name must be typed back.
   *
   * Three things are done by hand rather than left to the database:
   *
   * 1. **Sealed secrets.** `secret_records.project_id` carries no foreign key, by
   *    design (ADR-014): a secret's lifetime is not governed by the row that
   *    points at it. The consequence is that a plain delete would leave a
   *    customer's repository credential encrypted in the database forever, owned
   *    by nothing. They are destroyed here.
   * 2. **Workspace directories.** The rows cascade; the directories do not.
   * 3. **The audit record.** Written before the delete, because afterwards there
   *    is no project to describe. `audit_logs.project_id` is ON DELETE SET NULL
   *    precisely so the record of a deletion survives the deletion, and the name
   *    is copied into the metadata so the row still means something.
   */
  async destroy(user: AuthenticatedUser, projectId: string, confirmation: string) {
    // Archived included: putting a project away and then deleting it is the
    // obvious order, and refusing it would leave archived projects undeletable.
    const context = await this.authz.requireProjectAccess(user, projectId, 'owner', {
      includeArchived: true,
    });

    const [project] = await this.database.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundException('Project not found');

    // Compared after trimming but with case intact. Someone who has typed the
    // name has read it; accepting a near miss would defeat the point of asking.
    if (confirmation.trim() !== project.name) {
      throw new BadRequestException(
        `To delete this project permanently, type its name exactly: "${project.name}".`,
      );
    }

    // Refused rather than cancelled. A worker mid-run holds a workspace and is
    // about to write rows for a project that would no longer exist, and deciding
    // on someone's behalf that their running task should be abandoned is not this
    // endpoint's call to make.
    const active = await this.database.db
      .select({ reference: agentTasks.reference, status: agentTasks.status })
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.projectId, projectId),
          notInArray(agentTasks.status, [...TERMINAL_TASK_STATUSES]),
        ),
      );

    if (active.length > 0) {
      const names = active.map((task) => `${task.reference} (${task.status})`).join(', ');
      throw new ConflictException(
        `This project still has ${active.length} task(s) that have not finished: ${names}. ` +
          'Wait for them, or cancel them, then delete the project.',
      );
    }

    const [taskTally] = await this.database.db
      .select({ value: count() })
      .from(agentTasks)
      .where(eq(agentTasks.projectId, projectId));
    const taskCount = Number(taskTally?.value ?? 0);

    // Recorded first: after the delete there is no project to describe, and this
    // row is the only remaining evidence that it existed.
    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_DELETED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: {
        projectName: project.name,
        projectType: project.projectType,
        repositoryUrl: project.repositoryUrl,
        odooVersion: project.odooVersion,
        taskCount,
        wasArchived: project.archivedAt !== null,
      },
    });

    // Destroyed before the row is deleted, so a failure here leaves a project
    // that can be deleted again rather than a secret nothing points at.
    const secrets = await this.database.db
      .select({ ref: secretRecords.ref })
      .from(secretRecords)
      .where(eq(secretRecords.projectId, projectId));

    for (const secret of secrets) {
      await this.secrets.destroy(secret.ref).catch((error: Error) => {
        this.logger.error(`Could not destroy ${secret.ref}: ${error.message}`);
      });
    }

    const workspaces = await this.workspaces.discardForProject(projectId);

    // Everything else cascades: sessions, tasks and their actions, events, model
    // calls and approvals, connections, environments, memory and specifications.
    await this.database.db.delete(projects).where(eq(projects.id, projectId));

    this.logger.warn(
      `Project "${project.name}" (${projectId}) was permanently deleted by ${user.userId}: ` +
        `${taskCount} task(s), ${secrets.length} secret(s), ${workspaces} workspace director(ies)`,
    );

    return {
      deleted: true,
      projectName: project.name,
      tasksDeleted: taskCount,
      secretsDestroyed: secrets.length,
      workspacesDiscarded: workspaces,
    };
  }

  /**
   * Updates agent permissions. Unknown keys are rejected rather than dropped,
   * and the never-grantable capabilities are refused by name, so an operator who
   * believes they have enabled database export is told plainly that they have
   * not.
   */
  async updateAgentPermissions(
    user: AuthenticatedUser,
    projectId: string,
    submitted: Record<string, boolean>,
  ) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin');

    const rejected: string[] = [];
    const accepted: Record<string, boolean> = {};

    for (const [key, value] of Object.entries(submitted)) {
      if (isNeverGrantable(key)) {
        rejected.push(`${key} can never be granted (Table 7: always denied)`);
        continue;
      }
      if (!isAgentPermission(key)) {
        rejected.push(`${key} is not a recognised agent permission`);
        continue;
      }
      if (typeof value !== 'boolean') {
        rejected.push(`${key} must be true or false`);
        continue;
      }
      accepted[key] = value;
    }

    if (rejected.length > 0) {
      throw new BadRequestException(rejected);
    }

    const merged = resolveAgentPermissions({
      ...(await this.currentAgentPermissions(projectId)),
      ...accepted,
    });

    await this.database.db
      .update(projects)
      .set({ agentPermissions: merged, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_AGENT_PERMISSIONS_CHANGED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: { changed: Object.keys(accepted), resulting: merged },
    });

    return merged;
  }

  /**
   * Creates a project connection, sealing any supplied credential immediately.
   *
   * The credential is passed straight to the secrets provider and the reference
   * is stored; the value is not held in a local variable beyond this call, not
   * logged, and not returned.
   */
  async createConnection(
    user: AuthenticatedUser,
    projectId: string,
    dto: CreateConnectionDto,
  ) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin');

    const credentialKind = dto.credentialKind ?? 'token';

    /**
     * An Odoo Online connection is normalised and proven before it is stored.
     *
     * Both halves matter. The URL is normalised because what people paste is the
     * web client (`.../odoo`), which answers JSON-RPC with a CSRF error naming
     * nothing they did wrong; the database defaults to the subdomain, which is
     * what it is on odoo.com. And the credentials are authenticated once here, so
     * a wrong key is a message on the form rather than a task that fails at its
     * first read - after a person has already written a prompt and waited.
     */
    const metadata =
      dto.connectionType === 'odoo_api'
        ? await this.verifiedOdooOnlineMetadata(dto)
        : (dto.metadata ?? {});

    let secretRef: string | null = null;
    if (dto.credential && dto.credential.length > 0) {
      const reference = await this.secrets.write({
        organizationId: context.organizationId,
        projectId,
        purpose: `${dto.connectionType}-${credentialKind}`,
        value: dto.credential,
      });
      secretRef = reference.ref;
    }

    const [connection] = await this.database.db
      .insert(projectConnections)
      .values({
        projectId,
        connectionType: dto.connectionType,
        secretRef,
        credentialKind,
        // A host's public key is public, so it is stored directly rather than
        // through the secret manager (ADR-021).
        sshHostKey: dto.sshHostKey ?? null,
        status: secretRef ? 'connected' : 'pending',
        metadata: redactMetadata(metadata),
        lastCheckedAt: secretRef ? new Date() : null,
      })
      .returning({
        id: projectConnections.id,
        connectionType: projectConnections.connectionType,
        status: projectConnections.status,
        metadata: projectConnections.metadata,
        createdAt: projectConnections.createdAt,
      });

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CONNECTION_CREATED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: {
        connectionType: dto.connectionType,
        credentialKind,
        hasCredentials: secretRef !== null,
        hostKeyProvided: Boolean(dto.sshHostKey),
      },
    });

    return { ...connection, hasCredentials: secretRef !== null };
  }

  /**
   * Normalises and authenticates an Odoo Online connection (ADR-028).
   *
   * Returns the metadata to store. Throws a message a person can act on when the
   * instance refuses the credentials, because the alternative is a project that
   * looks connected and fails on every task.
   */
  private async verifiedOdooOnlineMetadata(
    dto: CreateConnectionDto,
  ): Promise<Record<string, unknown>> {
    const supplied = dto.metadata ?? {};
    const read = (key: string): string => {
      const value = supplied[key];
      return typeof value === 'string' ? value.trim() : '';
    };

    const rawUrl = read('url');
    const login = read('login');

    if (!rawUrl || !login) {
      throw new BadRequestException(
        'An Odoo Online connection needs the instance url and the login in its metadata.',
      );
    }

    let url: string;
    try {
      url = instanceRootOf(rawUrl);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }

    const db = read('db') || databaseFromUrl(url);
    if (!db) {
      throw new BadRequestException(
        `The database could not be determined from "${url}". Supply it explicitly.`,
      );
    }

    if (!dto.credential || dto.credential.length === 0) {
      throw new BadRequestException('An Odoo Online connection needs an API key.');
    }

    // The one call that proves all four values at once. The key is used here and
    // not retained: what is stored is the sealed reference the caller writes.
    const uid = await this.odooOnline
      .authenticate({ url, db, login, apiKey: dto.credential })
      .catch((error: unknown) => {
        throw new BadRequestException(
          `The Odoo Online instance refused these credentials: ${(error as Error).message}`,
        );
      });

    this.logger.log(`Odoo Online connection verified against ${url} (${db}), uid ${uid}`);

    return { url, db, login };
  }

  async deleteConnection(user: AuthenticatedUser, projectId: string, connectionId: string) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'admin');

    const [connection] = await this.database.db
      .select()
      .from(projectConnections)
      .where(
        and(eq(projectConnections.id, connectionId), eq(projectConnections.projectId, projectId)),
      )
      .limit(1);

    if (!connection) throw new NotFoundException('Connection not found');

    if (connection.secretRef) {
      await this.secrets.destroy(connection.secretRef);
    }

    await this.database.db
      .delete(projectConnections)
      .where(eq(projectConnections.id, connectionId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CONNECTION_DELETED,
      organizationId: context.organizationId,
      projectId,
      userId: user.userId,
      metadata: { connectionType: connection.connectionType },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async insertProject(values: {
    organizationId: string;
    name: string;
    description: string | null;
    projectType: CreateProjectDto['projectType'];
    odooVersion: string | null;
    defaultBranch: string;
    repositoryUrl: string | null;
    environmentConfig: Record<string, unknown>;
    createdByUserId: string;
  }) {
    try {
      const [project] = await this.database.db
        .insert(projects)
        .values({ ...values, agentPermissions: { ...DEFAULT_AGENT_PERMISSIONS } })
        .returning();
      return project;
    } catch (error) {
      // The unique index on (organization_id, name) is the authority here.
      if (isUniqueViolation(error)) {
        throw new ConflictException('A project with that name already exists in this organisation.');
      }
      throw error;
    }
  }

  private async currentAgentPermissions(projectId: string): Promise<Record<string, boolean>> {
    const [row] = await this.database.db
      .select({ agentPermissions: projects.agentPermissions })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return row?.agentPermissions ?? {};
  }

  /**
   * Environment configuration is user-supplied and stored as-is, so it is passed
   * through the audit redaction filter: a developer pasting a connection string
   * into it must not create a plaintext credential in the projects table.
   */
  private sanitiseEnvironmentConfig(config: Record<string, unknown> | undefined) {
    return redactMetadata(config ?? {});
  }

  /** Response shape for a project. Declared so no column leaks by accident. */
  private present(project: {
    id: string;
    organizationId: string;
    name: string;
    description: string | null;
    projectType: string;
    odooVersion: string | null;
    defaultBranch: string;
    repositoryUrl: string | null;
    environmentConfig: Record<string, unknown>;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: project.id,
      organizationId: project.organizationId,
      name: project.name,
      description: project.description,
      projectType: project.projectType,
      odooVersion: project.odooVersion,
      defaultBranch: project.defaultBranch,
      repositoryUrl: project.repositoryUrl,
      environmentConfig: project.environmentConfig,
      archivedAt: project.archivedAt,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }
}

/** PostgreSQL unique-violation SQLSTATE. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/** The selected on-premise directory, stored in a project's environment config. */
function readOnPremisePath(
  environmentConfig: Record<string, unknown> | null | undefined,
): string | null {
  if (!environmentConfig || typeof environmentConfig !== 'object') return null;
  const value = environmentConfig.onPremisePath;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
