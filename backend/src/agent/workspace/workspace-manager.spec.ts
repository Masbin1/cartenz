import { buildAiBranchName } from './workspace-manager';

/**
 * A branch name reaches a Git command line and appears in a customer repository,
 * so its construction is worth testing before anything can push one.
 */
describe('buildAiBranchName', () => {
  it('follows the documented format', () => {
    const branch = buildAiBranchName('task_9281', 'Fix the VAT rounding error on invoices');
    expect(branch.startsWith('ai/task_9281-')).toBe(true);
  });

  it('produces the documented example shape', () => {
    // Matches the documented example: ai/task-9281-vat-rounding-fix
    expect(buildAiBranchName('task_9281', 'VAT rounding fix')).toBe(
      'ai/task_9281-vat-rounding-fix',
    );
  });

  it('takes at most five words from the prompt', () => {
    const branch = buildAiBranchName(
      'task_1',
      'one two three four five six seven eight nine ten eleven',
    );
    const description = branch.replace('ai/task_1-', '');
    expect(description.split('-')).toHaveLength(5);
  });

  it('strips anything that is not safe in a branch name', () => {
    const branch = buildAiBranchName(
      'task_2',
      'Add field; rm -rf / && echo "done" $(whoami) `id` ../../escape',
    );
    expect(branch).toMatch(/^[A-Za-z0-9._/-]+$/);
    expect(branch).not.toContain('..');
    expect(branch).not.toContain(';');
    expect(branch).not.toContain('&');
    expect(branch).not.toContain('$');
  });

  it('never produces a name beginning with a hyphen', () => {
    for (const prompt of ['-- delete everything', '---', '- - -']) {
      const branch = buildAiBranchName('task_3', prompt);
      expect(branch.startsWith('ai/task_3')).toBe(true);
      expect(branch.replace('ai/', '').startsWith('-')).toBe(false);
    }
  });

  it('falls back to the reference alone when the prompt yields nothing usable', () => {
    expect(buildAiBranchName('task_4', '!!! ??? ...')).toBe('ai/task_4');
    expect(buildAiBranchName('task_4', '')).toBe('ai/task_4');
    // Words of two characters or fewer carry no meaning in a branch name.
    expect(buildAiBranchName('task_4', 'a an of')).toBe('ai/task_4');
  });

  it('bounds the length of the description', () => {
    const branch = buildAiBranchName('task_5', 'implementation '.repeat(20));
    expect(branch.replace('ai/task_5-', '').length).toBeLessThanOrEqual(48);
  });

  it('sanitises the reference as well as the prompt', () => {
    const branch = buildAiBranchName('task/../9281', 'Add a field');
    expect(branch).not.toContain('..');
  });
});
