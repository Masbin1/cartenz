import { deriveInstanceName, parseMasterPassword } from './project-connected-instance.service';

/**
 * The two pieces of ADR-069's service that are pure and easy to get quietly
 * wrong: the name that becomes a directory, a database and a systemd unit, and
 * the one line of the create script's output that is sealed as a credential.
 */
describe('deriveInstanceName', () => {
  it('slugifies the project name and appends a stable 8-character suffix', () => {
    expect(deriveInstanceName('Omnisurge', 'a1b2c3d4-1111-2222-3333-444455556666')).toBe(
      'omnisurge-i-a1b2c3d4',
    );
  });

  it('never exceeds the 31-character limit the provisioning scripts enforce', () => {
    const name = deriveInstanceName(
      'A very long project name that would otherwise overflow the limit',
      'a1b2c3d4-1111-2222-3333-444455556666',
    );
    expect(name).toMatch(/^[a-z0-9][a-z0-9_-]{1,30}$/);
  });

  it('falls back to a fixed word when the project name has no usable characters', () => {
    expect(deriveInstanceName('***', 'a1b2c3d4-1111-2222-3333-444455556666')).toBe(
      'connected-i-a1b2c3d4',
    );
  });

  it('does not collide with the project’s own technical name or the ADR-067 suffix', () => {
    const id = 'a1b2c3d4-1111-2222-3333-444455556666';
    const own = deriveInstanceName('maha', id);
    expect(own).not.toBe('maha');
    // ADR-067 derives `<slug>-r-<suffix>`; the two must not be able to produce
    // one string, or one script's project-directory guard would reject the
    // other's directory.
    expect(own).toContain('-i-');
    expect(own).not.toContain('-r-');
  });
});

describe('parseMasterPassword', () => {
  it('reads the password from the create script’s output block', () => {
    const stdout = [
      'Provisioning complete',
      'Odoo Master Password:',
      '',
      '  s3cret-value',
      'URL: https://example.test',
    ].join('\n');
    expect(parseMasterPassword(stdout)).toBe('s3cret-value');
  });

  it('returns null rather than the wrong line when the block is absent', () => {
    expect(parseMasterPassword('Provisioning complete\n')).toBeNull();
  });
});
