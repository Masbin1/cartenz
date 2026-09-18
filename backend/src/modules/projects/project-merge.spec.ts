import { summarise as summariseMergeError } from './project-merge.service';

describe('summarise (project-merge)', () => {
  it('redacts a token embedded in an https URL', () => {
    const raw =
      'fatal: unable to access https://x-access-token:ghp_abcdef1234567890@github.com/o/r.git/: The requested URL returned error: 403';
    expect(summariseMergeError(raw)).not.toContain('ghp_abcdef1234567890');
    expect(summariseMergeError(raw)).toContain('https://[redacted]@github.com/o/r.git/');
  });

  it('redacts a token in a git@ scp-style URL only when it carries a userinfo credential', () => {
    // scp-style git@host:path has no userinfo slot for a token to leak from;
    // the pattern should not mangle a normal scp-style remote.
    const raw = 'fatal: could not read from remote repository: git@github.com:o/r.git';
    expect(summariseMergeError(raw)).toBe(raw);
  });

  it('redacts every credential when more than one URL appears', () => {
    const raw =
      'push to https://x-access-token:AAA@github.com/o/r.git failed, retrying https://x-access-token:BBB@github.com/o/r.git';
    const result = summariseMergeError(raw);
    expect(result).not.toContain('AAA');
    expect(result).not.toContain('BBB');
    expect(result).toContain('https://[redacted]@github.com/o/r.git');
  });

  it('trims whitespace and caps length at 400 characters', () => {
    const raw = `  ${'x'.repeat(500)}  `;
    const result = summariseMergeError(raw);
    expect(result.length).toBe(400);
    expect(result).toBe('x'.repeat(400));
  });

  it('falls back to a fixed message when given an empty or blank string', () => {
    expect(summariseMergeError('')).toBe('The merge failed with no message.');
    expect(summariseMergeError('   ')).toBe('The merge failed with no message.');
  });

  it('leaves an ordinary message without a credential untouched', () => {
    const raw = 'fatal: refusing to merge unrelated histories';
    expect(summariseMergeError(raw)).toBe(raw);
  });
});
