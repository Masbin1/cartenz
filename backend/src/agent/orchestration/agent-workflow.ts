import { Inject, Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { TaskRepository, type TaskExecutionSnapshot } from '../task-repository';
import { searchTermsFor } from './odoo-target';
import { ModelAgentPlanner } from './model-agent-planner';
import { ModelImplementationLoop, type LoopToolResult } from './model-implementation-loop';
import { ChatLoop } from './model-chat-loop';
import { ModelCallRecorder } from '../model/model-call-recorder.service';
import { ModelProviderError } from '../model/model-provider.interface';
import { AiBoundaryRefusalError } from '../../core/ai-boundary/boundary-types';
import { WorkspaceManager, type Workspace } from '../workspace/workspace-manager';
import { ApprovalRequiredError, ToolExecutionService } from '../tools/tool-execution.service';
import { ToolRegistry } from '../tools/tool-registry';
import { ApprovalService } from '../../modules/approvals/approval.service';
import { OdooProjectAnalyser } from '../analysis/odoo-project-analyser';
import { ProjectMemoryService } from '../analysis/project-memory.service';
import { GitService } from '../git/git.service';
import { isTerminalStatus, type AgentTaskStatus } from '../task-state';
import type { ModifiedFile, TaskTestResults } from './agent-plan';
import type { ToolExecutionContext, AnyToolDefinition } from '../tools/tool.interface';
import type { ExecutionMode } from '../executors/execution-mode';
import type { CodeSearchMatch } from '../analysis/code-search';
import { rankCandidates, type ModelRelevance } from '../analysis/odoo-model-index';
import { inferOdooTarget } from './odoo-target';
import type { OdooFieldSummary } from './model-agent-planner';
import { OdooValidationRunner } from '../validation/odoo-validation-runner';
import { changedModules } from '../validation/changed-modules';

/**
 * How many matched files are read so they can be ranked, and how many are sent.
 *
 * Ranking requires reading - a file cannot be judged on its name - so more are
 * read than sent. Bounded so that a broad search does not become a read of the
 * whole repository.
 */
const CANDIDATES_TO_RANK = 12;
const EXCERPTS_TO_SEND = 3;

/**
 * The agent lifecycle, as a sequence of explicit steps.
 *
 * This is the class a Temporal implementation replaces with an equivalent
 * workflow definition (ADR-011). Three properties make that exchange possible and
 * are maintained deliberately:
 *
 *  1. Every step reads the task's current status from the database before acting
 *     and transitions from it, so the workflow can be entered at any point - a
 *     fresh start, a resumption after approval, or a retry after a worker restart
 *     - without a separate code path for each.
 *  2. The approval wait is a return, not a block. `run` returns when the task
 *     reaches waiting_approval; the worker's job completes, and the approval
 *     decision enqueues a new job that re-enters here.
 *  3. Cancellation is observed at every step boundary rather than interrupting a
 *     step in flight, so the platform never abandons a partially applied effect.
 *
 * Phase 2 changed what the steps do, not their shape. A workspace is now a real
 * clone (ADR-019), so the workspace is allocated once per run and released on the
 * terminal path, rather than being re-created by each step.
 */
@Injectable()
export class AgentWorkflow {
  private readonly logger = new Logger(AgentWorkflow.name);

  /**
   * Workspaces held by this process, keyed by task.
   *
   * A workspace is a real directory now, so it must survive across the steps of
   * one run and be released exactly once. It is deliberately not persisted in
   * memory across runs: a resumed task re-clones, because a worker that restarted
   * has no claim on a directory another process may have removed.
   */
  private readonly workspaces = new Map<string, Workspace>();

  constructor(
    private readonly tasks: TaskRepository,
    private readonly planner: ModelAgentPlanner,
    private readonly implementationLoop: ModelImplementationLoop,
    private readonly chatLoop: ChatLoop,
    private readonly modelCalls: ModelCallRecorder,
    private readonly workspaceManager: WorkspaceManager,
    private readonly tools: ToolExecutionService,
    private readonly registry: ToolRegistry,
    private readonly approvals: ApprovalService,
    private readonly analyser: OdooProjectAnalyser,
    private readonly projectMemory: ProjectMemoryService,
    private readonly git: GitService,
    private readonly validation: OdooValidationRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Advances a task as far as it can go, returning when it settles or suspends. */
  async run(taskId: string): Promise<void> {
    let snapshot = await this.tasks.snapshot(taskId);
    this.logger.log(`Running ${snapshot.reference} from status ${snapshot.status}`);

    try {
      for (;;) {
        if (isTerminalStatus(snapshot.status)) return;
        if (await this.shouldStop(snapshot)) return;

        const advanced = await this.step(snapshot);
        if (!advanced) return;

        snapshot = await this.tasks.snapshot(taskId);
      }
    } finally {
      // A workspace is released when the task settles, or when the run ends
      // without settling - a suspension at an approval, or a yield. Holding a
      // clone open across a human wait of unknown length would be worse than
      // re-cloning on resumption.
      await this.releaseWorkspace(taskId, snapshot.status);
    }
  }

  /**
   * Executes the step appropriate to the task's current status. Returns false when
   * the task has settled or is now waiting on a person.
   */
  private async step(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    switch (snapshot.status) {
      case 'created':
        return this.tasks.transition(snapshot.taskId, 'created', 'queued');

      case 'queued':
        return this.tasks.transition(snapshot.taskId, 'queued', 'analyzing');

      case 'analyzing':
        return snapshot.executionMode === 'odoo_online'
          ? this.analyzeOdooOnline(snapshot)
          : this.analyze(snapshot);

      case 'planning':
        return snapshot.executionMode === 'odoo_online'
          ? this.planOdooOnline(snapshot)
          : this.plan(snapshot);

      case 'waiting_approval':
        return this.resumeFromApproval(snapshot);

      case 'implementing':
        if (snapshot.kind === 'chat') return this.implementChat(snapshot);
        return snapshot.executionMode === 'odoo_online'
          ? this.implementOdooOnline(snapshot)
          : this.implement(snapshot);

      case 'testing':
        if (snapshot.kind === 'chat') return this.completeChat(snapshot);
        return snapshot.executionMode === 'odoo_online'
          ? this.validateOdooOnline(snapshot)
          : this.validate(snapshot);

      case 'committing':
        return this.commit(snapshot);

      case 'pushing':
        return this.push(snapshot);

      case 'building':
        // Build monitoring is Phase 5. Until then a pushed task completes.
        return this.tasks.transition(snapshot.taskId, 'building', 'completed');

      case 'completed':
      case 'failed':
      case 'cancelled':
        return false;
    }
  }

  /**
   * Resumes a task suspended at an approval.
   *
   * The decision is read from the database rather than passed in, so the
   * resumption is correct whether it follows the approval immediately, follows a
   * worker restart, or follows a retry of a job that had already run.
   */
  private async resumeFromApproval(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    if (snapshot.pendingApproval) {
      // Still awaiting a person. The worker holds nothing open (ADR-011).
      return false;
    }

    const decision = snapshot.lastDecision;

    if (!decision) {
      return this.tasks.transition(snapshot.taskId, 'waiting_approval', 'failed', {
        failureReason: 'The task is suspended at an approval that no longer exists.',
      });
    }

    if (decision.status === 'rejected') {
      await this.narrate(snapshot, `${humanise(decision.action)} was rejected. Stopping.`);
      return this.tasks.transition(snapshot.taskId, 'waiting_approval', 'failed', {
        failureReason: `The ${humanise(decision.action)} was rejected.`,
      });
    }

    switch (decision.action) {
      case 'implementation_plan':
        return this.tasks.transition(snapshot.taskId, 'waiting_approval', 'implementing', {
          message: 'The plan was approved. Implementing.',
        });

      case 'git_push':
        return this.tasks.transition(snapshot.taskId, 'waiting_approval', 'pushing', {
          message: 'The push was approved. Pushing the branch.',
        });

      case 'file_deletion':
        return this.tasks.transition(snapshot.taskId, 'waiting_approval', 'implementing', {
          message: 'The file deletion was approved. Continuing implementation.',
        });

      case 'chat_edit':
        return this.tasks.transition(snapshot.taskId, 'waiting_approval', 'implementing', {
          message: 'Approved. Continuing.',
        });

      default:
        return this.tasks.transition(snapshot.taskId, 'waiting_approval', 'failed', {
          failureReason: `No resumption is defined for an approved ${decision.action}.`,
        });
    }
  }

  /**
   * ANALYZING. Clones the repository, creates the AI branch, and reports what the
   * project actually is.
   *
   * This is the step Phase 2 changed most. It previously narrated invented facts;
   * it now clones, parses the repository's own manifests, and writes the result to
   * project memory so that later tasks and the portal share one view of the
   * project.
   */
  private async analyze(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    const onPremise = snapshot.executionMode === 'on_premise';
    await this.narrate(
      snapshot,
      onPremise
        ? `Preparing to operate directly on the selected project directory for ${snapshot.projectName}...`
        : `Preparing an isolated workspace for ${snapshot.projectName}...`,
    );

    let workspace: Workspace;
    try {
      workspace = await this.acquireWorkspace(snapshot);
    } catch (error) {
      // A clone failure is the most likely real failure in this step, and its
      // message is the thing a user needs: a bad URL, a rejected credential, a
      // missing branch.
      const reason = (error as Error).message;
      await this.narrate(snapshot, `The workspace could not be prepared: ${reason}`);
      return this.tasks.transition(snapshot.taskId, 'analyzing', 'failed', {
        failureReason: reason,
      });
    }

    await this.tasks.saveBranch(snapshot.taskId, workspace.branch);
    if (workspace.baseCommit) {
      await this.tasks.saveBaseCommit(snapshot.taskId, workspace.baseCommit);
    }

    if (workspace.simulated) {
      await this.narrate(
        snapshot,
        snapshot.kind === 'chat'
          ? 'This project has no repository connected, so there is nothing to clone. Answering from the project specification.'
          : 'This project has no repository connected, so there is nothing to clone. Planning from the project specification.',
      );
      return this.tasks.transition(
        snapshot.taskId,
        'analyzing',
        snapshot.kind === 'chat' ? 'implementing' : 'planning',
      );
    }

    await this.narrate(
      snapshot,
      onPremise
        ? `Operating directly on ${workspace.repositoryPath} (branch ${workspace.branch}).`
        : snapshot.targetEnvironment
          ? `Cloned ${workspace.baseBranch} (${snapshot.targetEnvironment.name}, ${snapshot.targetEnvironment.kind}) ` +
              `at ${workspace.baseCommit?.slice(0, 8)} and created ${workspace.branch}.`
          : `Cloned ${workspace.baseBranch} at ${workspace.baseCommit?.slice(0, 8)} and created ${workspace.branch}.`,
    );

    // Through the tool layer, not called directly: the analysis must appear in the
    // action log and pass the permission validator like any other agent action.
    await this.callTool(snapshot, workspace, 'detect_odoo_version', {});
    await this.callTool(snapshot, workspace, 'list_modules', {});

    const analysis = await this.analyser.analyse(workspace.repositoryPath);

    await this.narrate(
      snapshot,
      analysis.detectedOdooVersion
        ? `Odoo ${analysis.detectedOdooVersion} detected from ${analysis.modules.length} module manifest(s).`
        : `No Odoo module manifest was found in ${analysis.structure.totalFiles} file(s).`,
    );

    if (analysis.modules.length > 0) {
      const names = analysis.modules.slice(0, 6).map((module) => module.technicalName);
      await this.narrate(
        snapshot,
        `Modules: ${names.join(', ')}${analysis.modules.length > names.length ? `, and ${analysis.modules.length - names.length} more` : ''}.`,
      );
    }

    for (const note of analysis.notes.slice(0, 4)) {
      await this.narrate(snapshot, note);
    }

    // Persisted so project context survives the workspace it was derived from.
    await this.projectMemory.record({
      projectId: snapshot.projectId,
        organizationId: snapshot.organizationId,
      taskId: snapshot.taskId,
      analysis,
    });

    for (const term of searchTermsFor(snapshot.prompt)) {
      await this.callTool(snapshot, workspace, 'search_code', { query: term });
    }

    await this.narrate(snapshot, 'Searching related modules...');

    // A chat task has no plan gate (ADR-029): analysis leads straight into the
    // conversational loop rather than into planning.
    return this.tasks.transition(
      snapshot.taskId,
      'analyzing',
      snapshot.kind === 'chat' ? 'implementing' : 'planning',
    );
  }

  // -------------------------------------------------------------------------
  // Odoo Online (ADR-028)
  //
  // The same four states as every other mode - analyse, plan, approve, implement -
  // against a different surface. There is no clone, no diff and no commit here, so
  // these steps do not share the Git ones: what makes the mode safe is that its
  // tools are the only ones the validator permits, and those reach schema and
  // views only.
  // -------------------------------------------------------------------------

  /**
   * ANALYZING, on Odoo Online. Reads the instance's own schema for the model the
   * request is about.
   *
   * Through the tool layer rather than the client directly, so the reads appear in
   * the action log and pass the permission validator exactly as any other agent
   * action does. A credential that does not authenticate fails here, before a
   * person is asked to approve anything.
   */
  private async analyzeOdooOnline(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    const workspace = await this.acquireWorkspace(snapshot);
    const target = inferOdooTarget(snapshot.prompt).model;

    await this.narrate(
      snapshot,
      `Reading the Odoo Online instance for ${snapshot.projectName}. No repository is cloned: ` +
        'this project is customised on the instance itself.',
    );

    const fields = await this.callTool(snapshot, workspace, 'odoo_list_fields', { model: target });

    if (fields.status !== 'succeeded') {
      const reason =
        typeof fields.output.error === 'string'
          ? fields.output.error
          : `The Odoo Online instance could not be read for "${target}".`;
      await this.narrate(snapshot, `The instance could not be read: ${reason}`);
      return this.tasks.transition(snapshot.taskId, 'analyzing', 'failed', {
        failureReason: reason,
      });
    }

    await this.narrate(
      snapshot,
      `${fields.output.count ?? 0} field(s) read from ${target} on the live instance.`,
    );

    return this.tasks.transition(snapshot.taskId, 'analyzing', 'planning');
  }

  /**
   * PLANNING, on Odoo Online.
   *
   * The plan omits `filesToModify` and `validation` because neither exists in this
   * mode; they are filled with empty arrays so the persisted plan keeps one shape.
   * The approval gate is unchanged: a change to a live instance is put to a person
   * before it happens, exactly as a change to a repository is.
   */
  private async planOdooOnline(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    await this.narrate(snapshot, 'Creating implementation plan...');

    const workspace = await this.acquireWorkspace(snapshot);
    const target = inferOdooTarget(snapshot.prompt).model;

    // The schema the plan must be true to, read from the instance rather than
    // assumed: a plan naming a field that does not exist cannot be carried out.
    const fields = await this.callTool(snapshot, workspace, 'odoo_list_fields', { model: target });

    let outcome;
    try {
      outcome = await this.planner.createOdooOnlinePlan({
        organizationId: snapshot.organizationId,
        projectId: snapshot.projectId,
        prompt: snapshot.prompt,
        projectName: snapshot.projectName,
        taskReference: snapshot.reference,
        odooVersion: snapshot.odooVersion,
        instanceUrl: snapshot.odooOnlineUrl,
        targetModel: target,
        fields: (fields.output.fields as OdooFieldSummary[] | undefined) ?? [],
        grantedTools: this.grantedToolNames(snapshot),
      });
    } catch (error) {
      return this.failOnModelError(snapshot, 'planning', 'planning', error);
    }

    await this.modelCalls.record({
      taskId: snapshot.taskId,
      organizationId: snapshot.organizationId,
      operation: 'planning',
      providerId: outcome.providerId,
      model: outcome.model,
      calledExternalService: outcome.calledExternalService,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      durationMs: outcome.usage.durationMs,
      steps: 1,
      boundaryFindings: outcome.boundaryFindings,
      redactionCount: outcome.redactionCount,
    });

    const plan = outcome.plan;
    await this.tasks.savePlan(snapshot.taskId, plan);

    await this.narrate(
      snapshot,
      outcome.calledExternalService
        ? `Plan produced by ${outcome.providerId}/${outcome.model}.`
        : 'Plan produced without a model call: this deployment has no AI provider configured.',
    );

    await this.approvals.request({
      taskId: snapshot.taskId,
      taskReference: snapshot.reference,
      organizationId: snapshot.organizationId,
      action: 'implementation_plan',
      requiredReason:
        'This plan changes a live Odoo Online instance. It must be approved before anything is created there.',
      context: {
        summary: plan.summary,
        stepCount: plan.steps.length,
        targetModel: target,
        instance: snapshot.odooOnlineUrl,
        producedBy: plan.generatedBy,
      },
      taskStatus: 'planning',
    });

    await this.narrate(snapshot, 'Waiting for approval.');

    return this.tasks.transition(snapshot.taskId, 'planning', 'waiting_approval', {
      message: 'The implementation plan is awaiting approval.',
    });
  }

  /**
   * IMPLEMENTING, on Odoo Online. The model carries out the approved plan against
   * the instance through the Odoo tools.
   *
   * There is no diff to check the model against here, which the repository modes
   * rely on. The substitute is the tool log: `odoo_create_field` and
   * `odoo_add_field_to_view` each return the id Odoo assigned, so a change either
   * has a recorded id or did not happen. A run that changed nothing is a failure
   * rather than a completion, for the same reason it is in the other modes.
   */
  private async implementOdooOnline(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    if (!snapshot.plan) {
      return this.tasks.transition(snapshot.taskId, 'implementing', 'failed', {
        failureReason: 'The task reached implementation with no approved plan.',
      });
    }

    const workspace = await this.acquireWorkspace(snapshot);
    await this.narrate(snapshot, 'Applying the approved plan to the Odoo Online instance...');

    const applied: string[] = [];

    let outcome;
    try {
      outcome = await this.implementationLoop.run({
        organizationId: snapshot.organizationId,
        projectId: snapshot.projectId,
        prompt: snapshot.prompt,
        projectName: snapshot.projectName,
        taskReference: snapshot.reference,
        branch: 'the live instance',
        odooVersion: snapshot.odooVersion,
        plan: snapshot.plan,
        agentPermissions: snapshot.agentPermissions,
        executionMode: 'odoo_online',
        run: async (call) => {
          const result = await this.callTool(snapshot, workspace, call.name, call.input);
          if (result.status === 'succeeded' && CHANGING_ODOO_TOOLS.includes(call.name)) {
            applied.push(describeOdooChange(call.name, result.output));
          }
          return { status: toLoopResult(result.status), output: result.output };
        },
      });
    } catch (error) {
      return this.failOnModelError(snapshot, 'implementing', 'implementation', error);
    }

    await this.modelCalls.record({
      taskId: snapshot.taskId,
      organizationId: snapshot.organizationId,
      operation: 'implementation',
      providerId: outcome.providerId,
      model: outcome.model,
      calledExternalService: outcome.calledExternalService,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      durationMs: outcome.usage.durationMs,
      steps: outcome.steps,
      toolCalls: outcome.toolCalls,
      boundaryFindings: outcome.boundaryFindings,
      redactionCount: outcome.redactionCount,
      haltReason: outcome.haltReason,
    });

    if (outcome.summary.trim().length > 0) {
      await this.narrate(snapshot, outcome.summary.trim());
    }

    if (outcome.suspended) return false;

    if (outcome.haltReason) {
      await this.narrate(snapshot, `The agent stopped early: ${outcome.haltReason}.`);
    }

    if (applied.length === 0) {
      // The tool log, not the model's account of itself. A summary claiming a
      // field was created is contradicted by the absence of an id.
      return this.tasks.transition(snapshot.taskId, 'implementing', 'failed', {
        failureReason:
          outcome.haltReason
            ? `Nothing was changed on the instance: ${outcome.haltReason}.`
            : 'The agent reported completion but changed nothing on the Odoo Online instance.',
      });
    }

    for (const change of applied) {
      await this.narrate(snapshot, change);
    }

    /**
     * Through `testing`, not straight to `completed`.
     *
     * The state table has no `implementing -> completed` edge, and taking one
     * anyway is not a cosmetic error: the transition throws *after* the instance
     * has already been written, the job fails, and the queue retries the whole
     * step - which applied the same change three times to a live instance before
     * the task was cancelled. The lifecycle is the authority on what may follow
     * what; a new mode routes through it rather than around it.
     */
    return this.tasks.transition(snapshot.taskId, 'implementing', 'testing', {
      message: `${applied.length} change(s) applied to the Odoo Online instance across ${outcome.toolCalls} tool call(s).`,
    });
  }

  /**
   * TESTING, on Odoo Online.
   *
   * There is nothing to run. Odoo validated each write as it applied it - an
   * unknown field type or a malformed view arch is an RPC error, not a silent
   * success - and there is no repository test suite to run against a live
   * instance. The state is still passed through rather than skipped, because it
   * is how the lifecycle reaches `completed`, and saying plainly that no test ran
   * is better than a validation step that could only simulate one.
   */
  private async validateOdooOnline(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    await this.tasks.saveTestResults(snapshot.taskId, {
      passed: 0,
      failed: 0,
      skipped: 0,
      suites: [],
      simulated: false,
    });

    await this.narrate(
      snapshot,
      'No test suite was run: this project has no repository. Each change was accepted by ' +
        'Odoo as it was applied, which is the only validation this mode has.',
    );

    return this.tasks.transition(snapshot.taskId, 'testing', 'completed', {
      message: 'The change was applied to the Odoo Online instance.',
    });
  }

  /**
   * PLANNING. Asks the model for a plan, persists it, and requests the approval
   * that gates implementation.
   *
   * The model call is the only part of this step that changed in Phase 3. What did
   * not change is that the plan is validated against a schema, written to the task,
   * and put to a person before anything is modified - so a bad plan is a rejected
   * plan rather than a bad change.
   */
  private async plan(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    await this.narrate(snapshot, 'Creating implementation plan...');

    const workspace = await this.acquireWorkspace(snapshot);
    const analysis = workspace.simulated
      ? null
      : await this.analyser.analyse(workspace.repositoryPath);

    const searchMatches = workspace.simulated
      ? []
      : await this.gatherSearchMatches(workspace, snapshot.prompt);

    // The model the request is about, inferred once here so the candidate files
    // can be ranked against it before either provider sees them (ADR-025).
    const targetModel = inferOdooTarget(snapshot.prompt).model;

    const candidates = workspace.simulated
      ? { excerpts: [], ranked: [] }
      : await this.gatherCandidates(workspace, searchMatches, targetModel);

    let outcome;
    try {
      outcome = await this.planner.createPlan({
        organizationId: snapshot.organizationId,
        projectId: snapshot.projectId,
        prompt: snapshot.prompt,
        projectName: snapshot.projectName,
        taskReference: snapshot.reference,
        branch: workspace.branch,
        declaredOdooVersion: snapshot.odooVersion,
        analysis,
        searchMatches,
        excerpts: candidates.excerpts,
        rankedCandidates: candidates.ranked,
        grantedTools: this.grantedToolNames(snapshot),
      });
    } catch (error) {
      return this.failOnModelError(snapshot, 'planning', 'planning', error);
    }

    await this.modelCalls.record({
      taskId: snapshot.taskId,
        organizationId: snapshot.organizationId,
      operation: 'planning',
      providerId: outcome.providerId,
      model: outcome.model,
      calledExternalService: outcome.calledExternalService,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      durationMs: outcome.usage.durationMs,
      steps: 1,
      boundaryFindings: outcome.boundaryFindings,
      redactionCount: outcome.redactionCount,
    });

    if (outcome.redactionCount > 0) {
      await this.narrate(
        snapshot,
        `The AI data boundary removed ${outcome.redactionCount} item(s) before the request left the platform: ` +
          outcome.boundaryFindings.map((finding) => finding.rule).join(', ') + '.',
      );
    }

    await this.narrate(
      snapshot,
      outcome.calledExternalService
        ? `Plan produced by ${outcome.providerId}/${outcome.model}.`
        : 'Plan produced without a model call: this deployment has no AI provider configured.',
    );

    const plan = outcome.plan;
    await this.tasks.savePlan(snapshot.taskId, plan);

    await this.approvals.request({
      taskId: snapshot.taskId,
      taskReference: snapshot.reference,
        organizationId: snapshot.organizationId,
      action: 'implementation_plan',
      requiredReason: 'The implementation plan must be approved before any file is modified.',
      context: {
        summary: plan.summary,
        stepCount: plan.steps.length,
        filesToModify: plan.filesToModify.map(
          (file) => `${file.change === 'added' ? '+' : file.change === 'deleted' ? '-' : '~'} ${file.path}`,
        ),
        odooVersion: plan.odooVersion,
        producedBy: plan.generatedBy,
      },
      taskStatus: 'planning',
    });

    await this.narrate(snapshot, 'Waiting for approval.');

    return this.tasks.transition(snapshot.taskId, 'planning', 'waiting_approval', {
      message: 'The implementation plan is awaiting approval.',
    });
  }

  /**
   * IMPLEMENTING. Hands the approved plan to the model, which carries it out
   * through tools.
   *
   * The model chooses what to read and what to write; every call it makes goes
   * through the same mediated path the workflow uses, so the permission validator
   * and the approval gate apply to it exactly as they do to a call made here
   * (ADR-020).
   *
   * What the model reports is not what gets recorded. The authoritative account of
   * what changed comes from `git diff` afterwards, so a model that claims a change
   * it did not make is contradicted by the diff rather than believed.
   */
  private async implement(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    if (!snapshot.plan) {
      return this.tasks.transition(snapshot.taskId, 'implementing', 'failed', {
        failureReason: 'The task reached implementation with no approved plan.',
      });
    }

    const workspace = await this.acquireWorkspace(snapshot);

    if (workspace.simulated) {
      return this.tasks.transition(snapshot.taskId, 'implementing', 'failed', {
        failureReason:
          'There is no repository to modify. Connect one to this project before submitting a change.',
      });
    }

    await this.narrate(snapshot, 'Applying the approved plan...');

    let outcome;
    try {
      outcome = await this.implementationLoop.run({
        organizationId: snapshot.organizationId,
        projectId: snapshot.projectId,
        prompt: snapshot.prompt,
        projectName: snapshot.projectName,
        taskReference: snapshot.reference,
        branch: workspace.branch,
        odooVersion: snapshot.odooVersion,
        plan: snapshot.plan,
        agentPermissions: snapshot.agentPermissions,
        executionMode: snapshot.executionMode,
        run: async (call) => {
          const outcome = await this.callTool(snapshot, workspace, call.name, call.input);
          return { status: toLoopResult(outcome.status), output: outcome.output };
        },
      });
    } catch (error) {
      return this.failOnModelError(snapshot, 'implementing', 'implementation', error);
    }

    await this.modelCalls.record({
      taskId: snapshot.taskId,
        organizationId: snapshot.organizationId,
      operation: 'implementation',
      providerId: outcome.providerId,
      model: outcome.model,
      calledExternalService: outcome.calledExternalService,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      durationMs: outcome.usage.durationMs,
      steps: outcome.steps,
      toolCalls: outcome.toolCalls,
      boundaryFindings: outcome.boundaryFindings,
      redactionCount: outcome.redactionCount,
      haltReason: outcome.haltReason,
    });

    if (outcome.summary.trim().length > 0) {
      await this.narrate(snapshot, outcome.summary.trim());
    }

    // A tool needed an approval. The task has already been moved to
    // waiting_approval by callTool, so the run simply ends here.
    if (outcome.suspended) return false;

    if (outcome.haltReason) {
      await this.narrate(snapshot, `The agent stopped early: ${outcome.haltReason}.`);
    }

    // git is the authority on what changed, not the model.
    const diff = await this.git.diff(workspace.repositoryPath, workspace.baseCommit ?? 'HEAD');

    const modified: ModifiedFile[] = diff.files.map((file) => ({
      path: file.path,
      change: file.change === 'renamed' ? 'modified' : file.change,
      summary:
        snapshot.plan?.filesToModify.find((planned) => planned.path === file.path)?.reason ??
        'Changed while carrying out the approved plan',
      linesAdded: file.linesAdded,
      linesRemoved: file.linesRemoved,
    }));

    await this.tasks.saveModifiedFiles(snapshot.taskId, modified);
    await this.tasks.saveDiffStats(snapshot.taskId, {
      filesChanged: diff.files.length,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
      patchTruncated: diff.patchTruncated,
      toolCalls: outcome.toolCalls,
    });
    // Retained with the task: the workspace is destroyed when the run ends, so
    // this is the only copy a reviewer will have.
    await this.tasks.saveDiffPatch(snapshot.taskId, diff.patch);

    if (modified.length === 0) {
      /**
       * The model reported completion but changed nothing.
       *
       * Reported as a failure rather than passed on, because the alternative is a
       * task that reaches "completed" with an empty commit and a summary claiming
       * work was done - which is worse than a visible failure.
       */
      return this.tasks.transition(snapshot.taskId, 'implementing', 'failed', {
        failureReason:
          outcome.haltReason
            ? `No change was made to the working tree: ${outcome.haltReason}.`
            : 'The agent reported completion but made no change to the working tree.',
      });
    }

    await this.callTool(snapshot, workspace, 'git_diff', {});

    return this.tasks.transition(snapshot.taskId, 'implementing', 'testing', {
      message: `${modified.length} file(s) changed, +${diff.linesAdded}/-${diff.linesRemoved} across ${outcome.toolCalls} tool call(s). Running validation.`,
    });
  }

  /**
   * IMPLEMENTING, for a chat task (ADR-029).
   *
   * Runs the conversational loop instead of the plan-carrying one. There is no
   * plan and no diff to check the model against: the deliverable is the
   * natural-language answer, saved on the task and narrated so it survives the
   * destroyed workspace. A write tool pauses the task for the `chat_edit`
   * approval through the same callTool path a change task uses, and the run
   * resumes into implementing once a person decides.
   */
  private async implementChat(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    const workspace = await this.acquireWorkspace(snapshot);
    await this.narrate(snapshot, 'Thinking about your request...');

    let outcome;
    try {
      outcome = await this.chatLoop.run({
        organizationId: snapshot.organizationId,
        projectId: snapshot.projectId,
        prompt: snapshot.prompt,
        projectName: snapshot.projectName,
        taskReference: snapshot.reference,
        branch: workspace.branch,
        odooVersion: snapshot.odooVersion,
        agentPermissions: snapshot.agentPermissions,
        executionMode: snapshot.executionMode,
        run: async (call) => {
          const result = await this.callTool(snapshot, workspace, call.name, call.input);
          return { status: toLoopResult(result.status), output: result.output };
        },
      });
    } catch (error) {
      return this.failOnModelError(snapshot, 'implementing', 'chat', error);
    }

    await this.modelCalls.record({
      taskId: snapshot.taskId,
      organizationId: snapshot.organizationId,
      operation: 'chat',
      providerId: outcome.providerId,
      model: outcome.model,
      calledExternalService: outcome.calledExternalService,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      durationMs: outcome.usage.durationMs,
      steps: outcome.steps,
      toolCalls: outcome.toolCalls,
      boundaryFindings: outcome.boundaryFindings,
      redactionCount: outcome.redactionCount,
      haltReason: outcome.haltReason,
    });

    // A write tool needed the `chat_edit` approval. callTool has already
    // requested the approval and moved the task to waiting_approval, so the run
    // simply ends here and resumes once a person decides.
    if (outcome.suspended) return false;

    const answer = outcome.answer.trim();

    if (answer.length > 0) {
      await this.tasks.saveAnswer(snapshot.taskId, answer);
      await this.narrate(snapshot, answer);
    }

    if (outcome.haltReason) {
      await this.narrate(snapshot, `The agent stopped early: ${outcome.haltReason}.`);
    }

    // A chat task does not commit or push, but an approved write still has to be
    // reviewable. The workspace is destroyed when the run ends, so the diff is
    // computed and retained with the task exactly as a change task retains it —
    // the only difference is that no commit exists and nothing can be pushed.
    const diff = await this.git.diff(workspace.repositoryPath, workspace.baseCommit ?? 'HEAD');

    if (diff.files.length > 0) {
      const modified: ModifiedFile[] = diff.files.map((file) => ({
        path: file.path,
        change: file.change === 'renamed' ? 'modified' : file.change,
        summary: 'Changed in conversation, with your approval',
        linesAdded: file.linesAdded,
        linesRemoved: file.linesRemoved,
      }));

      await this.tasks.saveModifiedFiles(snapshot.taskId, modified);
      await this.tasks.saveDiffStats(snapshot.taskId, {
        filesChanged: diff.files.length,
        linesAdded: diff.linesAdded,
        linesRemoved: diff.linesRemoved,
        patchTruncated: diff.patchTruncated,
        toolCalls: outcome.toolCalls,
      });
      await this.tasks.saveDiffPatch(snapshot.taskId, diff.patch);
    }

    // A chat task that answered a question and changed nothing completes
    // successfully. There is no "made no change to the working tree" failure
    // here - that is a change-task rule, and a chat's deliverable is the answer.
    // The state machine has no implementing -> completed edge (ADR-018), so the
    // task passes through `testing`, where the chat branch completes it at once:
    // a conversation has nothing to validate, commit or push.
    return this.tasks.transition(snapshot.taskId, 'implementing', 'testing', {
      message: `Answered in ${outcome.steps} step(s) across ${outcome.toolCalls} tool call(s).`,
    });
  }

  /**
   * TESTING, on a chat task. A conversation has nothing to validate, commit or
   * push, so the task completes the moment its answer is saved. This branch
   * exists rather than a `implementing -> completed` edge because the state
   * machine deliberately keeps that edge absent: `odoo_online` must pass
   * through validation (a real defect it guards), and a chat task passing
   * through `testing` keeps the machine intact for every kind.
   */
  private async completeChat(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    return this.tasks.transition(snapshot.taskId, 'testing', 'completed', {
      message: 'Answered.',
    });
  }

  /**
   * TESTING. Runs the validation tools named in the plan.
   *
   * These remain simulated (ADR-019): each executes repository code, which is the
   * risk the isolation boundary exists for. The step is real in every other
   * respect - it runs through the tool layer, records actions, and its results are
   * persisted - so replacing the tools is the whole of Phase 4.
   */
  private async validate(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    const workspace = await this.acquireWorkspace(snapshot);

    // A configured deployment runs the repository's own tests (ADR-027). One that
    // is not falls through to the simulated tools below, and says so.
    if (this.validation.available) {
      const resumed = await this.validateForReal(snapshot, workspace);
      if (resumed !== null) return resumed;
    }

    await this.narrate(
      snapshot,
      'Running validation. These results are simulated: executing repository code requires the isolated workspace of a later phase.',
    );

    const suites: TaskTestResults['suites'][number][] = [];
    let passed = 0;
    let failed = 0;

    for (const toolName of snapshot.plan?.validation ?? ['run_linter']) {
      const result = await this.callTool(snapshot, workspace, toolName, {});
      if (result.status === 'suspended') return false;

      const ok = result.status === 'succeeded';
      suites.push({
        name: toolName,
        status: ok ? 'passed' : 'failed',
        ...(ok ? {} : { detail: 'The tool did not complete successfully.' }),
      });
      if (ok) passed += 1;
      else failed += 1;

      await this.pause();
    }

    const results: TaskTestResults = { passed, failed, skipped: 0, suites, simulated: true };
    await this.tasks.saveTestResults(snapshot.taskId, results);

    // "Validation passed, simulated" reads as a pass, especially when it follows a
    // line explaining that the real run was skipped. Say what did not happen.
    await this.narrate(
      snapshot,
      failed === 0
        ? `Validation reported ${passed} simulated step(s). No repository code was ` +
          'executed, so this is not evidence the change works.'
        : `Validation failed: ${failed} of ${passed + failed} simulated step(s).`,
    );

    if (failed > 0) {
      return this.tasks.transition(snapshot.taskId, 'testing', 'failed', {
        failureReason: `${failed} validation step(s) failed.`,
      });
    }

    if (workspace.simulated) {
      return this.tasks.transition(snapshot.taskId, 'testing', 'completed', {
        message: 'Validation passed. No repository is connected, so no commit was made.',
      });
    }

    return this.tasks.transition(snapshot.taskId, 'testing', 'committing');
  }

  /**
   * Runs the repository's own Odoo modules (ADR-027).
   *
   * Returns null when the runner declined - a series with no configured runtime,
   * a change touching no module - so the caller falls through to the simulated
   * path rather than failing a task for a reason the person cannot act on. The
   * reason is narrated either way, because "validation was skipped" without a
   * reason is worse than no validation.
   */
  private async validateForReal(
    snapshot: TaskExecutionSnapshot,
    workspace: Workspace,
  ): Promise<boolean | null> {
    // git is the authority on what changed here too. The plan is a statement of
    // intent; the modules to install are the ones actually touched.
    const diff = await this.git.diff(workspace.repositoryPath, workspace.baseCommit ?? 'HEAD');
    const modules = changedModules(diff.files.map((file) => file.path));

    const outcome = await this.validation.run({
      taskReference: snapshot.reference,
      attempt: 1,
      repositoryPath: workspace.repositoryPath,
      metadataPath: workspace.metadataPath,
      odooVersion: workspace.odooVersion ?? snapshot.odooVersion,
      modules,
    });

    if (!outcome.ran) {
      await this.narrate(snapshot, outcome.skippedReason ?? 'Validation was skipped.');
      return null;
    }

    const results: TaskTestResults = outcome.results ?? {
      passed: 0,
      failed: 1,
      skipped: 0,
      suites: [],
      simulated: false,
    };

    await this.tasks.saveTestResults(snapshot.taskId, results);

    await this.narrate(
      snapshot,
      results.failed === 0
        ? `Validation passed on ${outcome.runtime}: ${results.passed} test(s) in ` +
          `${modules.join(', ')}, in ${Math.round(outcome.durationMs / 1000)}s.`
        : `Validation failed on ${outcome.runtime}: ${results.failed} failure(s)` +
          (outcome.fatal ? `. The run stopped early: ${outcome.fatal}` : '.'),
    );

    if (results.failed > 0) {
      return this.tasks.transition(snapshot.taskId, 'testing', 'failed', {
        failureReason:
          outcome.fatal ??
          `${results.failed} test(s) failed when the change was run against ${outcome.runtime}.`,
      });
    }

    return this.tasks.transition(snapshot.taskId, 'testing', 'committing');
  }

  /** COMMITTING. Commits locally, then requests approval for the push. */
  private async commit(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    const workspace = await this.acquireWorkspace(snapshot);
    const message = commitMessageFor(snapshot);

    const result = await this.callTool(snapshot, workspace, 'git_commit', { message });

    if (result.status === 'suspended') return false;
    if (result.status !== 'succeeded') {
      return this.tasks.transition(snapshot.taskId, 'committing', 'failed', {
        failureReason: 'The commit could not be created.',
      });
    }

    const commit = await this.git.revParse(workspace.repositoryPath, 'HEAD');
    await this.tasks.saveCommitHash(snapshot.taskId, commit);
    await this.narrate(snapshot, `Committed ${commit.slice(0, 8)} on ${workspace.branch}.`);

    // On-premise pushes to the remote the selected repository already carries,
    // rather than to a URL the platform cloned from (ADR-028). It reaches the same
    // approval gate as every other mode: the commit is local until a person says
    // it may leave.
    const onPremise = snapshot.executionMode === 'on_premise';

    if (snapshot.grantedApprovals.includes('git_push')) {
      return this.tasks.transition(snapshot.taskId, 'committing', 'pushing');
    }

    // With pushing disabled at the process layer, asking for push approval would
    // be asking a person to authorise something the platform cannot do (ADR-021
    // s1). An approval that cannot lead to the act it names teaches people that
    // approvals are decoration, so the task completes instead and says why.
    if (!this.config.git.pushEnabled) {
      // Where the commit now sits differs by mode, and saying it wrongly sends
      // somebody looking in the wrong place: on-premise committed in the
      // directory they selected, every other mode in a workspace the platform
      // will destroy.
      const where = onPremise
        ? 'the commit stays in the selected local directory'
        : 'the branch stays in the workspace';

      await this.narrate(
        snapshot,
        `Committed on ${workspace.branch}. Pushing is disabled on this server ` +
          `(GIT_PUSH_ENABLED=false), so ${where} and the ` +
          'diff is on the task. Review it there, or ask an operator to enable ' +
          'pushing if this platform should write to the repository.',
      );

      return this.tasks.transition(snapshot.taskId, 'committing', 'completed', {
        message:
          `Commit ${commit.slice(0, 8)} is ready on ${workspace.branch}. Pushing is disabled ` +
          'on this server, so nothing was sent to the repository.',
      });
    }

    await this.approvals.request({
      taskId: snapshot.taskId,
      taskReference: snapshot.reference,
        organizationId: snapshot.organizationId,
      action: 'git_push',
      requiredReason:
        'Pushing the branch sends the change to the connected repository, outside the platform.',
      context: {
        branch: workspace.branch,
        commit: commit.slice(0, 12),
        baseBranch: workspace.baseBranch,
        commitMessage: message.split('\n')[0],
      },
      taskStatus: 'committing',
    });

    return this.tasks.transition(snapshot.taskId, 'committing', 'waiting_approval', {
      message: 'The push is awaiting approval.',
    });
  }

  /** PUSHING. Real once GIT_PUSH_ENABLED=true; refused at the process layer otherwise. */
  private async push(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    const workspace = await this.acquireWorkspace(snapshot);
    const result = await this.callTool(snapshot, workspace, 'git_push', {});

    if (result.status === 'suspended') return false;
    if (result.status !== 'succeeded') {
      return this.tasks.transition(snapshot.taskId, 'pushing', 'failed', {
        failureReason: 'The push did not complete.',
      });
    }

    await this.narrate(snapshot, `Pushed ${workspace.branch} to the remote repository.`);

    return this.tasks.transition(snapshot.taskId, 'pushing', 'completed', {
      message: `Branch ${workspace.branch} was pushed to the remote repository.`,
    });
  }

  // -------------------------------------------------------------------------
  // Model support
  // -------------------------------------------------------------------------

  /**
   * The tools this project grants, by name.
   *
   * Named in the system prompt so the model knows what it can do. It is not what
   * enforces the limit - the permission validator does that on every call - but a
   * model told the truth about its tools wastes less of its budget discovering it.
   */
  private grantedToolNames(snapshot: TaskExecutionSnapshot): string[] {
    return this.registry
      .all()
      .filter((tool) => tool.availableToModel)
      .filter((tool) => toolAllowedInMode(tool, snapshot.executionMode))
      .filter((tool) => snapshot.agentPermissions[tool.permission] === true)
      .map((tool) => tool.name);
  }

  /**
   * Reads the files a search matched, ordered by how they relate to the model.
   *
   * The ordering is the point (ADR-025). Search results arrive in the order the
   * walker found them, and a text search cannot distinguish a file that extends
   * `sale.order` from one that mentions it in a comment. On a real repository that
   * put a dashboard file first and a plan targeted it, while the module that
   * actually extends the model went unread.
   *
   * More paths are read than are sent, because ranking requires reading: a file
   * cannot be judged on its name. The read is bounded so a broad search cannot
   * turn into reading the repository.
   */
  private async gatherCandidates(
    workspace: Workspace,
    matches: readonly CodeSearchMatch[],
    targetModel: string,
  ): Promise<{
    excerpts: { path: string; content: string }[];
    ranked: { path: string; relevance: ModelRelevance }[];
  }> {
    const paths = [...new Set(matches.map((match) => match.path))].slice(0, CANDIDATES_TO_RANK);

    const sources: { path: string; source: string }[] = [];
    for (const path of paths) {
      const source = await readFile(join(workspace.repositoryPath, path), 'utf8').catch(() => null);
      if (source !== null) sources.push({ path, source });
    }

    const ranked = rankCandidates(sources, targetModel);
    const limit = this.config.limits.readFileMaxBytes;

    const excerpts = ranked.slice(0, EXCERPTS_TO_SEND).map((candidate) => {
      const source = sources.find((entry) => entry.path === candidate.path)?.source ?? '';
      return {
        path: candidate.path,
        content:
          source.length > limit
            ? `${source.slice(0, limit)}
... truncated at ${limit} bytes ...`
            : source,
      };
    });

    return { excerpts, ranked };
  }

  /**
   * Fails a task on a model or boundary error, with a message the user can act on.
   *
   * A boundary refusal is distinguished from a provider failure because they call
   * for different responses: the first means the repository contains something that
   * must not be sent, which is a decision for a person; the second means the
   * provider was unavailable, which is worth retrying.
   */
  private async failOnModelError(
    snapshot: TaskExecutionSnapshot,
    from: AgentTaskStatus,
    operation: 'planning' | 'implementation' | 'chat',
    error: unknown,
  ): Promise<boolean> {
    const boundaryRefusal = error instanceof AiBoundaryRefusalError;
    const providerError = error instanceof ModelProviderError;

    const reason = boundaryRefusal
      ? `The AI data boundary refused to send material to the provider: ${error.reason}. ` +
        'Chapter 12 forbids sending customer data to an AI provider.'
      : providerError
        ? `${error.message}${error.retryable ? ' This is usually transient; submitting the task again may succeed.' : ''}`
        : `The ${operation} step failed: ${(error as Error).message}`;

    // The provider that actually failed, not the environment's. A
    // ModelProviderError names its own provider; anything else did not reach one.
    const attemptedProvider =
      error instanceof ModelProviderError ? error.provider : this.config.ai.provider;

    await this.modelCalls.record({
      taskId: snapshot.taskId,
      organizationId: snapshot.organizationId,
      operation,
      providerId: attemptedProvider,
      model: this.config.ai.model,
      calledExternalService: attemptedProvider !== 'mock',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      steps: 0,
      boundaryFindings: boundaryRefusal ? error.findings : [],
      redactionCount: 0,
      boundaryRefused: boundaryRefusal,
      failureReason: reason,
    });

    await this.narrate(snapshot, reason);
    this.logger.error(`${snapshot.reference} failed during ${operation}: ${reason}`);

    return this.tasks.transition(snapshot.taskId, from, 'failed', { failureReason: reason });
  }

  // -------------------------------------------------------------------------
  // Workspace lifecycle
  // -------------------------------------------------------------------------

  /**
   * Returns the workspace for this run, provisioning it on first use.
   *
   * A run may enter at any step, so every step asks for the workspace rather than
   * assuming an earlier step created it. Within one run it is provisioned once.
   */
  private async acquireWorkspace(snapshot: TaskExecutionSnapshot): Promise<Workspace> {
    const existing = this.workspaces.get(snapshot.taskId);
    if (existing) return existing;

    const workspace = await this.workspaceManager.allocate({
      taskId: snapshot.taskId,
      taskReference: snapshot.reference,
        organizationId: snapshot.organizationId,
      projectId: snapshot.projectId,
      repositoryUrl: snapshot.repositoryUrl,
      // The environment's branch, not the repository's default. The target is a
      // choice; the default branch is a fact about the repository (ADR-021).
      defaultBranch: snapshot.targetBranch,
      odooVersion: snapshot.odooVersion,
      prompt: snapshot.prompt,
      credentialRef: snapshot.credentialRef,
      credentialKind: snapshot.credentialKind,
      sshHostKey: snapshot.sshHostKey,
      executionMode: snapshot.executionMode,
      onPremiseProjectPath: snapshot.onPremiseProjectPath,
      baseCommit: snapshot.baseCommit,
    });

    this.workspaces.set(snapshot.taskId, workspace);
    return workspace;
  }

  /**
   * Releases the workspace held for a task, if any.
   *
   * A workspace holds customer source code, so it is removed as soon as the run
   * ends - whether the task settled, suspended at an approval, or yielded. A
   * resumption re-clones, which costs a few seconds and is the right trade against
   * leaving clones on disk for the duration of a human wait.
   */
  private async releaseWorkspace(taskId: string, status: AgentTaskStatus): Promise<void> {
    const workspace = this.workspaces.get(taskId);
    if (!workspace) return;

    this.workspaces.delete(taskId);
    await this.workspaceManager.release(workspace, status === 'failed' ? 'failed' : 'completed');
  }

  // -------------------------------------------------------------------------
  // Step helpers
  // -------------------------------------------------------------------------

  /** Runs the prompt's search terms and returns the combined matches. */
  private async gatherSearchMatches(
    workspace: Workspace,
    prompt: string,
  ): Promise<CodeSearchMatch[]> {
    const { searchCode } = await import('../analysis/code-search');
    const matches: CodeSearchMatch[] = [];

    for (const term of searchTermsFor(prompt)) {
      const result = await searchCode(workspace.repositoryPath, term, {
        maxResults: this.config.limits.searchMaxResults,
        maxFileBytes: this.config.limits.searchMaxFileBytes,
      });
      matches.push(...result.matches);
    }

    return matches;
  }

  /**
   * Issues a tool request through the mediated execution path.
   *
   * `suspended` is returned when the tool needs an approval that has not been
   * granted: the task moves to waiting_approval and the caller stops. This is the
   * only place ApprovalRequiredError is handled, so every tool in every step
   * suspends the same way.
   */
  private async callTool(
    snapshot: TaskExecutionSnapshot,
    workspace: Workspace,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{
    status: 'succeeded' | 'failed' | 'denied' | 'suspended';
    output: Record<string, unknown>;
  }> {
    const context: ToolExecutionContext = {
      taskId: snapshot.taskId,
      taskReference: snapshot.reference,
      projectId: snapshot.projectId,
        organizationId: snapshot.organizationId,
      executionMode: snapshot.executionMode,
      workspace: {
        workspaceId: workspace.workspaceId,
        repositoryPath: workspace.repositoryPath,
        branch: workspace.branch,
        baseBranch: workspace.baseBranch,
        baseCommit: workspace.baseCommit,
        repositoryUrl: workspace.repositoryUrl,
        odooVersion: workspace.odooVersion,
        simulated: workspace.simulated,
        readOnlyRoots: workspace.readOnlyRoots,
        metadataPath: workspace.metadataPath,
        credentialRef: workspace.credentialRef,
        credentialKind: workspace.credentialKind,
        sshHostKey: workspace.sshHostKey,
      },
    };

    try {
      const result = await this.tools.execute({
        toolName,
        input,
        context,
        policy: {
          agentPermissions: snapshot.agentPermissions,
          grantedApprovals: snapshot.grantedApprovals,
          executionMode: snapshot.executionMode,
          taskKind: snapshot.kind,
        },
        taskStatus: snapshot.status,
      });

      return {
        status: result.status,
        // The output has already been through the audit redaction filter, and it
        // passes the AI data boundary before it reaches a model.
        output: result.output ?? {},
      };
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        await this.approvals.request({
          taskId: snapshot.taskId,
          taskReference: snapshot.reference,
          organizationId: snapshot.organizationId,
          action: error.approvalAction,
          requiredReason: error.reason,
          context: { toolName: error.toolName, branch: workspace.branch, path: input.path },
          taskStatus: snapshot.status,
        });

        await this.tasks.transition(snapshot.taskId, snapshot.status, 'waiting_approval', {
          message: `${error.toolName} is awaiting approval.`,
        });

        return { status: 'suspended', output: {} };
      }
      throw error;
    }
  }

  private async narrate(snapshot: TaskExecutionSnapshot, message: string): Promise<void> {
    await this.tasks.appendReasoning(snapshot.taskId, snapshot.reference, snapshot.status, message);
  }

  /**
   * Observes cancellation between steps. The status is re-read rather than taken
   * from the snapshot, because a cancellation may have landed while the previous
   * step was running.
   */
  private async shouldStop(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    const current = await this.tasks.currentStatus(snapshot.taskId);
    if (current !== snapshot.status) {
      this.logger.log(
        `Task ${snapshot.reference} changed from ${snapshot.status} to ${current} while running; yielding.`,
      );
      return true;
    }
    return false;
  }

  /**
   * Paces the workflow so the activity stream is legible in the interface. Real
   * work - a clone, a search over a large tree - takes its own time and is not
   * padded; this only spaces the steps that would otherwise complete instantly.
   * Set AGENT_STEP_DELAY_MS to 0 to remove it, which is what the tests do.
   */
  private async pause(): Promise<void> {
    const delay = this.config.agent.stepDelayMs;
    if (delay <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /** The capability categories that were simulated, recorded on the task. */
  simulatedCapabilities(): readonly string[] {
    return this.registry.simulatedCapabilities();
  }
}

/**
 * Commit message for a task. Prefixed and attributed, so a reviewer reading the
 * repository history can tell which change the platform made and which task to
 * look up.
 */
function commitMessageFor(snapshot: TaskExecutionSnapshot): string {
  const subject = snapshot.prompt.split(/\r?\n/)[0].slice(0, 68).trim();
  return [
    `[LinkedERP AI] ${subject}`,
    '',
    `Task: ${snapshot.reference}`,
    `Project: ${snapshot.projectName}`,
    '',
    'Produced by the LinkedERP AI Development Agent and approved by a human',
    'reviewer before the change was written.',
  ].join('\n');
}

/**
 * Maps the workflow's tool status to the loop's.
 *
 * `suspended` becomes `approval_required` because the two names describe the same
 * event from different sides: the workflow has suspended the task, and what the
 * model needs to know is that its call needs a person.
 */
function toLoopResult(status: 'succeeded' | 'failed' | 'denied' | 'suspended'): LoopToolResult {
  return status === 'suspended' ? 'approval_required' : status;
}

function humanise(value: string): string {
  return value.replace(/_/g, ' ');
}

/**
 * Whether a tool may be offered or executed in the given mode (ADR-028).
 *
 * Mirrors the enforcement in the permission validator, but here it decides what
 * the model is told about rather than what runs: a model told the truth about its
 * tools wastes less of its budget discovering it. The two must not diverge.
 */
function toolAllowedInMode(tool: AnyToolDefinition, mode: ExecutionMode | null): boolean {
  if (tool.modes === undefined) return true;
  return mode !== null && tool.modes.includes(mode);
}

/** Re-exported so the worker can narrow on the status union. */
export type { AgentTaskStatus };

/**
 * The Odoo Online tools that change the instance, as opposed to reading it.
 *
 * The implementation step counts these rather than trusting the model's summary,
 * which is the same rule the repository modes apply by trusting `git diff`.
 */
const CHANGING_ODOO_TOOLS = ['odoo_create_field', 'odoo_add_field_to_view'];

/** One applied change, in the terms a reviewer reads in the activity log. */
function describeOdooChange(toolName: string, output: Record<string, unknown>): string {
  if (toolName === 'odoo_create_field') {
    return `Created field ${String(output.field)} on ${String(output.model)} (id ${String(output.fieldId)}).`;
  }
  return (
    `Placed ${String(output.field)} after ${String(output.after)} on the ${String(output.model)} ` +
    `form view (inherited view id ${String(output.viewId)}).`
  );
}
