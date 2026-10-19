import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { CommandRunner } from '../../core/process/command-runner.service';
import { technicalNameFromOnPremisePath, summariseTail } from './project-deployment.service';

/**
 * Tears down a project's on-premise instance, as the last step of a permanent
 * delete (ADR-024).
 *
 * `projects.service.ts#destroy` deletes the platform's own database row and
 * destroys the secrets it owns, but nothing about that touches the real
 * instance a provisioned project leaves on the host: its systemd unit, its
 * PostgreSQL database, its project directory (config/data/logs/addons), its
 * Nginx site and its certificate. Without this, every permanent delete left
 * all of that running and accumulating — a project could be deleted from the
 * portal a dozen times and the host would still be serving all twelve.
 *
 * Runs a root-run script (`infrastructure/provisioning/teardown-project.sh`),
 * through the same two gates as every other provisioning step: the sudoers
 * `Cmnd_Alias` and `assertProvisioningInvocation`, with the narrow shape
 * `-n <script> <project-name>` — identical to the grant, backup and
 * installed-modules scripts, and distinguished from them only by configured
 * path. The script itself takes its own restorable backup before deleting
 * anything (unless explicitly skipped), so a teardown is not the only copy of
 * a client's data disappearing.
 *
 * Deliberately best-effort from the caller's side: `destroy()` calls this
 * AFTER it has already decided to delete the project row, so a teardown
 * failure is logged and audited but does not block the platform-side delete —
 * an instance stuck on the host because its script failed is an operator
 * problem to fix by hand (the script's own output says exactly what did not
 * come down), not a reason to leave an undeletable project record forever.
 */
@Injectable()
export class ProjectTeardownService {
  private readonly logger = new Logger(ProjectTeardownService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly commands: CommandRunner,
    private readonly audit: AuditService,
  ) {}

  /** True when this deployment has the teardown script and its sudo grant. */
  get available(): boolean {
    return Boolean(this.config.provisioning?.enabled && this.config.provisioning.teardownScript);
  }

  /**
   * Tears down one project's on-premise instance, identified by its stored
   * on-premise path (the same value `project-deployment.service.ts` resolves
   * a technical name from for pull/restart/backup).
   *
   * Returns rather than throws on every outcome: the caller decides whether a
   * teardown failure should still let the platform-side delete proceed.
   */
  async run(
    projectId: string,
    environmentConfig: Record<string, unknown> | null,
    options: { readonly userId: string },
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    if (!this.available) {
      return {
        ok: true,
        message:
          'Teardown is not enabled on this deployment (PROJECT_TEARDOWN_SCRIPT is empty, or ' +
          'PROJECT_PROVISIONING_ENABLED is false); the on-premise instance, if any, was left as is.',
      };
    }

    const technicalName = technicalNameFromOnPremisePath(environmentConfig, [
      this.config.provisioning?.projectsDir ?? '',
      this.config.provisioning?.projectsDir20 ?? '',
    ]);

    if (!technicalName) {
      return {
        ok: true,
        message: 'This project has no on-premise instance on this host; nothing to tear down.',
      };
    }

    const script = this.config.provisioning!.teardownScript!;
    const startedAt = Date.now();

    let result;
    try {
      result = await this.commands.run('sudo', ['-n', script, technicalName], {
        cwd: '/',
        // Backs up the instance first (database dump + filestore + addons
        // bundle) before deleting anything, which can take as long as a
        // manual backup does.
        timeoutMs: this.config.process.maxTimeoutMs,
      });
    } catch (error) {
      const message = (error as Error).message;
      await this.markFailed(projectId, technicalName, options.userId, message);
      return { ok: false, message };
    }

    const durationMs = Date.now() - startedAt;

    if (result.exitCode !== 0) {
      const message =
        summariseTail(result.stderr || result.stdout) ||
        `The teardown script exited with code ${result.exitCode}.`;
      await this.markFailed(projectId, technicalName, options.userId, message);
      return { ok: false, message };
    }

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_INSTANCE_TORN_DOWN,
      projectId,
      userId: options.userId,
      metadata: { technicalName, durationMs },
    });

    this.logger.log(`Instance "${technicalName}" torn down in ${durationMs} ms`);

    return { ok: true, message: `Instance "${technicalName}" torn down.` };
  }

  private async markFailed(
    projectId: string,
    technicalName: string,
    userId: string,
    message: string,
  ): Promise<void> {
    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_INSTANCE_TEARDOWN_FAILED,
      projectId,
      userId,
      metadata: { technicalName, error: message },
    });

    this.logger.error(`Teardown of "${technicalName}" (project ${projectId}) failed: ${message}`);
  }
}
