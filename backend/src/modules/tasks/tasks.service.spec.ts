import { BadRequestException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { resolveAgentPermissions } from '../../core/authz/agent-permissions';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuthorizationService } from '../../core/authz/authorization.service';
import type { AuditService } from '../../core/audit/audit.service';
import type { TaskRepository } from '../../agent/task-repository';
import type { ToolRegistry } from '../../agent/tools/tool-registry';
import type { ModelCallRecorder } from '../../agent/model/model-call-recorder.service';
import type { ProjectEnvironmentsService } from '../projects/project-environments.service';
import type { AgentOrchestrator } from '../../agent/orchestration/agent-orchestrator.interface';

/**
 * The `main` branch restriction (ADR-028: "the platform never pushes to main").
 *
 * `main` is the live business, so a task targeting it is refused outright rather
 * than gated on an approval - the same shape of guarantee as the production
 * refusal in ADR-021.
 *
 * On-premise is covered as well as Odoo.sh, and matters more: it commits directly
 * in the directory a person selected, on the environment's own branch, so there is
 * no separate AI branch between the agent's commit and `main`.
 */
describe('TasksService.create — main branch restriction', () => {
  const makeService = (branch: string, projectType = 'odoo_sh') => {
    const project = { projectType, repositoryUrl: 'git@git.odoo.com:p.git', name: 'P' };

    const auditRecords: Array<Record<string, unknown>> = [];
    const audit = {
      record: async (entry: Record<string, unknown>) => {
        auditRecords.push(entry);
      },
    } as unknown as AuditService;

    const database = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [project],
            }),
          }),
        }),
      },
    } as unknown as DatabaseService;

    const authz = {
      requireProjectAccess: async () => ({
        projectId: 'project-1',
        agentPermissions: resolveAgentPermissions({}),
      }),
    } as unknown as AuthorizationService;

    const environments = {
      resolveTarget: async () => ({
        id: 'env-1',
        name: 'Development',
        branch,
        kind: 'development',
      }),
    } as unknown as ProjectEnvironmentsService;

    const service = new TasksService(
      database,
      authz,
      audit,
      {} as TaskRepository,
      {} as ToolRegistry,
      {} as ModelCallRecorder,
      environments,
      {} as AgentOrchestrator,
    );

    return { service, auditRecords };
  };

  const submit = (service: TasksService) =>
    service.create({ userId: 'u' } as never, 'project-1', { prompt: 'add a field' } as never);

  it('refuses a task targeting the main branch on an odoo_sh project', async () => {
    await expect(submit(makeService('main', 'odoo_sh').service)).rejects.toThrow(BadRequestException);
  });

  it('refuses a task targeting the main branch on an on_premise project', async () => {
    await expect(submit(makeService('main', 'on_premise').service)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('names the project type in the refusal, so the message fits what was submitted', async () => {
    await expect(submit(makeService('main', 'on_premise').service)).rejects.toThrow(/On-premise/);
    await expect(submit(makeService('main', 'odoo_sh').service)).rejects.toThrow(/Odoo\.sh/);
  });

  it('audits the main-branch refusal before raising it (ADR-028)', async () => {
    // The ADR states the refusal "is audited". A refusal nobody can see is
    // indistinguishable from a request nobody made, so the record must be
    // written even though no task row is.
    const { service, auditRecords } = makeService('main', 'odoo_sh');
    await expect(submit(service)).rejects.toThrow(BadRequestException);

    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      event: 'environment.target_refused',
      projectId: 'project-1',
      userId: 'u',
      metadata: expect.objectContaining({ branch: 'main', projectType: 'odoo_sh' }),
    });
  });

  it('permits another branch on an on_premise project', async () => {
    // The guard must not be a blanket refusal: Staging is the branch this is for.
    await expect(submit(makeService('Staging', 'on_premise').service)).rejects.not.toThrow(
      BadRequestException,
    );
  });
});

/**
 * A created project's repository is recorded as a connection, not on
 * `projects.repository_url` (ADR-041).
 *
 * The regression this covers: creation gave an `ai_project` a GitHub repository and
 * a `github` connection, `repository_url` stayed null, and the submission guard -
 * which read only `repository_url` - refused every development request on exactly
 * those projects with "has no repository yet. Connect one before submitting a
 * development request." The feature that created the repository was the reason the
 * next step was refused, and the message sent the person to connect a repository
 * that was already connected.
 */
describe('TasksService.create — a project whose repository is a connection (ADR-041)', () => {
  const makeAiService = (options: {
    repositoryUrl?: string | null;
    gitConnection?: { id: string } | null;
    branch?: string;
  }) => {
    const project = {
      projectType: 'ai_project',
      repositoryUrl: options.repositoryUrl ?? null,
      name: 'P',
    };

    const database = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [project],
              // The connection lookup continues past `where` to order and limit.
              orderBy: () => ({
                limit: async () => (options.gitConnection ? [options.gitConnection] : []),
              }),
            }),
          }),
        }),
      },
    } as unknown as DatabaseService;

    const authz = {
      requireProjectAccess: async () => ({
        projectId: 'project-1',
        agentPermissions: resolveAgentPermissions({}),
      }),
    } as unknown as AuthorizationService;

    const environments = {
      resolveTarget: async () => ({
        id: 'env-1',
        name: 'Development',
        branch: options.branch ?? 'development',
        kind: 'development',
      }),
    } as unknown as ProjectEnvironmentsService;

    return new TasksService(
      database,
      authz,
      { record: async () => undefined } as unknown as AuditService,
      {} as TaskRepository,
      {} as ToolRegistry,
      {} as ModelCallRecorder,
      environments,
      {} as AgentOrchestrator,
    );
  };

  const submit = (service: TasksService, kind?: string) =>
    service.create({ userId: 'u' } as never, 'project-1', {
      prompt: 'add a field',
      ...(kind ? { kind } : {}),
    } as never);

  it('permits a development request when the repository is a GitHub connection', async () => {
    // `rejects.not.toThrow(BadRequestException)` rather than resolving: later steps
    // still need the database. What is asserted is that this guard does not fire.
    await expect(
      submit(makeAiService({ gitConnection: { id: 'conn-1' } })),
    ).rejects.not.toThrow(BadRequestException);
  });

  it('permits one when the repository URL is recorded instead', async () => {
    await expect(
      submit(makeAiService({ repositoryUrl: 'https://github.com/o/p.git' })),
    ).rejects.not.toThrow(BadRequestException);
  });

  it('still refuses a project with neither a repository URL nor a Git connection', async () => {
    await expect(submit(makeAiService({}))).rejects.toThrow(/no repository yet/);
  });

  it('still permits a chat task on a project with no repository at all', async () => {
    await expect(submit(makeAiService({}), 'chat')).rejects.not.toThrow(BadRequestException);
  });
});
