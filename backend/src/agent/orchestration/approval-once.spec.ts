import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canTransition, permittedTransitionsFrom } from '../task-state';

/**
 * One push, one approval - and a push that is only reported as delivered when it
 * actually was.
 *
 * This exists because of a defect with two faces, both observed on a real
 * deployment.
 *
 * **The prompt appeared twice or three times for one push.** The workflow decided
 * that a development push needed no approval (GIT_AUTO_PUSH_ON_TASK=true) and
 * moved the task to `pushing`. The tool gate guarding every operation that leaves
 * the platform reads approval *rows*, found no `git_push` row, and refused the
 * push the workflow had just authorised. Suspending from `pushing` was illegal,
 * so the throw killed the job and BullMQ retried it; each retry asked again. The
 * operator approved the same push three times and was told the task had failed.
 *
 * **A commit was reported as pushed and was never on the remote.** The commit was
 * made in the first job's workspace. That job died, the workspace was released,
 * and the resumption cloned the remote afresh - a tree without the commit - so
 * `git push` sent nothing, exited 0 because the branch was already up to date,
 * and the task completed saying "Branch pushed to the remote repository". The
 * only way to tell that apart from a real delivery is to read the remote back,
 * which is what `git_push` now does.
 *
 * The sources are read rather than the workflow run, because both failures live
 * in the ordering of a handful of statements around a queue job that no unit test
 * here constructs.
 */
describe('a push is approved once and verified before it is reported', () => {
  const read = (relativePath: string): string =>
    readFileSync(join(__dirname, '..', relativePath), 'utf8');

  const workflow = read('orchestration/agent-workflow.ts');
  const approvals = readFileSync(
    join(__dirname, '..', '..', 'modules', 'approvals', 'approval.service.ts'),
    'utf8',
  );

  describe('the approval the deployment grants itself', () => {
    it('is recorded before the task leaves committing, not after', () => {
      // Ordering is the whole fix: the gate reads the row when the push runs. A
      // grant written afterwards authorises nothing. The transition searched for
      // is the one inside the auto-push branch - the one guarded by a granted
      // approval returns earlier and is not the edge this concerns.
      const grantIndex = workflow.indexOf('await this.approvals.autoGrant({');
      const transitionIndex = workflow.indexOf(
        "this.tasks.transition(snapshot.taskId, 'committing', 'pushing')",
        grantIndex,
      );

      expect(grantIndex).toBeGreaterThan(-1);
      expect(transitionIndex).toBeGreaterThan(-1);
      expect(grantIndex).toBeLessThan(transitionIndex);
    });

    it('names what authorised it, so the record answers "who approved this"', () => {
      expect(workflow).toMatch(/authorisedBy: 'GIT_AUTO_PUSH_ON_TASK=true'/);
    });

    it('is written as an approved row, not as a bypass only the validator sees', () => {
      const block = approvals.slice(approvals.indexOf('async autoGrant('));
      expect(block).toMatch(/status: 'approved'/);
      expect(block).toMatch(/decidedAt: now/);
      expect(block).toMatch(/AUDIT_EVENTS\.APPROVAL_GRANTED/);
    });

    it('does not grant again when the action is already approved or pending', () => {
      const block = approvals.slice(approvals.indexOf('async autoGrant('));
      expect(block).toMatch(/inArray\(approvals\.status, \['pending', 'approved'\]\)/);
      expect(block).toMatch(/already \$\{existing\.status\}/);
    });
  });

  describe('a request made twice for one action', () => {
    it('is de-duplicated against an approval that was already granted', () => {
      // The old check looked only for a *pending* row, so once a push was
      // approved the next request inserted a second row for the same push.
      const block = approvals.slice(approvals.indexOf('async request('));
      const dedupe = block.slice(0, block.indexOf('onConflictDoNothing'));
      expect(dedupe).toMatch(/inArray\(approvals\.status, \['pending', 'approved'\]\)/);
    });

    it('still allows a rejected action to be asked for again', () => {
      // A rejection is not an authorisation, so it must not be de-duplicated.
      const block = approvals.slice(approvals.indexOf('async request('));
      const dedupe = block.slice(0, block.indexOf('onConflictDoNothing'));
      expect(dedupe).not.toMatch(/'rejected'/);
    });
  });

  describe('the resumption queue', () => {
    it('derives the job id from the decision, not the clock', () => {
      const orchestrator = read('orchestration/queue-agent-orchestrator.ts');
      expect(orchestrator).toMatch(/jobId: `resume-\$\{taskId\}-\$\{reason\}-\$\{approvalId\}`/);
      expect(orchestrator).not.toMatch(/resume-\$\{taskId\}-\$\{reason\}-\$\{Date\.now\(\)\}/);
    });

    it('is told which approval was decided', () => {
      expect(approvals).toMatch(/pending\.id,\s*\n\s*\);/);
      expect(read('orchestration/agent-orchestrator.interface.ts')).toMatch(
        /resume\(taskId: string, reason: ResumeReason, approvalId: string\)/,
      );
    });
  });

  describe('the push tool', () => {
    const tools = read('tools/real/git.tools.ts');

    it('reads the remote branch back after pushing', () => {
      expect(tools).toMatch(/remoteBranchCommit\(/);
    });

    it('fails when the branch is absent from the remote', () => {
      expect(tools).toMatch(/does not exist/);
      expect(tools).toMatch(/Nothing was delivered\./);
    });

    it('fails when the workspace does not hold the commit the task recorded', () => {
      // Without this a re-cloned workspace is indistinguishable from a working
      // one: both have the same HEAD, and both push and exit 0.
      expect(tools).toMatch(/input\.commit && input\.commit !== head/);
      expect(tools).toMatch(/is not the one that holds this/);
      expect(tools).toMatch(/would deliver nothing/);
    });

    it('is given the commit the task recorded', () => {
      expect(workflow).toMatch(/commit: snapshot\.commitHash/);
    });

    it('fails when the remote is at a different commit than this task made', () => {
      expect(tools).toMatch(/remoteCommit !== head/);
      expect(tools).toMatch(/not the commit this task made/);
    });

    it('accepts only when the remote tip is the commit this task made', () => {
      expect(tools).toMatch(/remoteCommit,/);
      expect(tools).toMatch(/verified: true/);
    });
  });

  describe('the workspace holding an unpushed commit', () => {
    it('is kept while the task is between states', () => {
      const releaseBlock = workflow.slice(workflow.indexOf('private async releaseWorkspace('));
      expect(releaseBlock).toMatch(/if \(!isTerminalStatus\(status\)\)/);
      expect(releaseBlock).toMatch(/kept for \$\{taskId\}/);
    });

    it('is released once the task has settled', () => {
      const releaseBlock = workflow.slice(workflow.indexOf('private async releaseWorkspace('));
      expect(releaseBlock).toMatch(
        /await this\.workspaceManager\.release\(workspace, status === 'failed'/,
      );
    });

    it('is reattached by the workspace manager rather than re-cloned', () => {
      const manager = read('workspace/workspace-manager.ts');
      expect(manager).toMatch(/const reattached = await this\.reattach\(input\)/);
      expect(manager).toMatch(/private async reattach\(/);
    });

    it('is reattached only when it still holds this task\'s commit', () => {
      const manager = read('workspace/workspace-manager.ts');
      expect(manager).toMatch(/input\.expectedCommit\)/);
      expect(manager).toMatch(/head !== input\.expectedCommit/);
    });

    it('is told which commit to expect', () => {
      expect(workflow).toMatch(/expectedCommit: snapshot\.commitHash/);
      expect(read('task-repository.ts')).toMatch(/readonly commitHash: string \| null/);
    });
  });

  describe('the state table', () => {
    it('permits suspending out of pushing, so a gate refusal is not fatal', () => {
      // Refusing this edge never prevented the suspension - it only made it kill
      // the job, and hid the workflow/gate disagreement behind a crash.
      expect(canTransition('pushing', 'waiting_approval')).toBe(true);
    });

    it('is reachable from pushing only by a state that can resume the push', () => {
      expect(permittedTransitionsFrom('waiting_approval')).toContain('pushing');
    });

    it('still leaves pushing able to settle', () => {
      expect(canTransition('pushing', 'completed')).toBe(true);
      expect(canTransition('pushing', 'failed')).toBe(true);
      expect(canTransition('pushing', 'building')).toBe(true);
    });
  });

  describe('the failure message', () => {
    it('carries the tool\'s own explanation rather than a generic sentence', () => {
      // "The push did not complete." alone is what kept a lost commit invisible:
      // the reason the verification failed never reached the task record.
      const pushBlock = workflow.slice(workflow.indexOf('private async push('));
      expect(pushBlock).toMatch(/const detail =/);
      expect(pushBlock).toMatch(/The push did not complete\.\$\{detail\}/);
    });

    it('names the verified commit when the push succeeded', () => {
      const pushBlock = workflow.slice(workflow.indexOf('private async push('));
      expect(pushBlock).toMatch(/verified at commit \$\{commit\}/);
      expect(pushBlock).toMatch(/at commit \$\{commit\}\./);
    });
  });
});
