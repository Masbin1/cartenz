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
 * The Odoo.sh `main` branch restriction (ADR-028).
 *
 * Odoo.sh's `main` branch is the live business, so a task targeting it is refused
 * outright rather than gated on an approval - the same shape of guarantee as the
 * production refusal in ADR-021.
 */
describe('TasksService.create — odoo_sh main branch restriction', () => {
  const makeService = (branch: string) => {
    const project = { projectType: 'odoo_sh', repositoryUrl: 'git@git.odoo.com:p.git', name: 'P' };

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

  it('refuses a task targeting the main branch on an odoo_sh project', async () => {
    const service = makeService('main');

    await expect(
      service.create({ userId: 'u' } as never, 'project-1', { prompt: 'add a field' } as never),
    ).rejects.toThrow(BadRequestException);
  });
});
