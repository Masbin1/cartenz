import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTestToolRegistry } from '../tools/test-registry';
import { ToolPermissionValidator } from '../tools/permission-validator';
import { implementationPlanSchema } from './plan-schema';

/**
 * "Pull the latest changes" has to work as a task, and it took three separate
 * defects to stop it:
 *
 * 1. There was no `git_pull` tool, so the model could only report that pulling
 *    was outside what it had.
 * 2. `filesToModify` required at least one entry, so the planner invented a
 *    placeholder file (`sale_target.py`) rather than plan an empty change set -
 *    which a person then approved and the implementation model correctly refused
 *    to write.
 * 3. The no-change gate in `implement` failed the task whenever the diff was
 *    empty, which is the correct outcome for a pull that found nothing new.
 *
 * Each is asserted where it lives, so removing any one of the three brings back a
 * task that cannot do what it was asked.
 */
describe('a pull-only task', () => {
  describe('the plan it produces', () => {
    const minimal = {
      summary: 'Update the working branch to match the remote, with no code changes.',
      odooVersion: '17.0',
      steps: [{ order: 1, title: 'Pull the branch', detail: 'Call git_pull for the current branch.' }],
      validation: ['run_linter'],
      risks: [],
    };

    it('may name no file to modify', () => {
      // The defect: `.min(1)` here forced a placeholder file into the plan.
      const result = implementationPlanSchema.safeParse({ ...minimal, filesToModify: [] });

      expect(result.success).toBe(true);
    });

    it('still refuses a file entry that is malformed', () => {
      // Relaxing the count must not relax the shape: an entry with no path is
      // still refused.
      const result = implementationPlanSchema.safeParse({
        ...minimal,
        filesToModify: [{ path: '', change: 'modified', reason: 'because' }],
      });

      expect(result.success).toBe(false);
    });

    it('is the same schema the planner validates its output against', () => {
      // `min(0)` has to be on the schema the planner actually uses, not only on
      // a copy of it: the planner imports this module.
      const planner = readFileSync(join(__dirname, 'model-agent-planner.ts'), 'utf8');

      expect(planner).toMatch(/from '\.\/plan-schema'/);
      expect(planner).toContain('implementationPlanSchema');
    });
  });

  describe('the tool the model is offered', () => {
    const registry = buildTestToolRegistry();
    const validator = new ToolPermissionValidator(registry);

    const policy = (taskKind: 'change' | 'chat', grantedApprovals: string[] = []) => ({
      agentPermissions: { repository_read: true, repository_write: true } as never,
      grantedApprovals,
      executionMode: 'on_premise' as const,
      taskKind,
    });

    it('is registered, real, and offered to the model in a change request', () => {
      const tool = registry.get('git_pull');

      expect(tool).toBeDefined();
      expect(tool?.simulated).toBe(false);
      expect(tool?.availableToModel).toBe(true);
      // Nothing leaves the platform: a fetch sends no repository content out,
      // and the branch only moves forward to a commit the remote already holds.
      expect(tool?.leavesPlatform).toBe(false);
    });

    it('requires repository_write, because the working tree does change', () => {
      expect(registry.get('git_pull')?.permission).toBe('repository_write');
    });

    it('is allowed in a change request with that permission granted', () => {
      const decision = validator.validate({ toolName: 'git_pull', input: {} }, policy('change'));

      expect(decision.outcome).toBe('allowed');
    });

    it('is refused in a chat, and needs no approval to be told so', () => {
      // A chat workspace is a throwaway clone whose changes are read back as the
      // chat's own writes: pulled commits would be mistaken for an approved edit.
      const decision = validator.validate({ toolName: 'git_pull', input: {} }, policy('chat'));

      expect(decision.outcome).toBe('denied');
      expect(decision.outcome === 'denied' && decision.reason).toContain('change request');
    });

    it('is not offered to the chat loop, so no budget is spent on a refusal', () => {
      const source = readFileSync(
        join(__dirname, 'model-chat-loop.ts'),
        'utf8',
      );

      expect(source).toMatch(/tool\.name !== 'git_pull'/);
    });
  });

  describe('the workflow that carries it out', () => {
    const workflow = readFileSync(join(__dirname, 'agent-workflow.ts'), 'utf8');
    const loop = readFileSync(join(__dirname, 'model-implementation-loop.ts'), 'utf8');
    const planner = readFileSync(join(__dirname, 'model-agent-planner.ts'), 'utf8');

    it('records a successful pull so the empty diff can be read correctly', () => {
      // Without this the gate below cannot tell a pull that found nothing new
      // from a model that did nothing at all.
      expect(loop).toMatch(/name === 'git_pull' && outcome\.status === 'succeeded'/);
      expect(loop).toMatch(/up_to_date/);
      expect(loop).toMatch(/fast_forwarded/);
    });

    it('completes the task on a successful pull instead of failing it', () => {
      const start = workflow.indexOf('if (outcome.pulled)');
      // The failure branch that follows the pull branch, so the slice is the
      // pull path and nothing else.
      const end = workflow.indexOf("'implementing', 'failed'", start);
      const gate = workflow.slice(start, end);

      // The pull branch must reach the repository lifecycle, not the failure
      // branch that comes after it.
      expect(gate).toMatch(/if \(outcome\.pulled\)/);
      expect(gate).toMatch(/'implementing', 'testing'/);
    });

    it('does not commit or push a pull that changed no file', () => {
      // The path out of the pull branch must not reach the commit stage.
      const start = workflow.indexOf('if (outcome.pulled)');
      const gate = workflow.slice(start, workflow.indexOf("'implementing', 'failed'", start));

      expect(gate).not.toMatch(/'committing'/);
    });

    it('still fails a task whose model changed nothing and pulled nothing', () => {
      // The guard this whole feature must not remove.
      expect(workflow).toContain(
        'The agent reported completion but made no change to the working tree.',
      );
    });

    it('completes rather than committing when there is nothing to commit', () => {
      const validate = workflow.slice(workflow.indexOf('private async validate('));
      expect(validate).toMatch(/status\.clean/);
      expect(validate).toMatch(/nothing to commit/);
    });

    it('tells the planner an empty file list is the honest answer', () => {
      expect(planner).toMatch(/filesToModify MUST be an empty list/);
      expect(planner).toMatch(/Never name a placeholder/);
    });

    it('tells the model a pull-first request starts with git_pull', () => {
      expect(loop).toMatch(/call git_pull FIRST/);
      expect(loop).toMatch(/up_to_date"?, nothing new existed|up_to_date/);
    });
  });
});
