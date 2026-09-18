import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { projects } from '../../core/database/schema';
import { CommandRunner } from '../../core/process/command-runner.service';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { technicalNameFromOnPremisePath } from './project-deployment.service';

/** One row of a project's own module list. */
export interface InstalledModule {
  readonly name: string;
  readonly state: string;
}

export interface InstalledModulesResult {
  /** False when this deployment has no read script; `reason` says why. */
  readonly available: boolean;
  readonly reason: string | null;
  readonly modules: readonly InstalledModule[];
}

/**
 * What is actually installed in a provisioned project's instance (ADR-056).
 *
 * The portal's module picker shows what someone *asked* for at creation; after
 * provisioning, the only source of truth for what is really there is the
 * project's own `ir_module_module` table. Reading it requires a route the
 * platform otherwise has none of: the `cartenz` user cannot connect to a
 * project database, let alone read it (verified: `permission denied for table
 * ir_module_module`).
 *
 * Rather than grant a general database connection - which would be a wide,
 * permanent privilege for a read that is inherently narrow - this goes through
 * a root-run script (`infrastructure/provisioning/list-installed-modules.sh`)
 * under the same two gates as every other privileged script: the sudoers
 * `Cmnd_Alias` and `assertProvisioningInvocation`. The script itself runs one
 * fixed query against exactly the one database the project's own odoo.conf
 * names; nothing in the argument vector can steer it.
 *
 * Read-only, so unlike the backup there is no table and no audit event: nothing
 * is changed and nothing secret is revealed. There is also deliberately no
 * caching - a read that returns a stale list after an install is worse than one
 * that costs a couple of hundred milliseconds.
 */
@Injectable()
export class ProjectModulesService {
  private readonly logger = new Logger(ProjectModulesService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly commands: CommandRunner,
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
  ) {}

  /** True when this deployment has the read script and its sudo grant. */
  get available(): boolean {
    return Boolean(
      this.config.provisioning?.enabled && this.config.provisioning.modulesListScript,
    );
  }

  async list(user: AuthenticatedUser, projectId: string): Promise<InstalledModulesResult> {
    await this.authz.requireProjectAccess(user, projectId);

    if (!this.available) {
      return {
        available: false,
        reason:
          'Reading installed modules is not enabled on this deployment ' +
          '(PROJECT_MODULES_LIST_SCRIPT is empty, or PROJECT_PROVISIONING_ENABLED is false).',
        modules: [],
      };
    }

    const [project] = await this.database.db
      .select({
        id: projects.id,
        environmentConfig: projects.environmentConfig,
        provisioningStatus: projects.provisioningStatus,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      return { available: true, reason: 'Project not found.', modules: [] };
    }

    // Anchored to the configured projects root, exactly as the backup and the
    // pull resolve it; never derived from the path's own shape.
    const technicalName = technicalNameFromOnPremisePath(
      project.environmentConfig,
      this.config.provisioning?.projectsDir ?? '',
    );

    if (!technicalName || project.provisioningStatus !== 'provisioned') {
      return {
        available: true,
        reason:
          'This project has no provisioned instance on this host, so it has no module ' +
          'list to read.',
        modules: [],
      };
    }

    const script = this.config.provisioning!.modulesListScript!;

    let result;
    try {
      result = await this.commands.run('sudo', ['-n', script, technicalName], { cwd: '/' });
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Reading modules of "${technicalName}" failed: ${message}`);
      return { available: true, reason: message, modules: [] };
    }

    if (result.exitCode !== 0) {
      // The script's own words are the useful message - it says which of the
      // things it checks failed, and the platform cannot see any of them.
      const detail = summariseTail(result.stderr || result.stdout);
      const message = detail || `The read script exited with code ${result.exitCode}.`;
      this.logger.error(`Reading modules of "${technicalName}" failed: ${message}`);
      return { available: true, reason: message, modules: [] };
    }

    return { available: true, reason: null, modules: parseModuleList(result.stdout) };
  }
}

/**
 * The script prints one `name<TAB>state` pair per line, sorted by name, with
 * every diagnostic on stderr. A line that does not fit (a psql notice that
 * somehow reached stdout) is skipped rather than turned into a module named
 * "NOTICE: ..." - a wrong list is worse than a short one.
 */
export function parseModuleList(stdout: string): readonly InstalledModule[] {
  const modules: InstalledModule[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const [name, state, ...rest] = trimmed.split('\t');
    if (!name || !state || rest.length > 0) continue;

    modules.push({ name, state });
  }

  return modules;
}

/** The last non-empty line of a script's output, bounded (its own words). */
function summariseTail(value: string): string {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (lines[lines.length - 1] ?? '').slice(0, 400);
}
