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
        organizationId: 'org-1',
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

    return new TasksService(
      database,
      authz,
      {} as AuditService,
      {} as TaskRepository,
      {} as ToolRegistry,
      {} as ModelCallRecorder,
      environments,
      {} as AgentOrchestrator,
    );
  };

  const submit = (service: TasksService) =>
    service.create({ userId: 'u' } as never, 'project-1', { prompt: 'add a field' } as never);

  it('refuses a task targeting the main branch on an odoo_sh project', async () => {
    await expect(submit(makeService('main', 'odoo_sh'))).rejects.toThrow(BadRequestException);
  });

  it('refuses a task targeting the main branch on an on_premise project', async () => {
    await expect(submit(makeService('main', 'on_premise'))).rejects.toThrow(BadRequestException);
  });

  it('names the project type in the refusal, so the message fits what was submitted', async () => {
    await expect(submit(makeService('main', 'on_premise'))).rejects.toThrow(/On-premise/);
    await expect(submit(makeService('main', 'odoo_sh'))).rejects.toThrow(/Odoo\.sh/);
  });

  it('permits another branch on an on_premise project', async () => {
    // The guard must not be a blanket refusal: Staging is the branch this is for.
    await expect(submit(makeService('Staging', 'on_premise'))).rejects.not.toThrow(
      BadRequestException,
    );
  });
});
