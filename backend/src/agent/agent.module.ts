import { Module, forwardRef } from '@nestjs/common';
import { TaskRepository } from './task-repository';
import { ToolRegistry } from './tools/tool-registry';
import { ToolPermissionValidator } from './tools/permission-validator';
import { ToolExecutionService } from './tools/tool-execution.service';
import { RealRepositoryTools } from './tools/real/repository.tools';
import { RealGitTools } from './tools/real/git.tools';
import { RealOdooTools } from './tools/real/odoo.tools';
import { OdooOnlineTools } from './tools/real/odoo-online.tools';
import { OdooOnlineClient } from './odoo-online/odoo-online-client';
import { WorkspaceManager } from './workspace/workspace-manager';
import { OdooValidationRunner } from './validation/odoo-validation-runner';
import { GitService } from './git/git.service';
import { OdooProjectAnalyser } from './analysis/odoo-project-analyser';
import { ProjectMemoryService } from './analysis/project-memory.service';
import { ModelAgentPlanner } from './orchestration/model-agent-planner';
import { ModelImplementationLoop } from './orchestration/model-implementation-loop';
import { ChatLoop } from './orchestration/model-chat-loop';
import { ModelCallRecorder } from './model/model-call-recorder.service';
import { ModelModule } from './model/model.module';
import { AgentWorkflow } from './orchestration/agent-workflow';
import { QueueAgentOrchestrator } from './orchestration/queue-agent-orchestrator';
import { AGENT_ORCHESTRATOR } from './orchestration/agent-orchestrator.interface';
import { ExecutorRegistry } from './executors/executor-registry';
import { EXECUTOR } from './executors/executor.interface';
import { OnPremiseExecutor } from './executors/on-premise.executor';
import { OdooSHExecutor } from './executors/odoo-sh.executor';
import { OdooOnlineExecutor } from './executors/odoo-online.executor';
import { ApprovalsModule } from '../modules/approvals/approvals.module';

/**
 * The agent layer: orchestration, tools, git, analysis and the workspace seam
 * (ADR-016).
 *
 * The orchestrator is bound to its interface token here and nowhere else, which
 * is the single edit a Temporal implementation requires. The planner is likewise
 * a single binding: a Vercel AI SDK planner replaces AgentPlanner and nothing
 * else changes.
 *
 * The circular reference to ApprovalsModule is intentional and is the shape of the
 * domain: the workflow requests approvals, and an approval decision resumes the
 * workflow. forwardRef records that rather than hiding it behind an event bus that
 * would make the sequence harder to follow.
 */
@Module({
  imports: [ModelModule, forwardRef(() => ApprovalsModule)],
  providers: [
    TaskRepository,
    GitService,
    OdooProjectAnalyser,
    ProjectMemoryService,
    WorkspaceManager,
    OdooValidationRunner,
    RealRepositoryTools,
    RealGitTools,
    RealOdooTools,
    OdooOnlineTools,
    OdooOnlineClient,
    ToolRegistry,
    ToolPermissionValidator,
    ToolExecutionService,
    ModelAgentPlanner,
    ModelImplementationLoop,
    ChatLoop,
    ModelCallRecorder,
    AgentWorkflow,
    ExecutorRegistry,
    OnPremiseExecutor,
    OdooSHExecutor,
    OdooOnlineExecutor,
    QueueAgentOrchestrator,
    { provide: AGENT_ORCHESTRATOR, useExisting: QueueAgentOrchestrator },
    {
      provide: EXECUTOR,
      useFactory: (
        onPremise: OnPremiseExecutor,
        odooSh: OdooSHExecutor,
        odooOnline: OdooOnlineExecutor,
      ) => [onPremise, odooSh, odooOnline],
      inject: [OnPremiseExecutor, OdooSHExecutor, OdooOnlineExecutor],
    },
  ],
  exports: [
    TaskRepository,
    OdooOnlineClient,
    ToolRegistry,
    ToolExecutionService,
    AgentWorkflow,
    WorkspaceManager,
    OdooValidationRunner,
    GitService,
    ProjectMemoryService,
    OdooProjectAnalyser,
    ModelCallRecorder,
    ExecutorRegistry,
    AGENT_ORCHESTRATOR,
  ],
})
export class AgentModule {}
