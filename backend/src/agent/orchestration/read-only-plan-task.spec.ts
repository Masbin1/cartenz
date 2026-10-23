import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An inspection request - "check whether this was pushed", "what is on
 * Staging?" - is carried out by reading, and its deliverable is the answer. The
 * plan for it names no file, so the implementation run leaves the working tree
 * exactly as it found it.
 *
 * That used to be reported as
 * `The agent reported completion but made no change to the working tree.` - the
 * correct rule for a plan that DID name files, applied to a plan that never
 * promised a change. A person reads that as the platform failing a request it
 * had just answered correctly, which is what task_679338 showed: a correct
 * Indonesian summary on the task, and a failure banner over it.
 *
 * Asserted against the source, as `git-pull-task.spec.ts` and
 * `empty-and-denied-outcome.spec.ts` do, because the gate lives inside the
 * private `implement` method and no unit test here builds the whole workflow.
 */
describe('a read-only plan', () => {
  const read = (relativePath: string): string =>
    readFileSync(join(__dirname, '..', relativePath), 'utf8');

  const workflow = read('orchestration/agent-workflow.ts');

  /** The no-change gate: from the pull branch to the end of `implement`. */
  const gate = (): string => {
    const start = workflow.indexOf('if (outcome.pulled)');
    const end = workflow.indexOf('await this.callTool(snapshot, workspace, \'git_diff\', {})', start);
    return workflow.slice(start, end);
  };

  describe('is recognised from the plan, not from the diff', () => {
    it('reads the approved plan\'s file count', () => {
      expect(workflow).toMatch(/snapshot\.plan\?\.filesToModify\.length/);
      expect(workflow).toMatch(/const readOnlyPlan = planFiles === 0;/);
    });

    it('does not treat an absent plan as a read-only one', () => {
      // `undefined === 0` is false, which is the whole reason the assertion is
      // written that way: a change task whose plan is missing keeps the strict
      // rule rather than gaining a pass.
      const declaration = workflow.slice(workflow.indexOf('const planFiles'));
      expect(declaration.slice(0, 200)).toMatch(/planFiles === 0/);
      expect(declaration.slice(0, 200)).not.toMatch(/!snapshot\.plan\b/);
    });
  });

  describe('completes with its answer instead of failing', () => {
    /** The read-only branch alone: up to the strict failure that follows it. */
    const readOnlyBranch = (): string => {
      const block = gate();
      const start = block.indexOf('if (readOnlyPlan)');
      const end = block.indexOf('The agent reported completion but made no change', start);
      return block.slice(start, end);
    };

    it('reaches testing through the read-only branch', () => {
      const branch = readOnlyBranch();

      expect(branch).toMatch(/if \(readOnlyPlan\)/);
      expect(branch).toMatch(/'implementing', 'testing'/);
      expect(branch).toMatch(/named no file to change/);
    });

    it('still fails when the run produced no answer at all', () => {
      const branch = readOnlyBranch();
      const beforeTesting = branch.slice(0, branch.indexOf("'implementing', 'testing'"));

      expect(beforeTesting).toMatch(/produced no answer/);
    });

    it('keeps the answer on the task, so the finding survives the workspace', () => {
      // The workspace is destroyed when the run ends: an answer not saved is
      // an answer lost, which is the same defect the chat branch guards.
      expect(workflow).toMatch(/saveAnswer\(snapshot\.taskId, summary\)/);
      expect(workflow).toMatch(/modified\.length > 0 \|\| outcome\.pulled \|\| readOnlyPlan/);
    });
  });

  describe('does not weaken the rule it sits beside', () => {
    it('still fails a plan that named files and changed none', () => {
      expect(workflow).toContain(
        'The agent reported completion but made no change to the working tree.',
      );
      // The failure has to sit after the read-only branch, or it would be
      // unreachable for the case it exists to catch.
      expect(gate().indexOf('if (readOnlyPlan)')).toBeLessThan(
        gate().indexOf('The agent reported completion but made no change'),
      );
    });
  });

  describe('the prompts that produce and carry out such a plan', () => {
    const planner = read('orchestration/model-agent-planner.ts');
    const loop = read('orchestration/model-implementation-loop.ts');

    it('tells the planner an information request names no file', () => {
      expect(planner).toMatch(/asks for information rather than a code change/);
      expect(planner).toMatch(/filesToModify MUST also be an empty list/);
    });

    it('tells the implementing model that its summary is the deliverable there', () => {
      expect(loop).toMatch(/it is a pull or an/);
      expect(loop).toMatch(/inspection, and the summary you end with IS the deliverable/);
    });
  });
});
