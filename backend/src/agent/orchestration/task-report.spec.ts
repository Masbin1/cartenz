import { composeTaskReport, reportFactsFromTask, reportLanguage, type TaskReportFacts } from './task-report';

/**
 * ADR-081: the pure composer behind the thread's reply.
 *
 * Everything a person is told is derived from what the task recorded - git's
 * file list, the commit, the validation result, the status it settled from - so
 * these tests pin that a claim appears only when the fact behind it exists.
 */
function facts(overrides: Partial<TaskReportFacts> = {}): TaskReportFacts {
  return {
    kind: 'change',
    prompt: 'Add a delivery note field to stock.picking',
    body: 'Added `delivery_note` to `stock.picking` and placed it on the form view.',
    planSummary: 'Add delivery_note to stock.picking',
    files: [
      {
        path: 'omnisurge_warehouse_mod/models/stock_picking.py',
        change: 'modified',
        summary: 'Add the delivery_note field',
        linesAdded: 4,
        linesRemoved: 0,
      },
      {
        path: 'omnisurge_warehouse_mod/views/stock_picking_views.xml',
        change: 'modified',
        summary: 'Changed while carrying out the approved plan',
        linesAdded: 3,
        linesRemoved: 1,
      },
    ],
    linesAdded: 7,
    linesRemoved: 1,
    pull: null,
    tests: { passed: 1, failed: 0, simulated: true },
    commitHash: '4e389b494ac6f2fc97af272ea4c8b4edf698ef02',
    branch: 'Staging',
    ...overrides,
  };
}

describe('reportLanguage', () => {
  it('reads an Indonesian request as Indonesian', () => {
    expect(reportLanguage('tolong buatkan field baru di stock picking dong')).toBe('id');
  });

  it('reads an English request as English', () => {
    expect(reportLanguage('Please add a delivery note field to the picking form')).toBe('en');
  });

  it('defaults to Indonesian when it cannot tell, like the model instructions do', () => {
    expect(reportLanguage('stock.picking delivery_note')).toBe('id');
  });
});

describe('composeTaskReport (ADR-081)', () => {
  it('leads with the model report, then the files git changed, then the outcome', () => {
    const report = composeTaskReport(facts(), {
      outcome: 'completed',
      from: 'pushing',
      message: 'Branch Staging was pushed to the remote repository at commit 4e389b49.',
      failureReason: null,
    })!;

    const body = report.indexOf('Added `delivery_note`');
    const files = report.indexOf('stock_picking.py');
    const outcome = report.indexOf('pushed to `Staging`');
    expect(body).toBeGreaterThanOrEqual(0);
    expect(files).toBeGreaterThan(body);
    expect(outcome).toBeGreaterThan(files);
    expect(report).toContain('`4e389b49`');
    expect(report).toContain('+7/−1');
  });

  it('keeps a planned reason for a file and drops the generic placeholder', () => {
    const report = composeTaskReport(facts(), {
      outcome: 'completed',
      from: 'pushing',
      message: null,
      failureReason: null,
    })!;

    expect(report).toContain('Add the delivery_note field');
    expect(report).not.toContain('Changed while carrying out the approved plan');
  });

  it('says plainly that simulated validation is not evidence', () => {
    const report = composeTaskReport(facts(), {
      outcome: 'completed',
      from: 'pushing',
      message: null,
      failureReason: null,
    })!;

    expect(report).toContain('simulated');
    expect(report).toContain('not evidence');
  });

  it('never claims a push when the task did not settle from the push step', () => {
    const report = composeTaskReport(facts(), {
      outcome: 'completed',
      from: 'committing',
      message: 'Commit 4e389b49 is ready on Staging. Pushing is disabled on this server, so nothing was sent to the repository.',
      failureReason: null,
    })!;

    expect(report).toContain('was not pushed');
    expect(report).toContain('GIT_PUSH_ENABLED=false');
    expect(report).not.toContain('was pushed to');
  });

  it('says where the work is when the push failed after the commit', () => {
    const report = composeTaskReport(facts(), {
      outcome: 'failed',
      from: 'pushing',
      message: null,
      failureReason:
        "The push did not complete. git push failed (exit 1): Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.\r\n" +
        '! [rejected]        Staging -> Staging (non-fast-forward)\n' +
        'hint: Updates were rejected because the tip of your current branch is behind',
    })!;

    expect(report).toContain('**Failed** at the push step.');
    expect(report).toContain('`4e389b49`');
    expect(report).toContain('did not reach the remote');
    expect(report).toContain('non-fast-forward');
    expect(report).not.toContain('Permanently added');
    expect(report).not.toContain('\r');
  });

  it('reports a failure before any change with the stage and the reason only', () => {
    const report = composeTaskReport(
      facts({ body: null, files: [], commitHash: null, tests: null, linesAdded: null, linesRemoved: null }),
      {
        outcome: 'failed',
        from: 'implementing',
        message: null,
        failureReason: 'The agent reported completion but made no change to the working tree.',
      },
    )!;

    expect(report).toContain('Add delivery_note to stock.picking');
    expect(report).toContain('**Failed** at the implementation step.');
    expect(report).toContain('made no change to the working tree');
    expect(report).not.toContain('Files changed');
  });

  it('falls back to the plan summary when the model reported nothing', () => {
    const report = composeTaskReport(facts({ body: null }), {
      outcome: 'completed',
      from: 'pushing',
      message: null,
      failureReason: null,
    })!;

    expect(report).toContain('**Plan carried out**: Add delivery_note to stock.picking');
  });

  it('returns a plain chat answer exactly as written', () => {
    const report = composeTaskReport(
      facts({ kind: 'chat', body: 'It adds a delivery note.', files: [], commitHash: null }),
      { outcome: 'completed', from: 'testing', message: 'Answered.', failureReason: null },
    );

    expect(report).toBe('It adds a delivery note.');
  });

  it('reports a pull-only request by what the pull did', () => {
    const report = composeTaskReport(
      facts({
        prompt: 'pull the latest changes',
        body: null,
        planSummary: null,
        files: [],
        commitHash: null,
        tests: null,
        pull: { outcome: 'fast_forwarded', branch: 'Staging', commits: 3 },
      }),
      { outcome: 'completed', from: 'testing', message: 'Pulled 3 commit(s) into Staging.', failureReason: null },
    )!;

    expect(report).toContain('pulled 3 commit(s) into `Staging`');
    expect(report).not.toContain('Files changed');
  });

  it('writes the platform lines in Indonesian for an Indonesian request', () => {
    const report = composeTaskReport(facts({ prompt: 'tolong tambahkan field delivery note dong' }), {
      outcome: 'completed',
      from: 'pushing',
      message: null,
      failureReason: null,
    })!;

    expect(report).toContain('**Perubahan file**');
    expect(report).toContain('sudah di-push ke `Staging`');
    expect(report).toContain('disimulasikan');
  });

  it('translates an Odoo Online settlement line instead of ending in English', () => {
    const report = composeTaskReport(
      facts({ prompt: 'tolong buatkan field PO number di sale order', files: [], commitHash: null, tests: null }),
      {
        outcome: 'completed',
        from: 'testing',
        message: 'The change was applied to the Odoo Online instance.',
        failureReason: null,
      },
    )!;

    expect(report).toContain('diterapkan ke instance Odoo Online');
    expect(report).not.toContain('The change was applied');
  });

  it('lists at most twenty files and counts the rest', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      path: `module/file_${index}.py`,
      change: 'added',
      summary: null,
      linesAdded: 1,
      linesRemoved: 0,
    }));

    const report = composeTaskReport(facts({ files: many }), {
      outcome: 'completed',
      from: 'pushing',
      message: null,
      failureReason: null,
    })!;

    expect(report).toContain('file_19.py');
    expect(report).not.toContain('file_20.py');
    expect(report).toContain('5 more files');
  });
});

describe('reportFactsFromTask', () => {
  it('reads a task row, tolerating older shapes in the jsonb columns', () => {
    const result = reportFactsFromTask({
      kind: 'change',
      prompt: 'x',
      answer: null,
      plan: { summary: 'Plan' },
      modifiedFiles: [{ path: 'a.py', linesAdded: 2 }, { nope: true }, 'garbage'],
      diffStats: { linesAdded: 2, linesRemoved: 0, pull: { outcome: 'up_to_date', branch: 'Staging' } },
      testResults: { passed: 1, failed: 0, simulated: true },
      commitHash: null,
      branch: 'Staging',
    });

    expect(result.files).toEqual([
      { path: 'a.py', change: 'modified', summary: null, linesAdded: 2, linesRemoved: 0 },
    ]);
    expect(result.planSummary).toBe('Plan');
    expect(result.pull).toEqual({ outcome: 'up_to_date', branch: 'Staging', commits: 0 });
    expect(result.tests).toEqual({ passed: 1, failed: 0, simulated: true });
  });

  it('treats missing jsonb as no facts rather than throwing', () => {
    const result = reportFactsFromTask({
      kind: 'chat',
      prompt: 'x',
      answer: 'hi',
      plan: null,
      modifiedFiles: null,
      diffStats: null,
      testResults: null,
      commitHash: null,
      branch: null,
    });

    expect(result.files).toEqual([]);
    expect(result.tests).toBeNull();
    expect(result.pull).toBeNull();
  });
});
