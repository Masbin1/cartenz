import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { and, count, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import {
  agentTasks,
  projectAccessRequests,
  projectConnections,
  projectEnvironments,
  projectMembers,
  projectSpecifications,
  projects,
  secretRecords,
} from '../../core/database/schema';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { decideProjectAccess } from '../../core/authz/project-access';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import {
  DEFAULT_AGENT_PERMISSIONS,
  isAgentPermission,
  isNeverGrantable,
  resolveAgentPermissions,
} from '../../core/authz/agent-permissions';
import {
  REPOSITORY_BACKED_PROJECT_TYPES,
  DEFAULT_ODOO_EDITION,
  GIT_CONNECTION_TYPES,
  type CredentialKind,
  type GitTransport,
  type OdooEdition,
  type ProjectProvisioningStatus,
  type ProjectType,
  type UserRegion,
  USER_REGIONS,
} from '../../core/enums';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { redactMetadata } from '../../core/audit/redact';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { buildProjectSpecification } from './project-specification';
import { resolveSelectionOrThrow } from './module-selection-sanitiser';
import { effectiveRepositoryUrl, applyTransportToUrl, transportOfUrl } from './repository-url';
import {
  buildProvisionedAddonFiles,
  buildScaffoldFiles,
  deriveDirectoryName,
  isValidDirectoryName,
  type RunnableConfig,
} from './odoo-scaffold';
import { ProjectMemoryService } from '../../agent/analysis/project-memory.service';
import {
  DEFAULT_SCAFFOLD_ENVIRONMENTS,
  ProjectEnvironmentsService,
} from './project-environments.service';
import { OdooSettingsService } from '../settings/odoo-settings.service';
import { OdooVersionsService } from '../settings/odoo-versions.service';
import { GitCredentialsService } from '../settings/git-credentials.service';
import { ProjectProvisioningService } from './project-provisioning.service';
import { ProjectProvisioningQueue } from './project-provisioning.queue';
import type {
  ProjectRestartJobData,
  SelectiveProvisionJobData,
} from './project-provisioning.queue';
import { ProjectDeploymentService, technicalNameFromOnPremisePath } from './project-deployment.service';
import { ProjectMergeService } from './project-merge.service';
import {
  GitHubRepositoryService,
  type GitHubConnectionResult,
} from './github-repository.service';
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
  UpdateProjectGitAccessDto,
} from './dto/project.dto';

/**
 * Provisioning outcome carried out of the two scaffold paths (ADR-039,
 * ADR-040), and into the project row insert. `null` for the scaffold-only
 * path (provisioning disabled on this deployment): a project scaffolded that
 * way has no live instance, and every field below stays at its column default.
 */
interface ScaffoldProvisioningInfo {
  readonly status: ProjectProvisioningStatus;
  readonly port: number | null;
  readonly url: string | null;
  readonly databaseName: string | null;
  readonly masterPasswordRef: string | null;
  readonly https: { readonly status: 'none' | 'pending' | 'issued' | 'failed'; readonly error: string | null };
}

/**
 * Projects, connections and specifications.
 *
 * Every method resolves authorisation first (ADR-044). What a caller may open is
 * decided in one place; what they may see is decided here, by region.
 */
/**
 * A project row as the list returns it, with the fields a locked row withholds.
 *
 * Exported and pure so the redaction can be asserted without a database - it is
 * the part of this feature most likely to be quietly undone by someone adding a
 * field to the select.
 */
export function redactLockedProject<
  T extends {
    description: string | null;
    repositoryUrl: string | null;
    taskCount: number;
    openTaskCount: number;
  },
>(row: T, hasAccess: boolean) {
  if (hasAccess) {
    return { ...row, hasAccess: true };
  }

  return {
    ...row,
    description: null,
    repositoryUrl: null,
    taskCount: null,
    openTaskCount: null,
    hasAccess: false,
  };
}

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
    private readonly odooSettings: OdooSettingsService,
    private readonly odooVersions: OdooVersionsService,
    private readonly gitCredentials: GitCredentialsService,
    private readonly odooOnline: OdooOnlineClient,
    private readonly provisioning: ProjectProvisioningService,
    private readonly provisioningQueue: ProjectProvisioningQueue,
    private readonly githubRepositories: GitHubRepositoryService,
    private readonly deployment: ProjectDeploymentService,
    private readonly merge: ProjectMergeService,
  ) {}
  /**
   * Brings a project's provisioned instance up to date with its repository
   * (ADR-049).
   *
   * Admin-gated, and deliberately so: this changes what the customer's running
   * Odoo is serving, which is the same class of action as provisioning was.
   * `abortOnFailure` is not offered — the script resets to the branch tip, and a
   * half-applied deploy is the state the instance is already in, so a failed
   * pull reports the commit it is still on rather than pretending otherwise.
   */
  async pull(user: AuthenticatedUser, projectId: string) {
    await this.authz.requireProjectAccess(user, projectId, { requireAdmin: true });

    return this.deployment.pull(projectId, user.userId);
  }

  /** Whether this deployment can pull at all, for the portal to hide the action. */
  get deploymentAvailable(): boolean {
    return this.deployment.available;
  }

  /**
   * ADR-057 §1: promote the project's `staging` branch onto `main` on GitHub.
   *
   * Admin-gated for the same reason `pull` is, and one step further: this is the
   * one operation in the platform that writes to `main`, so it changes what the
   * reviewed state of the project *is*, not merely what one instance serves.
   */
  async mergeToMain(user: AuthenticatedUser, projectId: string) {
    await this.authz.requireProjectAccess(user, projectId, { requireAdmin: true });

    return this.merge.merge(projectId, user.userId);
  }

  /** Whether this deployment can merge to main at all (GIT_PUSH_ENABLED). */
  get mergeAvailable(): boolean {
    return this.merge.available;
  }

  /**
   * ADR-057 §2/§3: bring the project's instance onto a branch's tip and serve
   * it — pull, `-u all`, restart the unit.
   *
   * Queued, not inline: the upgrade can run past `PROCESS_MAX_TIMEOUT_MS`, so the
   * request records `restartStatus: 'pending'` on the project row and returns a
   * job reference. The portal polls the row, the same shape selective
   * provisioning already uses.
   */
  async restart(user: AuthenticatedUser, projectId: string, branch: string) {
    await this.authz.requireProjectAccess(user, projectId, { requireAdmin: true });

    const [project] = await this.database.db
      .select({
        name: projects.name,
        repositoryUrl: projects.repositoryUrl,
        environmentConfig: projects.environmentConfig,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      throw new NotFoundException('Project not found.');
    }

    if (!this.deployment.restartAvailable) {
      // Refused before anything is recorded as pending: a restart action offered
      // on a deployment without the script would otherwise leave a row stuck on
      // 'pending' for a job that can never run.
      throw new BadRequestException(
        'Restarting is not configured on this deployment. PROJECT_RESTART_SCRIPT is empty, or ' +
          'PROJECT_PROVISIONING_ENABLED is false.',
      );
    }

    // ADR-041's lesson: a project the platform created a repository for holds
    // it as a connection, and its own column stays null on purpose. Reading
    // only the column refused restart on exactly the projects created through
    // the portal — the common case, not the exception.
    const connections = await this.database.db
      .select({
        connectionType: projectConnections.connectionType,
        metadata: projectConnections.metadata,
      })
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId));
    const repositoryUrl = effectiveRepositoryUrl(project.repositoryUrl, connections);

    if (!repositoryUrl) {
      throw new BadRequestException(
        'This project has no repository, so there is nothing to restart onto. Connect one first.',
      );
    }

    const technicalName = technicalNameFromOnPremisePath(
      project.environmentConfig,
      this.config.provisioning.projectsDir,
    );

    if (!technicalName) {
      throw new BadRequestException(
        'This project is not provisioned on this host, so there is no instance to restart. ' +
          'Provision it first.',
      );
    }

    // Recorded before the job is queued: the portal's first poll must see
    // 'pending', not the previous attempt's outcome, or a watcher sees a stale
    // "restarted" and believes the new one already finished.
    await this.database.db
      .update(projects)
      .set({ restartStatus: 'pending', restartError: null, restartBranch: branch })
      .where(eq(projects.id, projectId));

    await this.provisioningQueue.enqueueRestart({
      projectId,
      technicalName,
      repositoryUrl,
      branch,
      userId: user.userId,
    });

    return { queued: true, technicalName, branch };
  }

  /** Whether this deployment can restart at all, for the portal to hide the action. */
  get restartAvailable(): boolean {
    return this.deployment.restartAvailable;
  }

  /**
   * ADR-057 §2: the worker's half of a restart.
   *
   * Never throws: there is no request to fail. Every outcome is written onto the
   * project row, which is what the portal polls — the same contract
   * `completeSelectiveProvisioning` states for its own worker-side half.
   */
  async completeRestart(data: ProjectRestartJobData): Promise<void> {
    const result = await this.deployment.restart(
      data.projectId,
      data.technicalName,
      data.repositoryUrl,
      data.branch,
      data.userId,
    );

    await this.recordSelectiveOutcome(data.projectId, {
      restartStatus: result.ok ? 'restarted' : 'failed',
      restartError: result.ok ? null : result.message,
      restartCommit: result.commit,
      restartBranch: result.branch,
      // Only advanced on success: on a rollback the instance is serving the
      // *previous* commit, and writing a timestamp for it would say a deploy
      // landed when none did.
      ...(result.ok ? { restartedAt: new Date() } : {}),
    });

    if (result.ok) {
      this.logger.log(
        `Restart of "${data.technicalName}" finished: ${result.branch} @ ${result.commit ?? 'unknown'}`,
      );
    } else {
      this.logger.error(
        `Restart of "${data.technicalName}" failed` +
          `${result.rolledBack ? ' (code rolled back)' : ''}: ${result.message}`,
      );
    }
  }

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
  private async readRemoteBranches(
    repositoryUrl: string,
    credential?: { kind: CredentialKind; value: string; hostKey?: string | null } | null,
  ): Promise<readonly string[]> {
    this.assertRepositoryUrl(repositoryUrl);

    try {
      return await this.git.listRemoteBranches(repositoryUrl, { credential: credential ?? null });
    } catch (error) {
      // A private or mistyped repository is the caller's problem to correct, not
      // a platform fault - and the portal falls back to typing a branch, so the
      // reason has to survive to the response.
      const detail = error instanceof Error ? error.message : 'the repository could not be read';
      throw new BadRequestException(`Could not read branches from that repository: ${detail}`);
    }
  }

  /**
   * Branch probe for the project-creation form, before a project exists.
   *
   * A credential supplied here is used for this one `ls-remote` and discarded:
   * nothing is stored, and the connection created later holds whatever the
   * operator saves at that point. Without it a private repository could never be
   * read before the project exists, which is the moment the form needs it.
   *
   * When no credential is supplied, a credential registered in deployment
   * settings is used (ADR-058) — a named one when the form chose it, otherwise
   * the default. That is what makes registering a key once enough: the form no
   * longer has to carry it, and a key that is never retyped is a key that cannot
   * lose its line breaks in a paste.
   */
  async remoteBranchesFor(
    user: AuthenticatedUser,
    dto: {
      repositoryUrl: string;
      credential?: string;
      credentialKind?: CredentialKind;
      sshHostKey?: string;
      credentialId?: string;
    },
  ): Promise<{ branches: readonly string[]; credentialLabel: string | null }> {
    // No project exists yet, so there is no grant to check. Any signed-in caller
    // may probe a repository URL they are about to connect.
    void user;

    if (dto.credential && dto.credential.length > 0) {
      const branches = await this.readRemoteBranches(dto.repositoryUrl, {
        kind: dto.credentialKind ?? this.inferCredentialKindFromUrl(dto.repositoryUrl),
        value: dto.credential,
        hostKey: dto.sshHostKey ?? null,
      });
      // An ad-hoc value has no label: there is no stored row to name.
      return { branches, credentialLabel: null };
    }

    const registered = await this.gitCredentials.resolveForHost({
      credentialId: dto.credentialId ?? null,
      host: this.gitCredentials.hostOf(dto.repositoryUrl),
    });

    if (!registered) {
      return { branches: await this.readRemoteBranches(dto.repositoryUrl, null), credentialLabel: null };
    }

    const branches = await this.readRemoteBranches(dto.repositoryUrl, {
      kind: registered.kind,
      value: registered.value,
      hostKey: dto.sshHostKey ?? null,
    });

    // The label is returned so the form can say *which* credential read the
    // branches — an operator seeing a list needs to know what produced it.
    const label = registered.credentialId
      ? (await this.gitCredentials.list()).find((row) => row.id === registered.credentialId)?.label ??
        null
      : null;

    return { branches, credentialLabel: label };
  }

  /**
   * A project's git transport and credential, as its settings form shows them
   * (ADR-059).
   *
   * Deliberately reports both the stored choice and the *effective* one. A
   * project with `auto` still uses a concrete transport, and a form that showed
   * only "auto" would leave the operator unable to tell whether the push about
   * to run will present a key or a token — which is the question this setting
   * exists to answer.
   */
  async gitAccess(user: AuthenticatedUser, projectId: string) {
    await this.authz.requireProjectAccess(user, projectId, { includeArchived: true });

    const facts = await this.gitAccessFacts(projectId);
    const credentials = await this.gitCredentials.list();

    return {
      repositoryUrl: facts.repositoryUrl,
      urlTransport: facts.urlTransport,
      gitTransport: facts.gitTransport,
      gitCredentialId: facts.gitCredentialId,
      gitUsername: facts.gitUsername,
      /** What the next clone or push will actually do, once `auto` is resolved. */
      effectiveTransport: facts.effectiveTransport,
      /** Where the credential will come from, in the order it is resolved. */
      effectiveCredentialSource: facts.credentialSource,
      effectiveCredentialId: facts.effectiveCredentialId,
      effectiveCredentialLabel: facts.effectiveCredentialLabel,
      effectiveCredentialKind: facts.effectiveCredentialKind,
      /**
       * True when the credential and the transport cannot work together — the
       * failure that produced `could not read Username for 'https://github.com'`
       * on a project whose only credential was an SSH key.
       */
      transportMismatch: facts.transportMismatch,
      /** The deployment default, so the form can say what "use the default" means. */
      defaultCredentialLabel: credentials.find((row) => row.isDefault)?.label ?? null,
      availableCredentials: credentials.map((row) => ({
        id: row.id,
        label: row.label,
        credentialKind: row.credentialKind,
        hosts: row.hosts,
        isDefault: row.isDefault,
        enabled: row.enabled,
      })),
      /** Whether this project's remote can be reached at all. */
      hasRepository: facts.repositoryUrl !== null,
    };
  }

  /**
   * Sets a project's transport and credential (ADR-059).
   *
   * The URL moves with the transport, in the same write: a saved `https` on a
   * remote still written as `git@github.com:...` would leave the clone using one
   * scheme and the operator believing another, and the mismatch is invisible
   * until a push fails.
   *
   * A credential of the wrong kind for the chosen transport is refused outright
   * rather than stored with a warning. That combination *is* the bug this
   * setting exists to fix, and a warning on a settings page is read once and
   * then never again — the operator would find out at the next failed push,
   * which is where they found out before.
   */
  async updateGitAccess(
    user: AuthenticatedUser,
    projectId: string,
    dto: UpdateProjectGitAccessDto,
  ) {
    // A remote's credential is an admin's call, at the same rank as the agent
    // permissions beside it (ADR-055): it decides what a task may reach.
    await this.authz.requireProjectAccess(user, projectId, { requireAdmin: true });

    const facts = await this.gitAccessFacts(projectId);

    const transport = dto.gitTransport ?? facts.gitTransport;
    const credentialId =
      dto.gitCredentialId !== undefined ? dto.gitCredentialId : facts.gitCredentialId;
    const username = dto.gitUsername !== undefined ? dto.gitUsername : facts.gitUsername;

    if (credentialId) {
      const named = (await this.gitCredentials.list()).find((row) => row.id === credentialId);
      if (!named) {
        throw new BadRequestException('That git credential no longer exists.');
      }
      if (!named.enabled) {
        throw new BadRequestException(
          `The credential "${named.label}" is disabled, so it cannot be used. Enable it in ` +
            'Settings, or choose another.',
        );
      }

      // Only checked against an explicit transport. Under `auto` the URL decides,
      // and refusing there would forbid the one case a person cannot avoid: a
      // project whose credential is set before its remote is.
      const needed: CredentialKind | null =
        transport === 'ssh' ? 'ssh_key' : transport === 'https' ? 'token' : null;
      if (needed && named.credentialKind !== needed) {
        throw new BadRequestException(
          `The ${transport.toUpperCase()} transport authenticates with a ` +
            `${needed === 'ssh_key' ? 'private key' : 'token'}, but "${named.label}" is a ` +
            `${named.credentialKind === 'ssh_key' ? 'private key' : 'token'}. Register a ` +
            `${needed === 'ssh_key' ? 'private key' : 'personal access token'} in Settings → Git ` +
            `credentials, or choose the ${needed === 'ssh_key' ? 'HTTPS' : 'SSH'} transport.`,
        );
      }
    }

    const patch: Record<string, unknown> = {
      gitTransport: transport,
      gitCredentialId: credentialId,
      gitUsername: username,
      updatedAt: new Date(),
    };

    /**
     * The URL is rewritten only when the project actually carries one on its own
     * row. A project whose URL comes from a connection (ADR-041) has none to
     * rewrite: that URL belongs to the connection, and editing it here would
     * change something this screen does not own.
     */
    if (facts.ownRepositoryUrl) {
      patch.repositoryUrl = applyTransportToUrl(facts.ownRepositoryUrl, transport);
    }

    await this.database.db.update(projects).set(patch).where(eq(projects.id, projectId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_UPDATED,
      projectId,
      userId: user.userId,
      metadata: {
        fields: ['gitTransport', 'gitCredentialId', 'gitUsername'],
        gitTransport: transport,
        // An id, never a value: enough for the audit log to answer "which
        // projects were moved to SSH" without carrying any secret material.
        gitCredentialId: credentialId,
      },
    });

    return this.gitAccess(user, projectId);
  }

  /**
   * Everything the git-access reads and writes need, in one place.
   *
   * Resolution order for the credential (ADR-059), which mirrors what the task
   * snapshot does at clone time so the form cannot describe a push that will not
   * happen:
   *
   *  1. this project's own choice, when it has one;
   *  2. the project's first git connection, which is how every project created
   *     before this setting existed holds its credential;
   *  3. the deployment default for the remote's host (ADR-058).
   */
  private async gitAccessFacts(projectId: string) {
    const [project] = await this.database.db
      .select({
        repositoryUrl: projects.repositoryUrl,
        gitTransport: projects.gitTransport,
        gitCredentialId: projects.gitCredentialId,
        gitUsername: projects.gitUsername,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundException('Project not found');

    const connections = await this.database.db
      .select({
        connectionType: projectConnections.connectionType,
        secretRef: projectConnections.secretRef,
        credentialKind: projectConnections.credentialKind,
        metadata: projectConnections.metadata,
      })
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId))
      .orderBy(projectConnections.createdAt);

    const repositoryUrl = effectiveRepositoryUrl(project.repositoryUrl, connections);
    const urlTransport = repositoryUrl ? transportOfUrl(repositoryUrl) : null;
    const declared = project.gitTransport as GitTransport;
    const effectiveTransport = declared !== 'auto' ? declared : urlTransport;

    const credentials = await this.gitCredentials.list();
    const chosen = project.gitCredentialId
      ? credentials.find((row) => row.id === project.gitCredentialId) ?? null
      : null;

    const connection = connections.find(
      (row) =>
        row.secretRef !== null &&
        (GIT_CONNECTION_TYPES as readonly string[]).includes(row.connectionType),
    );

    const defaultForTransport =
      effectiveTransport === 'ssh'
        ? credentials.find((row) => row.isDefault && row.credentialKind === 'ssh_key')
        : effectiveTransport === 'https'
          ? credentials.find((row) => row.isDefault && row.credentialKind === 'token')
          : credentials.find((row) => row.isDefault);

    /**
     * Named so the form can distinguish the three cases: this project chose, the
     * deployment default applies, or nothing does. `'none'` is the one that
     * predicts a failed push.
     */
    const source: 'project' | 'connection' | 'deployment_default' | 'none' = chosen
      ? 'project'
      : connection?.secretRef
        ? 'connection'
        : defaultForTransport
          ? 'deployment_default'
          : 'none';
    const effectiveCredentialKind = chosen
      ? chosen.credentialKind
      : connection?.secretRef
        ? (connection.credentialKind as CredentialKind)
        : (defaultForTransport?.credentialKind ?? null);

    /**
     * A mismatch is only knowable when both halves are. An HTTPS remote with no
     * credential at all is not a mismatch — it is a project nobody has given a
     * token yet, which the push reports on its own terms.
     */
    const needed: CredentialKind | null =
      effectiveTransport === 'ssh' ? 'ssh_key' : effectiveTransport === 'https' ? 'token' : null;
    const transportMismatch =
      needed !== null && effectiveCredentialKind !== null && effectiveCredentialKind !== needed;

    return {
      ownRepositoryUrl: project.repositoryUrl,
      repositoryUrl,
      urlTransport,
      gitTransport: declared,
      gitCredentialId: project.gitCredentialId,
      gitUsername: project.gitUsername,
      effectiveTransport,
      credentialSource: source,
      /**
       * Only a project-level choice names a registered credential by id: a
       * connection's secret is not itself a row in the registry, and neither is
       * the deployment default until it is looked up by label below.
       */
      effectiveCredentialId: chosen?.id ?? null,
      effectiveCredentialLabel:
        chosen?.label ??
        (connection?.secretRef ? 'This project\'s stored connection' : null) ??
        defaultForTransport?.label ??
        null,
      effectiveCredentialKind,
      transportMismatch,
    };
  }

  /**
   * The credential kind a URL implies, for a caller that supplied a value but no
   * kind. Mirrors `inferCredentialKind` below, which does the same for a
   * connection's metadata.
   */
  private inferCredentialKindFromUrl(repositoryUrl: string): CredentialKind {
    try {
      return assertSafeRemoteUrl(repositoryUrl, { allowLocal: false }).scheme === 'ssh'
        ? 'ssh_key'
        : 'token';
    } catch {
      return 'token';
    }
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
  ): Promise<{ root: string | null; folders: OnPremiseFolder[] }> {
    // The on-premise root is a host path, not a per-project value: reading the
    // directory listing tells the caller what is installed on this server, so it
    // is admin-only.
    await this.authz.requireAdmin(user);
    const root = this.config.onPremise.root;
    if (!root) return { root: null, folders: [] };
    return { root, folders: await listOnPremiseFolders(root) };
  }

  /**
   * Branch probe for a project that already exists.
   *
   * Repository-backed projects read the remote. An on-premise project reads the
   * remote too once one is recorded (ADR-049) — that is the list the Deploy
   * action can actually fetch — and falls back to the branches of its local
   * working copy only when no repository was given (ADR-026), because then there
   * is no remote URL to probe.
   */
  async remoteBranches(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<{ branches: readonly string[] }> {
    await this.authz.requireProjectAccess(user, projectId);

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

    // ADR-041's lesson, same as pull/merge/restart: a platform-created
    // repository lives as a connection, not in the project's own column.
    const connections = await this.database.db
      .select({
        connectionType: projectConnections.connectionType,
        metadata: projectConnections.metadata,
      })
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId));
    const repositoryUrl = effectiveRepositoryUrl(project.repositoryUrl, connections);

    if (project.projectType === 'on_premise' && !repositoryUrl) {
      const path = readOnPremisePath(project.environmentConfig);
      if (!path) {
        throw new BadRequestException(
          'This on-premise project has no local directory selected.',
        );
      }
      return { branches: await this.git.listBranches(path) };
    }

    if (!repositoryUrl) {
      throw new BadRequestException('This project has no repository to read branches from.');
    }

    return { branches: await this.readRemoteBranches(repositoryUrl) };
  }

  /**
   * The project list (ADR-043, ADR-044).
   *
   * An admin sees every region. Everyone else sees their own region's projects,
   * plus any project they were granted or created in another region - a grant is
   * the one thing that crosses the boundary, which is what makes it worth asking
   * for. Locked rows are still listed: access is withheld, not existence.
   */
  async list(user: AuthenticatedUser, query: ListProjectsQueryDto) {
    const archived = query.includeArchived ? undefined : isNull(projects.archivedAt);

    /**
     * The cross-region half of the rule: a grant is the one thing that crosses
     * the boundary, and a project's creator holds an implicit grant (ADR-043).
     * Read once for the whole page rather than once per row, and skipped for an
     * admin, who sees every region anyway.
     */
    const reachableIds = user.isAdmin
      ? []
      : [
          ...(
            await this.database.db
              .select({ projectId: projectMembers.projectId })
              .from(projectMembers)
              .where(eq(projectMembers.userId, user.userId))
          ).map((row) => row.projectId),
          ...(
            await this.database.db
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.createdByUserId, user.userId))
          ).map((row) => row.id),
        ];

    const scope = user.isAdmin
      ? undefined
      : or(
          eq(projects.region, user.region),
          reachableIds.length > 0 ? inArray(projects.id, reachableIds) : undefined,
        );

    const where = and(archived, scope);

    const rows = await this.database.db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        projectType: projects.projectType,
        odooVersion: projects.odooVersion,
        defaultBranch: projects.defaultBranch,
        repositoryUrl: projects.repositoryUrl,
        archivedAt: projects.archivedAt,
        createdByUserId: projects.createdByUserId,
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

    /**
     * Every project the caller may see is listed, including the ones they
     * cannot open (ADR-043). What is withheld is access, not existence - so the
     * lookups below are read once for the whole page rather than once per row.
     */
    const projectIds = rows.map((row) => row.id);

    const grantedIds = new Set(
      projectIds.length === 0
        ? []
        : (
            await this.database.db
              .select({ projectId: projectMembers.projectId })
              .from(projectMembers)
              .where(
                and(
                  eq(projectMembers.userId, user.userId),
                  inArray(projectMembers.projectId, projectIds),
                ),
              )
          ).map((row) => row.projectId),
    );

    // Only a request that still tells the portal something is worth fetching: a
    // pending one ("awaiting approval") or a rejected one (which shows the note
    // and allows asking again). An approved one is indistinguishable from the
    // grant it produced.
    const requestStatuses = new Map<string, 'pending' | 'rejected'>(
      projectIds.length === 0
        ? []
        : (
            await this.database.db
              .select({
                projectId: projectAccessRequests.projectId,
                status: projectAccessRequests.status,
              })
              .from(projectAccessRequests)
              .where(
                and(
                  eq(projectAccessRequests.userId, user.userId),
                  inArray(projectAccessRequests.projectId, projectIds),
                  inArray(projectAccessRequests.status, ['pending', 'rejected']),
                ),
              )
              .orderBy(desc(projectAccessRequests.createdAt))
          ).map((row): [string, 'pending' | 'rejected'] => [
            row.projectId,
            row.status as 'pending' | 'rejected',
          ]),
    );

    return rows.map(({ createdByUserId, ...row }) => {
      const decision = decideProjectAccess({
        isAdmin: user.isAdmin,
        userId: user.userId,
        createdByUserId,
        hasGrant: grantedIds.has(row.id),
      });

      return {
        ...redactLockedProject(row, decision.allowed),
        accessRequestStatus: decision.allowed ? null : requestStatuses.get(row.id) ?? null,
      };
    });
  }

  /** Connect an existing project. */
  async create(user: AuthenticatedUser, dto: CreateProjectDto) {
    this.assertRegionAllowed(user, dto.region);

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
    this.environments.buildForCreation('', defaultBranch, dto.environments);

    /**
     * The project directory, created before the project row (ADR-032, ADR-033).
     *
     * On disk first because a directory that could not be created must not leave
     * a project pointing at nothing; the reverse order would need a compensating
     * delete on a path the request supplied, which is worse. The scaffold records
     * its own path in the environment configuration, which is where the workspace
     * layer reads an on-premise project's directory from.
     *
     * The recorded path is the repository root rather than `addons/`: the
     * workspace layer needs a Git repository, and the agent writes into the
     * `addons/` directory inside it.
     */
    // Enterprise unless the caller chose Community (ADR-037).
    const odooEdition: OdooEdition = dto.odooEdition ?? DEFAULT_ODOO_EDITION;

    /**
     * The environments this project gets (ADR-021, ADR-038). A scaffolded project
     * with none declared gets the Development + Staging pair; a declared set is
     * honoured. A non-scaffolded project keeps whatever it declared (possibly
     * none, which buildForCreation turns into a single Development).
     */
    const resolvedEnvironments =
      dto.environments && dto.environments.length > 0
        ? dto.environments
        : dto.scaffold
          ? DEFAULT_SCAFFOLD_ENVIRONMENTS
          : undefined;

    const scaffolded = dto.scaffold
      ? await this.scaffoldCustomAddon({
          projectName: dto.name,
          technicalName: dto.technicalName,
          projectType: dto.projectType,
          odooVersion: dto.odooVersion ?? null,
          odooEdition,
          defaultBranch,
          // A branch per environment beside the default (ADR-038).
          environmentBranches: (resolvedEnvironments ?? []).map((environment) => environment.branch),
        })
      : null;

    const project = await this.insertProject({
      region: dto.region,
      name: dto.name,
      description: dto.description ?? null,
      projectType: dto.projectType,
      odooVersion: dto.odooVersion ?? null,
      odooEdition,
      defaultBranch,
      repositoryUrl: dto.repositoryUrl ?? null,
      environmentConfig: scaffolded
        ? { ...environmentConfig, onPremisePath: scaffolded.gitRootPath }
        : environmentConfig,
      createdByUserId: user.userId,
      // ADR-050/ADR-054: the linked instance this connect points at (the
      // customer's own odoo.sh/on-premise project), recorded so a later
      // restore action can reach its database manager. Never used to create a
      // repository or a connection by itself.
      projectUrl: dto.projectUrl?.trim() || null,
      projectDatabase: dto.projectDatabase?.trim() || null,
      isOdoosh: dto.isOdoosh ?? false,
    });

    await this.database.db.insert(projectEnvironments).values(
      this.environments.buildForCreation(project.id, defaultBranch, resolvedEnvironments),
    );

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CREATED,
      projectId: project.id,
      userId: user.userId,
      metadata: { name: project.name, projectType: project.projectType, flow: 'connect_existing' },
    });

    /**
     * A scaffolded directory is a repository on this host and nowhere else, so a
     * project created this way gets the same GitHub repository a Create-with-AI
     * project does (ADR-041). A repository-backed project is left alone: its code
     * already lives in the repository it connects to.
     */
    const github = scaffolded
      ? await this.connectGitHubRepository({
          projectId: project.id,
          userId: user.userId,
          projectName: project.name,
          technicalName: scaffolded.technicalName,
          description: dto.description ?? null,
          gitRootPath: scaffolded.gitRootPath,
          defaultBranch,
          branches: (resolvedEnvironments ?? []).map((environment) => environment.branch),
        })
      : null;

    return github ? { ...this.present(project), github } : this.present(project);
  }

  /**
   * Create a new project with AI. The project and its first specification are
   * written together, so a project created through this flow always has one.
   */
  async createAiProject(user: AuthenticatedUser, dto: CreateAiProjectDto) {
    this.assertRegionAllowed(user, dto.region);

    // Enterprise unless the caller chose Community (ADR-037).
    const odooEdition: OdooEdition = dto.odooEdition ?? DEFAULT_ODOO_EDITION;

    /**
     * ADR-056. A selection is validated against this version/edition's real
     * catalog before anything is created — an unknown module name refuses the
     * whole request rather than reaching provisioning, where it would either
     * silently fail to install or (absent Task 7's sanitiser-in-provisioning
     * layer too) become a shell-command risk. `undefined` when no selection
     * was made keeps today's default (install everything) untouched.
     */
    const resolvedModules = resolveSelectionOrThrow(
      dto.modules,
      await this.odooVersions.modulesFor(dto.odooVersion, odooEdition),
    );

    const specification = buildProjectSpecification({
      projectName: dto.name,
      odooVersion: dto.odooVersion,
      description: dto.description,
      requirements: dto.requirements,
      modules: resolvedModules,
    });

    // A staging and a development line by default (ADR-038): the AI flow declares
    // no environments, so it always gets the two, and the scaffold lays down a
    // branch for each.
    const scaffoldEnvironments = DEFAULT_SCAFFOLD_ENVIRONMENTS;

    /**
     * Two entirely different paths, chosen once, at the top (ADR-039).
     *
     * With provisioning enabled, the operator's create_project /
     * create_project_enterprise scripts create the project directory — a real
     * PostgreSQL database, a systemd service and an Nginx site come with it —
     * and this platform never calls mkdir on that path itself: the scripts
     * refuse to run against a directory that already exists, so the two
     * creators cannot race for the same path. With it disabled, behaviour is
     * unchanged from before this existed: a scaffold-only directory, no live
     * instance, provisioningStatus stays 'none'.
     *
     * There is no third, partial path. Either provisioning is off, or it is on
     * and project creation succeeds only once a real instance is running and
     * its addons/ is a git repository the agent can write to — a half-result
     * (a directory but no service, or a service but no writable addons/) would
     * be a worse failure mode than refusing the whole request, because nothing
     * on this platform can tear down a systemd service or an Nginx site to
     * clean it up afterwards.
     */
    const scaffolded = this.provisioning.available
      ? await this.provisionAiProject({
          projectName: dto.name,
          odooVersion: dto.odooVersion,
          odooEdition,
          region: dto.region,
          defaultBranch: 'main',
          environmentBranches: scaffoldEnvironments.map((environment) => environment.branch),
          modules: resolvedModules,
        })
      : await this.scaffoldCustomAddon({
          projectName: dto.name,
          projectType: 'ai_project',
          odooVersion: dto.odooVersion ?? null,
          odooEdition,
          defaultBranch: 'main',
          environmentBranches: scaffoldEnvironments.map((environment) => environment.branch),
        });

    let result: { project: typeof projects.$inferSelect; spec: typeof projectSpecifications.$inferSelect };
    try {
      result = await this.database.transaction(async (tx) => {
        const [project] = await tx
          .insert(projects)
          .values({
            region: dto.region,
            name: dto.name,
            description: dto.description,
            projectType: 'ai_project',
            odooVersion: dto.odooVersion,
            odooEdition,
            defaultBranch: 'main',
            // The scaffolded directory is where on-premise execution works
            // (ADR-036). Recording it here is what turns this project's tasks
            // from plan-only into a real on-premise run — and it has to be the
            // directory that is the Git repository, which for a provisioned
            // project is its `addons/`, not the project directory (ADR-039).
            environmentConfig: {
              targetEnvironment: 'development',
              onPremisePath: scaffolded.gitRootPath,
            },
            agentPermissions: { ...DEFAULT_AGENT_PERMISSIONS },
            createdByUserId: user.userId,
            provisioningStatus: scaffolded.provisioning?.status ?? 'none',
            provisioningPort: scaffolded.provisioning?.port ?? null,
            provisioningUrl: scaffolded.provisioning?.url ?? null,
            provisionedAt: scaffolded.provisioning?.status === 'provisioned' ? new Date() : null,
            provisioningDatabaseName: scaffolded.provisioning?.databaseName ?? null,
            provisioningMasterPasswordRef: scaffolded.provisioning?.masterPasswordRef ?? null,
            httpsStatus: scaffolded.provisioning?.https.status ?? 'none',
            httpsError: scaffolded.provisioning?.https.error ?? null,
          })
          .returning();

        /**
         * The two default environments (ADR-034 for the row, ADR-038 for the
         * pair): Development and Staging, matching the branches the scaffold laid
         * down. Without an environment every task submission fails environment
         * resolution (ADR-021), so they are created in the same transaction as the
         * project rather than left to a later edit.
         */
        await tx
          .insert(projectEnvironments)
          .values(
            this.environments.buildForCreation(
              project.id,
              'main',
              scaffoldEnvironments,
            ),
          );

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
    } catch (error) {
      if (scaffolded.provisioning?.status === 'provisioned') {
        // The directory, database, systemd service and Nginx site are real and
        // now orphaned: none of them can be torn down from here, because there
        // is no destroy counterpart to create_project exposed to this platform.
        // This is loud on purpose - an operator has to clean it up on the host.
        this.logger.error(
          `Project row could not be written after "${scaffolded.technicalName}" was ` +
            `provisioned on port ${scaffolded.provisioning.port}. The Odoo instance, its ` +
            'database, systemd service and Nginx site are still running and were NOT torn ' +
            `down. An operator must clean up "${scaffolded.technicalName}" on the host by hand. ` +
            `Original error: ${(error as Error).message}`,
        );
      } else {
        // Scaffold-only path: the directory it would have pointed at is
        // orphaned. Remove it, or a retry hits the "already exists" guard.
        await rm(scaffolded.repositoryPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      throw error;
    }

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CREATED,
      projectId: result.project.id,
      userId: user.userId,
      metadata: {
        name: result.project.name,
        projectType: 'ai_project',
        flow: 'create_with_ai',
        requirementCount: specification.requirements.length,
        provisioningStatus: scaffolded.provisioning?.status ?? 'none',
        provisioningPort: scaffolded.provisioning?.port ?? null,
      },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_SPECIFICATION_CREATED,
      projectId: result.project.id,
      userId: user.userId,
      metadata: { version: 1 },
    });

    /**
     * ADR-056: a selective install is queued now, after the row exists.
     *
     * It is enqueued here rather than inside `provisionAiProject` because the
     * job payload carries `projectId`, and that id does not exist until the
     * transaction above commits. Enqueuing earlier would hand the worker an
     * empty id and a row it could never find to update.
     *
     * The GitHub step below is deliberately skipped on this path: it pushes
     * the local `addons/` repository, and on a queued provisioning there is no
     * directory yet — the worker creates it and then does the same work in
     * `completeSelectiveProvisioning` once it actually exists.
     */
    if (scaffolded.provisioning?.status === 'pending') {
      await this.provisioningQueue.enqueue({
        projectId: result.project.id,
        technicalName: scaffolded.technicalName,
        odooEdition,
        odooVersion: dto.odooVersion ?? null,
        region: dto.region,
        modules: resolvedModules ?? [],
        // The port the pending row already carries, so the worker's completion
        // update writes the port the row claims rather than a fresh allocation.
        port: scaffolded.provisioning.port as number,
      });
      this.logger.log(
        `Project "${result.project.name}" created; provisioning its ` +
          `${(resolvedModules ?? []).length} selected module(s) in the background`,
      );
      return {
        ...this.present(result.project),
        specification: result.spec.specification,
        github: null,
      };
    }

    /**
     * The repository, if this deployment creates one (ADR-041). Last, because it is
     * the only step that leaves the platform: the project, its specification and its
     * environments are already committed by this point, and a GitHub that is
     * unreachable leaves a working local project rather than a failed request.
     */
    const github = await this.connectGitHubRepository({
      projectId: result.project.id,
      userId: user.userId,
      projectName: result.project.name,
      technicalName: scaffolded.technicalName,
      description: dto.description ?? null,
      gitRootPath: scaffolded.gitRootPath,
      defaultBranch: 'main',
      branches: scaffoldEnvironments.map((environment) => environment.branch),
    });

    return {
      ...this.present(result.project),
      specification: result.spec.specification,
      github,
    };
  }

  /**
   * Gives a freshly created project a repository on GitHub and pushes its branches
   * into it (ADR-041).
   *
   * Called after the project row exists, because the credential is sealed against a
   * project id and recorded as the project's connection. A failure is logged and
   * audited rather than thrown: by the time this runs the project directory is real
   * and, for a provisioned project, so is a running Odoo instance with a database, a
   * systemd unit and an Nginx site. Throwing would report a working project as a
   * failed request and invite a retry that collides with the directory that exists.
   * The result says which of the three things happened, and the response carries it.
   */
  private async connectGitHubRepository(input: {
    projectId: string;
    userId: string;
    projectName: string;
    technicalName: string;
    description: string | null;
    gitRootPath: string;
    defaultBranch: string;
    branches: readonly string[];
  }): Promise<GitHubConnectionResult> {
    try {
      const result = await this.githubRepositories.connect({
        projectId: input.projectId,
        projectName: input.projectName,
        repositoryName: input.technicalName,
        description: input.description,
        gitRootPath: input.gitRootPath,
        defaultBranch: input.defaultBranch,
        branches: input.branches,
      });

      await this.audit.record({
        event:
          result.status === 'connected'
            ? AUDIT_EVENTS.PROJECT_GITHUB_REPOSITORY_CONNECTED
            : AUDIT_EVENTS.PROJECT_GITHUB_REPOSITORY_FAILED,
        projectId: input.projectId,
        userId: input.userId,
        metadata: {
          repository: result.repository,
          url: result.url,
          pushed: [...result.pushed],
          skipped: result.status === 'skipped',
          reason: result.reason,
        },
      });

      if (result.status === 'skipped') {
        this.logger.log(
          `Project "${input.projectName}" has no GitHub repository: ${result.reason}`,
        );
      }
      return result;
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(
        `Project "${input.projectName}" was created, but its GitHub repository could not be ` +
          `prepared: ${message}. The project itself is unaffected.`,
      );

      await this.audit.record({
        event: AUDIT_EVENTS.PROJECT_GITHUB_REPOSITORY_FAILED,
        projectId: input.projectId,
        userId: input.userId,
        metadata: { reason: message },
      });

      return {
        status: 'skipped',
        repository: null,
        url: null,
        pushed: [],
        reason: message,
      };
    }
  }

  async findOne(user: AuthenticatedUser, projectId: string) {
    const context = await this.authz.requireProjectAccess(user, projectId, {
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
      // ADR-057: a project the platform created a repository for (ADR-041)
      // never gets `repository_url` set on its own row — the connection is
      // what carries the credential. Resolved here, from the connections just
      // read, so the portal's Deploy/Ship-to-production actions are offered on
      // exactly the projects that actually have a repository, not only the
      // ones where a person typed the URL by hand.
      repositoryUrl: effectiveRepositoryUrl(project.repositoryUrl, connections),
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
      accessReason: context.accessReason,
    };
  }

  /**
   * Reveals the Odoo master password for a provisioned instance (ADR-040).
   *
   * Admin only - the master password is full administrative access to the Odoo
   * instance. Unsealed on-demand and returned once; never cached, never logged,
   * never included in `findOne`'s response shape.
   */
  async revealMasterPassword(user: AuthenticatedUser, projectId: string) {
    await this.authz.requireProjectAccess(user, projectId, {
      includeArchived: true,
      requireAdmin: true,
    });

    const [project] = await this.database.db
      .select({
        provisioningMasterPasswordRef: projects.provisioningMasterPasswordRef,
        name: projects.name,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundException('Project not found');

    if (!project.provisioningMasterPasswordRef) {
      throw new NotFoundException(
        'No master password is held for this project. It may not have been provisioned, or ' +
          'provisioning ran before this platform recorded the password.',
      );
    }

    const masterPassword = await this.secrets.read(project.provisioningMasterPasswordRef);

    // A reveal is a security-relevant read, audited the same way a connection
    // credential's use would be - the audit log is what lets an owner answer
    // "who looked at this" later.
    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_MASTER_PASSWORD_REVEALED,
      projectId,
      userId: user.userId,
    });

    return { masterPassword };
  }

  async update(user: AuthenticatedUser, projectId: string, dto: UpdateProjectDto) {
    await this.authz.requireProjectAccess(user, projectId);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.odooVersion !== undefined) patch.odooVersion = dto.odooVersion;
    if (dto.defaultBranch !== undefined) patch.defaultBranch = dto.defaultBranch;
    if (dto.environmentConfig !== undefined) {
      patch.environmentConfig = this.sanitiseEnvironmentConfig(dto.environmentConfig);
    }
    if (dto.localProviderOnly !== undefined) {
      // A data-governance switch carries the same rank as the agent
      // permissions it sits beside (ADR-055): an admin's call, not any
      // member's, because turning it off allows off-host egress.
      await this.authz.requireProjectAccess(user, projectId, { requireAdmin: true });
      patch.localProviderOnly = dto.localProviderOnly;
    }

    const [updated] = await this.database.db
      .update(projects)
      .set(patch)
      .where(eq(projects.id, projectId))
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_UPDATED,
      projectId,
      userId: user.userId,
      metadata: { fields: Object.keys(patch).filter((key) => key !== 'updatedAt') },
    });

    return this.present(updated);
  }

  async archive(user: AuthenticatedUser, projectId: string) {
    // Archiving one that is already archived is a no-op rather than a 404, so a
    // repeated click is not an error.
    await this.authz.requireProjectAccess(user, projectId, {
      includeArchived: true,
      requireAdmin: true,
    });

    await this.database.db
      .update(projects)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ARCHIVED,
      projectId,
      userId: user.userId,
    });
  }

  /** Returns an archived project to the active list. */
  async restore(user: AuthenticatedUser, projectId: string) {
    await this.authz.requireProjectAccess(user, projectId, {
      includeArchived: true,
      requireAdmin: true,
    });

    const [restored] = await this.database.db
      .update(projects)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();

    if (!restored) throw new NotFoundException('Project not found');

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_RESTORED,
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
    await this.authz.requireProjectAccess(user, projectId, {
      includeArchived: true,
      requireAdmin: true,
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

    // The Odoo master password (ADR-040) is sealed with projectId null - the
    // project row does not exist yet at the moment provisioning writes it -
    // so the project-scoped query above never finds it. Destroyed by its own
    // reference, held directly on the project row, for the same reason every
    // other secret this project owns is destroyed here rather than left
    // orphaned in secret_records.
    if (project.provisioningMasterPasswordRef) {
      await this.secrets.destroy(project.provisioningMasterPasswordRef).catch((error: Error) => {
        this.logger.error(
          `Could not destroy ${project.provisioningMasterPasswordRef}: ${error.message}`,
        );
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
    await this.authz.requireProjectAccess(user, projectId, {
      requireAdmin: true,
    });

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
    await this.authz.requireProjectAccess(user, projectId, {
      requireAdmin: true,
    });

    const credentialKind = dto.credentialKind ?? this.inferCredentialKind(dto);

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

    /**
     * Where the connection's secret comes from, in precedence order (ADR-058):
     *
     *  1. A value supplied on this request, sealed under the project's own key.
     *  2. A registered credential the caller named, or the one whose `hosts`
     *     list covers this remote - the default. Its *existing* reference is
     *     stored rather than a copy, so rotating the registered key reaches this
     *     project without anyone editing it. That sharing is the point.
     *  3. Nothing, leaving the connection `pending`.
     *
     * A registered credential is only attached when the remote's host is one it
     * was registered for (or its list is empty), so a default meant for
     * github.com is not silently attached to a gitlab.com remote.
     */
    let secretRef: string | null = null;
    let adoptedCredentialId: string | null = null;

    if (dto.credential && dto.credential.length > 0) {
      const reference = await this.secrets.write({
        projectId,
        purpose: `${dto.connectionType}-${credentialKind}`,
        value: dto.credential,
      });
      secretRef = reference.ref;
    } else {
      const repositoryUrl =
        typeof metadata.repositoryUrl === 'string' ? metadata.repositoryUrl : null;

      const registered = await this.gitCredentials
        .resolveForHost({
          credentialId: dto.credentialId ?? null,
          host: repositoryUrl ? this.gitCredentials.hostOf(repositoryUrl) : null,
        })
        // A registered default that does not fit this remote is not a reason to
        // fail the connection: the connection is still valid and the operator may
        // add a credential to it later.
        .catch(() => null);

      if (registered?.secretRef) {
        secretRef = registered.secretRef;
        adoptedCredentialId = registered.credentialId;
      }
    }

    /**
     * The kind has to follow the value that was actually attached. When a
     * registered credential is adopted its own kind wins, because the remote may
     * have been reached with a key while the URL says HTTPS (or the reverse),
     * and presenting the wrong kind to git is the failure this whole path exists
     * to avoid.
     */
    const effectiveKind = adoptedCredentialId
      ? ((
          await this.gitCredentials.list()
        ).find((row) => row.id === adoptedCredentialId)?.credentialKind ?? credentialKind)
      : credentialKind;

    const [connection] = await this.database.db
      .insert(projectConnections)
      .values({
        projectId,
        connectionType: dto.connectionType,
        secretRef,
        credentialKind: effectiveKind,
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
      projectId,
      userId: user.userId,
      metadata: {
        connectionType: dto.connectionType,
        credentialKind: effectiveKind,
        hasCredentials: secretRef !== null,
        hostKeyProvided: Boolean(dto.sshHostKey),
        // Which registered credential this borrowed, when it borrowed one. An
        // id rather than the value, and present so the audit log can answer
        // "which projects use the shared key" after a rotation.
        registeredCredentialId: adoptedCredentialId,
      },
    });

    return { ...connection, hasCredentials: secretRef !== null };
  }

  /**
   * What a supplied connection credential is, decided from the remote it is for.
   *
   * `token` was the old default, and it was wrong for the case it mattered: the
   * connect-existing form pastes an SSH private key for a repository whose URL is
   * `git@host:owner/repo.git`, so the key was stored as a token and presented to
   * the HTTPS askpass helper - while git was talking SSH. The push then failed
   * with an authentication error naming nothing the operator had done.
   *
   * An explicit `credentialKind` still wins; this only covers the omitted case.
   * The URL decides because the scheme is what git itself switches on: an `ssh://`
   * remote (or git's scp-like `user@host:path`) is reached with a key, everything
   * else with an HTTPS token. A URL that cannot be parsed falls back to `token`,
   * which is the previous behaviour rather than a new failure.
   */
  private inferCredentialKind(dto: CreateConnectionDto): CredentialKind {
    const repositoryUrl =
      typeof dto.metadata?.repositoryUrl === 'string' ? dto.metadata.repositoryUrl : null;
    if (!repositoryUrl) return 'token';

    try {
      return assertSafeRemoteUrl(repositoryUrl, { allowLocal: false }).scheme === 'ssh'
        ? 'ssh_key'
        : 'token';
    } catch {
      // A refused URL is the URL validator's complaint to make, not this
      // function's, and it will be made when the connection is used.
      return 'token';
    }
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
    await this.authz.requireProjectAccess(user, projectId, {
      requireAdmin: true,
    });

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
      projectId,
      userId: user.userId,
      metadata: { connectionType: connection.connectionType },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Who may create a project in a given region (ADR-044).
   *
   * An admin may choose any region. A regular caller may only create in their
   * own, so a project is never born in a region its creator cannot see.
   */
  private assertRegionAllowed(user: AuthenticatedUser, region: UserRegion): void {
    if (!USER_REGIONS.includes(region)) {
      throw new BadRequestException(`Unknown region: ${String(region)}.`);
    }
    if (!user.isAdmin && region !== user.region) {
      throw new BadRequestException(
        'You can only create projects in your own region. Ask an administrator to create it elsewhere.',
      );
    }
  }

  private async insertProject(values: {
    region: CreateProjectDto['region'];
    name: string;
    description: string | null;
    projectType: CreateProjectDto['projectType'];
    odooVersion: string | null;
    odooEdition: OdooEdition;
    defaultBranch: string;
    repositoryUrl: string | null;
    environmentConfig: Record<string, unknown>;
    createdByUserId: string;
    /** ADR-050/ADR-054: the linked instance's own URL, database and kind. */
    projectUrl?: string | null;
    projectDatabase?: string | null;
    isOdoosh?: boolean;
  }) {
    try {
      const [project] = await this.database.db
        .insert(projects)
        .values({ ...values, agentPermissions: { ...DEFAULT_AGENT_PERMISSIONS } })
        .returning();
      return project;
    } catch (error) {
      // The global unique index on `name` is the authority here.
      if (isUniqueViolation(error)) {
        throw new ConflictException('A project with that name already exists.');
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

  /**
   * Creates the project's directory and its empty addons directory (ADR-032,
   * amended by ADR-033).
   *
   * Creates `<projects_root>/<name>/addons/`, with the Git repository at
   * `<projects_root>/<name>/` carrying one commit — because the workspace layer
   * refuses a directory that is not a repository, and refuses a dirty tree, so
   * anything less would fail at the first task rather than here.
   *
   * The addons directory starts empty: what a project needs on day one is
   * somewhere to put modules, and a module's name belongs to the task that
   * describes the work.
   *
   * Refuses rather than reuses an existing directory: adopting one would put a
   * new project's work into another project's directory, and overwriting would
   * destroy it.
   */
  private async scaffoldCustomAddon(input: {
    projectName: string;
    technicalName?: string;
    projectType: ProjectType;
    odooVersion: string | null;
    odooEdition: OdooEdition;
    defaultBranch: string;
    /**
     * The branches to lay down beside the initial one (ADR-038): one per
     * environment. The default branch is created by `init`; the rest are added at
     * the initial commit so a task targeting any environment has a branch.
     */
    environmentBranches?: readonly string[];
  }): Promise<{
    technicalName: string;
    repositoryPath: string;
    addonsPath: string;
    /**
     * The directory that IS the Git repository (ADR-039).
     *
     * For a scaffold the platform made itself, the repository root is the project
     * directory and `addons/` sits inside it. For a directory the operator's
     * create_project provisioned, the repository root is `addons/` itself. Callers
     * that need a repository (the workspace layer) must use this, not
     * `repositoryPath`: recording the project root for a provisioned project
     * pointed the agent at a directory holding no `.git`, and every task on it
     * failed at allocation with "is not a Git repository".
     */
    gitRootPath: string;
    provisioning: ScaffoldProvisioningInfo | null;
  }> {
    // on_premise takes its code from a scaffolded local directory; an ai_project
    // has no repository (Repository: None) precisely because its code is meant to
    // live locally too (ADR-036). A repository-backed type is refused: its code
    // comes from the repository it connects to.
    if (input.projectType !== 'on_premise' && input.projectType !== 'ai_project') {
      throw new BadRequestException(
        'Scaffolding a project directory is available for on-premise and AI projects. ' +
          'A repository-backed project takes its code from the repository it connects to.',
      );
    }

    // The configured projects root, falling back to ON_PREMISE_ROOT when it has
    // not been set in the portal (ADR-033).
    const root = await this.odooSettings.projectsRootFor();
    if (!root) {
      throw new BadRequestException(
        'No projects root is configured. Set it in the settings, ' +
          'or set ON_PREMISE_ROOT on the server.',
      );
    }

    const directoryName = input.technicalName ?? deriveDirectoryName(input.projectName) ?? '';
    if (!isValidDirectoryName(directoryName)) {
      throw new BadRequestException(
        `"${directoryName || input.projectName}" does not give a usable directory name. ` +
          'Supply technicalName: lowercase letters, digits and underscores, starting with a letter.',
      );
    }

    const realRoot = await realpath(resolve(root)).catch(() => null);
    if (!realRoot) {
      throw new BadRequestException(`The configured projects root "${root}" does not exist.`);
    }

    // The name is already constrained to `[a-z][a-z0-9_]*`, so it cannot
    // traverse; the containment check is kept because the boundary should not
    // depend on a validator somewhere else continuing to be strict.
    const repositoryPath = resolve(realRoot, directoryName);
    if (dirname(repositoryPath) !== realRoot) {
      throw new BadRequestException(
        `The project directory must be directly under the projects root.`,
      );
    }

    const existing = await stat(repositoryPath).catch(() => null);
    if (existing) {
      throw new ConflictException(
        `"${directoryName}" already exists under the projects root. ` +
          'Choose another technicalName, or connect the existing directory instead of scaffolding.',
      );
    }

    try {
      const runnable = await this.resolveRunnableConfig(
        directoryName,
        input.odooEdition,
        input.odooVersion,
      );
      for (const file of buildScaffoldFiles({ projectName: input.projectName, runnable })) {
        const target = join(repositoryPath, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, { encoding: 'utf8', mode: file.mode ?? 0o644 });
      }

      await this.git.init(repositoryPath, input.defaultBranch);
      await this.git.commit(repositoryPath, `Scaffold ${directoryName}`);

      // A branch per environment beside the default one (ADR-038), created at the
      // initial commit. The default branch already exists from `init`, so it is
      // skipped; the rest give every environment a task can target a real branch.
      for (const branch of input.environmentBranches ?? []) {
        if (branch === input.defaultBranch) continue;
        await this.git.addBranch(repositoryPath, branch);
      }
    } catch (error) {
      // A half-written directory is worse than none: it would satisfy the
      // "already exists" check on the next attempt while not being a repository.
      await rm(repositoryPath, { recursive: true, force: true }).catch(() => undefined);
      throw new BadRequestException(
        `The project directory could not be created: ${(error as Error).message}`,
      );
    }

    const addonsPath = join(repositoryPath, 'addons');
    this.logger.log(
      `Scaffolded project directory "${directoryName}" at ${repositoryPath} ` +
        `on branch ${input.defaultBranch}; addons at ${addonsPath}`,
    );

    return {
      technicalName: directoryName,
      repositoryPath,
      addonsPath,
      // The scaffold made this repository at the project root, with addons/ inside.
      gitRootPath: repositoryPath,
      provisioning: null,
    };
  }

  /**
   * The provisioning path (ADR-039): a real, running Odoo instance instead of a
   * scaffold-only directory.
   *
   * The operator's create_project / create_project_enterprise scripts create
   * `<PROJECT_PROVISION_PROJECTS_DIR>/<name>/addons/` themselves — a plain data
   * directory, chown'd to odoo:odoo — as part of standing up the database,
   * systemd service and Nginx site. This method does not create that directory:
   * it waits for the script to create it, fixes its group ownership so the
   * platform can write to it (ProjectProvisioningService.provision does that),
   * and only then turns it into a Git repository, exactly the way
   * `scaffoldCustomAddon` does for a plain scaffold.
   *
   * Same shape of return as `scaffoldCustomAddon`, plus the `provisioning`
   * result, so `createAiProject` can treat the two branches uniformly except
   * where they must differ.
   *
   * Throws (refusing project creation outright) when the script fails or the
   * addons/ ownership fix-up fails: a project record with an
   * inconsistent provisioning status is worse than a request that failed
   * cleanly and can be retried, per the no-partial-result rule stated at the
   * call site.
   */
  private async provisionAiProject(input: {
    projectName: string;
    odooVersion: string | null;
    odooEdition: OdooEdition;
    /** Selects the standard database for the version, edition and region (ADR-051). */
    region: UserRegion;
    defaultBranch: string;
    environmentBranches?: readonly string[];
    /**
     * A resolved module selection (ADR-056), or undefined for the default
     * install-everything path. Forwarded to `ProjectProvisioningService.provision`.
     */
    modules?: readonly string[];
  }): Promise<{
    technicalName: string;
    repositoryPath: string;
    addonsPath: string;
    /**
     * The repository root, which for a provisioned project is `addons/` itself
     * (ADR-039): the operator's script created the project directory with its own
     * `config/`, `data/` and `logs/` beside a plain `addons/`, and the git init
     * below happens *in* `addons/`. Callers that need a repository use this and
     * not `repositoryPath` — see the same field's note on `scaffoldCustomAddon`.
     */
    gitRootPath: string;
    provisioning: ScaffoldProvisioningInfo;
  }> {
    const directoryName = deriveDirectoryName(input.projectName) ?? '';
    if (!isValidDirectoryName(directoryName)) {
      throw new BadRequestException(
        `"${directoryName || input.projectName}" does not give a usable directory name for ` +
          'provisioning. Rename the project so it starts with a letter and contains only ' +
          'lowercase letters, digits and underscores.',
      );
    }

    const result = await this.provisioning.provision({
      projectId: '', // not yet known: the project row does not exist until after this call
      technicalName: directoryName,
      odooEdition: input.odooEdition,
      odooVersion: input.odooVersion,
      region: input.region,
      modules: input.modules,
    });

    const repositoryPath = join(this.config.provisioning.projectsDir, directoryName);
    const addonsPath = join(repositoryPath, 'addons');

    /**
     * ADR-056: the selective path returns a *queued* result. Nothing exists on
     * disk yet — no directory, no database, no systemd unit — and none of it
     * will until the worker runs the script. So this branch deliberately skips
     * everything below (the master password seal, the addons/ existence check,
     * the git init): there is nothing to seal and no directory to inspect.
     *
     * The row is still written, with `pending`, which is what makes the portal
     * able to show "provisioning" instead of a project that mysteriously has
     * no instance. ProjectsService enqueues the job once the row exists — see
     * the call site, because the job needs the row's real id.
     */
    if (result.pending) {
      return {
        technicalName: directoryName,
        repositoryPath,
        addonsPath,
        gitRootPath: addonsPath,
        provisioning: {
          status: 'pending' as const,
          port: result.port,
          url: null,
          databaseName: result.databaseName,
          masterPasswordRef: null,
          https: result.https,
        },
      };
    }

    if (!result.provisioned) {
      throw new BadRequestException(
        `The Odoo instance could not be provisioned: ${result.error ?? 'unknown error'}`,
      );
    }

    /**
     * Seals the master password immediately (ADR-040) and discards the
     * plaintext from this function's own scope as soon as `write` returns.
     * projectId null: the project row does not exist yet, exactly the shape
     * createConnection uses for a connection credential created before its
     * project id would be known if it ever needed to be.
     * Never logged, never included in the return value, never held past the
     * one call that seals it.
     */
    let masterPasswordRef: string | null = null;
    if (result.masterPassword) {
      const sealed = await this.secrets.write({
        projectId: null,
        purpose: 'odoo-master-password',
        value: result.masterPassword,
      });
      masterPasswordRef = sealed.ref;
    }

    const addonsInfo = await stat(addonsPath).catch(() => null);
    if (!addonsInfo?.isDirectory()) {
      throw new BadRequestException(
        `Provisioning reported success but "${addonsPath}" does not exist. Check the ` +
          'provisioning script output on the host.',
      );
    }

    try {
      const existingGit = await stat(join(addonsPath, '.git')).catch(() => null);
      if (!existingGit) {
        for (const file of buildProvisionedAddonFiles({
          projectName: input.projectName,
          url: result.url,
        })) {
          const target = join(addonsPath, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content, { encoding: 'utf8', mode: file.mode ?? 0o644 });
        }

        await this.git.init(addonsPath, input.defaultBranch);
        await this.git.commit(addonsPath, `Scaffold ${directoryName}`);

        for (const branch of input.environmentBranches ?? []) {
          if (branch === input.defaultBranch) continue;
          await this.git.addBranch(addonsPath, branch);
        }
      }
    } catch (error) {
      // The instance is real and running; the only thing that failed is
      // turning addons/ into a git repository. Reported as a request failure
      // (not silently degraded to provisioningStatus 'failed') because a
      // project the agent cannot commit to is not one "Create with AI" can use,
      // and the audit trail for the orphaned instance is what the catch block
      // in createAiProject writes once this throws.
      throw new BadRequestException(
        `The Odoo instance at ${result.url} is running, but its addons/ directory could not ` +
          `be turned into a Git repository: ${(error as Error).message}. The instance was NOT ` +
          'torn down; an operator must reconcile it on the host.',
      );
    }

    this.logger.log(
      `Provisioned and scaffolded "${directoryName}" at ${repositoryPath}, running at ${result.url}`,
    );

    return {
      technicalName: directoryName,
      repositoryPath,
      addonsPath,
      // The git repository is addons/ here, not the project directory (ADR-039).
      gitRootPath: addonsPath,
      provisioning: {
        status: 'provisioned',
        port: result.port,
        url: result.url,
        databaseName: result.databaseName,
        masterPasswordRef,
        https: result.https,
      },
    };
  }

  /**
   * ADR-056: the second half of a selective provisioning, run when the worker's
   * script call finishes.
   *
   * Mirrors the tail of the synchronous `provisionAiProject` — seal the master
   * password, verify `addons/` exists, git-init it, connect the GitHub
   * repository — because those steps need a real directory, and until the
   * worker ran the host script there was none. Duplicating them here rather
   * than sharing a helper with the synchronous path is deliberate: the
   * synchronous path runs as part of an HTTP request with a caller to report
   * to and a transaction to roll back into, this one runs in a worker with
   * neither. Merging them would mean a boolean threaded through every branch.
   *
   * Never throws: there is no request to fail. Every outcome is written onto
   * the project row, which is what the portal polls.
   */
  async completeSelectiveProvisioning(data: SelectiveProvisionJobData): Promise<void> {
    const result = await this.provisioning.runSelectiveScript(data);

    if (!result.provisioned) {
      this.logger.error(
        `Selective provisioning of "${data.technicalName}" failed: ${result.error ?? 'unknown'}`,
      );
      await this.recordSelectiveOutcome(data.projectId, {
        provisioningStatus: 'failed',
        provisioningError: result.error ?? 'unknown error',
      });
      return;
    }

    let masterPasswordRef: string | null = null;
    if (result.masterPassword) {
      try {
        const sealed = await this.secrets.write({
          projectId: data.projectId,
          purpose: 'odoo-master-password',
          value: result.masterPassword,
        });
        masterPasswordRef = sealed.ref;
      } catch (error) {
        // The instance is real and running; only the credential reference was
        // lost. Logged loudly because the password is now recoverable only
        // from the host's odoo.conf, exactly as the synchronous path warns.
        this.logger.error(
          `Provisioned "${data.technicalName}" but could not seal its master password: ` +
            `${(error as Error).message}. Recover it from ` +
            `${this.config.provisioning.projectsDir}/${data.technicalName}/config/odoo.conf`,
        );
      }
    }

    const repositoryPath = join(this.config.provisioning.projectsDir, data.technicalName);
    const addonsPath = join(repositoryPath, 'addons');

    const addonsInfo = await stat(addonsPath).catch(() => null);
    if (!addonsInfo?.isDirectory()) {
      await this.recordSelectiveOutcome(data.projectId, {
        provisioningStatus: 'failed',
        provisioningError:
          `Provisioning reported success but "${addonsPath}" does not exist. Check the ` +
          'provisioning script output on the host.',
      });
      return;
    }

    try {
      const existingGit = await stat(join(addonsPath, '.git')).catch(() => null);
      if (!existingGit) {
        for (const file of buildProvisionedAddonFiles({
          projectName: data.technicalName,
          url: result.url,
        })) {
          const target = join(addonsPath, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content, { encoding: 'utf8', mode: file.mode ?? 0o644 });
        }

        await this.git.init(addonsPath, 'main');
        await this.git.commit(addonsPath, `Scaffold ${data.technicalName}`);

        for (const branch of DEFAULT_SCAFFOLD_ENVIRONMENTS.map(
          (environment) => environment.branch,
        )) {
          if (branch === 'main') continue;
          await this.git.addBranch(addonsPath, branch);
        }
      }
    } catch (error) {
      // The instance is real; only its addons/ could not be turned into a
      // repository. Recorded as a failure because a project the agent cannot
      // commit to is not one the AI flow can use — the same judgement the
      // synchronous path makes.
      await this.recordSelectiveOutcome(data.projectId, {
        provisioningStatus: 'failed',
        provisioningError:
          `The Odoo instance at ${result.url} is running, but its addons/ directory could ` +
          `not be turned into a Git repository: ${(error as Error).message}`,
      });
      return;
    }

    await this.recordSelectiveOutcome(data.projectId, {
      provisioningStatus: 'provisioned',
      provisioningPort: result.port,
      provisioningUrl: result.url,
      provisionedAt: new Date(),
      provisioningDatabaseName: result.databaseName,
      provisioningMasterPasswordRef: masterPasswordRef,
      provisioningError: null,
      httpsStatus: result.https.status,
      httpsError: result.https.error,
      environmentConfig: {
        targetEnvironment: 'development',
        onPremisePath: addonsPath,
      },
    });

    this.logger.log(
      `Selective provisioning of "${data.technicalName}" finished at ${result.url}`,
    );

    /**
     * The GitHub repository (ADR-041), last and never fatal — the same ordering
     * the synchronous path uses, for the same reason: the project is real by
     * this point and an unreachable GitHub must not undo that.
     */
    await this.connectGitHubRepository({
      projectId: data.projectId,
      // The row was created by a user whose id is recorded on it; this is the
      // same attribution the synchronous path passes at request time.
      userId: await this.ownerOf(data.projectId),
      projectName: data.technicalName,
      technicalName: data.technicalName,
      description: null,
      gitRootPath: addonsPath,
      defaultBranch: 'main',
      branches: DEFAULT_SCAFFOLD_ENVIRONMENTS.map((environment) => environment.branch),
    });
  }

  /** The user a project was created by, for worker-side attribution. */
  private async ownerOf(projectId: string): Promise<string> {
    const [row] = await this.database.db
      .select({ userId: projects.createdByUserId })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row?.userId ?? '';
  }

  /** Writes a selective provisioning outcome onto the project row. */
  private async recordSelectiveOutcome(
    projectId: string,
    values: Partial<typeof projects.$inferInsert>,
  ): Promise<void> {
    await this.database.db
      .update(projects)
      .set(values)
      .where(eq(projects.id, projectId))
      .catch((error: Error) =>
        this.logger.error(
          `Could not record provisioning outcome on project ${projectId}: ${error.message}`,
        ),
      );
  }

  /**
   * The inputs a runnable `odoo.conf` and `run.sh` need (ADR-035), or undefined
   * when the deployment cannot supply them.
   *
   * Best-effort by design: the base path must resolve and actually hold
   * `odoo-bin`. When it does not — an environment-only deployment whose
   * base/enterprise split is unknown, or a projects root without a matching Odoo
   * source — scaffolding proceeds without the launcher rather than failing. A
   * project that cannot be started is an inconvenience; a project that could not
   * be created is not.
   *
   * The base path is the first configured source path, which ADR-033 defines as
   * the Odoo repo root (the one holding `odoo-bin` and `addons/`); the enterprise
   * path, when present, is the second.
   */
  private async resolveRunnableConfig(
    directoryName: string,
    edition: OdooEdition,
    version: string | null = null,
  ): Promise<RunnableConfig | undefined> {
    // ADR-045: the per-version catalog is the authority for a declared version.
    // With no active row for it, the organisation-wide paths (ADR-033) apply,
    // which keeps a single-version deployment exactly as it was.
    const sourcePaths =
      (await this.odooVersions.sourcePathsFor(version, edition)) ??
      (await this.odooSettings.sourcePathsFor(edition));
    const basePath = sourcePaths[0];
    if (!basePath) return undefined;

    const odooBin = join(basePath, 'odoo-bin');
    const runnable = await stat(odooBin).catch(() => null);
    if (!runnable?.isFile()) {
      this.logger.warn(
        `No runnable launcher scaffolded for "${directoryName}": ` +
          `"${odooBin}" is not present, so odoo.conf/run.sh were skipped (ADR-035).`,
      );
      return undefined;
    }

    return {
      directoryName,
      basePath,
      enterprisePath: sourcePaths[1] ?? null,
      edition,
      python: this.config.validation.python,
      httpPort: 8069,
    };
  }

  /** Response shape for a project. Declared so no column leaks by accident. */
  private present(project: {
    id: string;
    region: string;
    name: string;
    description: string | null;
    projectType: string;
    odooVersion: string | null;
    odooEdition: string;
    defaultBranch: string;
    repositoryUrl: string | null;
    environmentConfig: Record<string, unknown>;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    localProviderOnly?: boolean;
    provisioningStatus?: string;
    provisioningPort?: number | null;
    provisioningUrl?: string | null;
    provisioningError?: string | null;
    provisioningDatabaseName?: string | null;
    provisioningMasterPasswordRef?: string | null;
    provisionedAt?: Date | null;
    httpsStatus?: string;
    httpsError?: string | null;
    restartStatus?: string;
    restartError?: string | null;
    restartCommit?: string | null;
    restartBranch?: string | null;
    restartedAt?: Date | null;
    /** ADR-050/ADR-054: the linked instance this connect points at. */
    projectUrl?: string | null;
    projectDatabase?: string | null;
    isOdoosh?: boolean;
  }) {
    return {
      id: project.id,
      region: project.region,
      name: project.name,
      description: project.description,
      projectType: project.projectType,
      odooVersion: project.odooVersion,
      odooEdition: project.odooEdition,
      defaultBranch: project.defaultBranch,
      repositoryUrl: project.repositoryUrl,
      environmentConfig: project.environmentConfig,
      archivedAt: project.archivedAt,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      localProviderOnly: project.localProviderOnly ?? false,
      /**
       * The provisioned instance's own connection details (ADR-039, ADR-040).
       * `hasMasterPassword` is a boolean, never the reference itself: the
       * reference is an internal handle into secret_records, and the portal
       * needs only to know whether a "reveal" call would return something.
       * The plaintext password is never present in this shape, under any
       * field name, at any point.
       */
      provisioning: {
        status: project.provisioningStatus ?? 'none',
        port: project.provisioningPort ?? null,
        url: project.provisioningUrl ?? null,
        databaseName: project.provisioningDatabaseName ?? null,
        error: project.provisioningError ?? null,
        provisionedAt: project.provisionedAt ?? null,
        hasMasterPassword: Boolean(project.provisioningMasterPasswordRef),
        https: {
          status: project.httpsStatus ?? 'none',
          error: project.httpsError ?? null,
        },
      },
      /**
       * The last restart attempt through the platform (ADR-057), for the portal
       * to poll: 'pending' while the worker is running the upgrade, 'restarted'
       * once the unit came back up on the new code, 'failed' — with the code
       * already rolled back to what it was serving before — if the upgrade did
       * not land.
       */
      restart: {
        status: project.restartStatus ?? 'none',
        error: project.restartError ?? null,
        commit: project.restartCommit ?? null,
        branch: project.restartBranch ?? null,
        restartedAt: project.restartedAt ?? null,
      },
      /**
       * The linked instance this project points at (ADR-050, ADR-054), when the
       * operator connected an existing odoo.sh/on-premise project rather than
       * only a repository. Not a secret: a URL and a database name, shown so a
       * restore can be aimed at the right instance, and so the portal never
       * presents the Cartenz replica as the customer's live system.
       */
      link: {
        projectUrl: project.projectUrl ?? null,
        database: project.projectDatabase ?? null,
        isOdoosh: project.isOdoosh ?? false,
      },
    };
  }
}

/** PostgreSQL unique-violation SQLSTATE. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/** The selected on-premise directory, stored in a project's environment config. */
export function readOnPremisePath(
  environmentConfig: Record<string, unknown> | null | undefined,
): string | null {
  if (!environmentConfig || typeof environmentConfig !== 'object') return null;
  const value = environmentConfig.onPremisePath;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
