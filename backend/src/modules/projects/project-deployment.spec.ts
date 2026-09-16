import { technicalNameFromOnPremisePath } from './project-deployment.service';

/**
 * The name this resolves is the one `pull-project.sh` is handed, and the script
 * turns it into `<projectsDir>/<name>` and runs git there as root. So the cases
 * that matter are the ones where a plausible-looking value would point the script
 * at a directory other than the project's own.
 *
 * Two forms of the recorded path are legitimate, and both are covered: a
 * provisioned project records `<name>/addons` (ADR-039), a scaffolded one records
 * `<name>` itself (ADR-032).
 */
describe('technicalNameFromOnPremisePath', () => {
  const ROOT = '/opt/odoo/projects';
  const path = (value: unknown) => ({ onPremisePath: value }) as Record<string, unknown>;
  const resolve = (value: unknown, root: string = ROOT) =>
    technicalNameFromOnPremisePath(path(value), root);

  it('takes the project directory from a provisioned addons path', () => {
    expect(resolve('/opt/odoo/projects/ggroma/addons')).toBe('ggroma');
  });

  it('takes it from the repository-root form the scaffold records', () => {
    // The regression this test exists for: reading the parent's basename of
    // `/opt/odoo/projects/ggroma` yields `projects`.
    expect(resolve('/opt/odoo/projects/ggroma')).toBe('ggroma');
  });

  it('ignores trailing slashes in either form', () => {
    expect(resolve('/opt/odoo/projects/ggroma/addons/')).toBe('ggroma');
    expect(resolve('/opt/odoo/projects/ggroma///')).toBe('ggroma');
  });

  it('follows the configured root rather than a hardcoded one', () => {
    expect(resolve('/srv/odoo/projects/vania/addons', '/srv/odoo/projects')).toBe('vania');
    expect(resolve('/opt/odoo/projects/vania/addons', '/srv/odoo/projects')).toBeNull();
  });

  it('accepts the separators and digits a project name may contain', () => {
    expect(resolve('/opt/odoo/projects/toko-rotiku_2/addons')).toBe('toko-rotiku_2');
  });

  it('returns null when no on-premise path is recorded', () => {
    expect(resolve('')).toBeNull();
    expect(technicalNameFromOnPremisePath({}, ROOT)).toBeNull();
    expect(technicalNameFromOnPremisePath(null, ROOT)).toBeNull();
  });

  it('returns null rather than a value when the path is not a string', () => {
    for (const value of [null, 42, { name: 'ggroma' }, ['ggroma'], true]) {
      expect(resolve(value)).toBeNull();
    }
  });

  it('refuses a name that is not a plain, valid directory name', () => {
    for (const name of ['GGroma', 'gg.roma', 'gg roma', '-ggroma', 'a', 'ggroma/addons']) {
      expect(resolve(`/opt/odoo/projects/${name}/addons`)).toBeNull();
    }
  });

  it('refuses a path that escapes the projects root', () => {
    // Each of these has a plausible-looking last segment; the root anchor is what
    // rejects them, not the segment check.
    for (const value of [
      '/opt/odoo/projects/../etc/addons',
      '/opt/odoo/projects/../../tmp/ggroma/addons',
      '/opt/odoo/projects/ggroma/../../etc/addons',
      '/etc/passwd/addons',
      '/tmp/ggroma/addons',
      'addons',
      '/addons',
      '/opt/odoo/projects',
      '/opt/odoo/projects/',
      '/opt/odoo/projects/addons',
    ]) {
      expect(resolve(value)).toBeNull();
    }
  });

  it('refuses a root that is not absolute', () => {
    expect(resolve('/opt/odoo/projects/ggroma/addons', 'opt/odoo/projects')).toBeNull();
    expect(resolve('/opt/odoo/projects/ggroma/addons', '')).toBeNull();
  });

  it('refuses a name longer than the scripts accept', () => {
    expect(resolve(`/opt/odoo/projects/${'x'.repeat(32)}/addons`)).toBeNull();
    expect(resolve(`/opt/odoo/projects/${'x'.repeat(31)}/addons`)).toBe('x'.repeat(31));
  });
});
