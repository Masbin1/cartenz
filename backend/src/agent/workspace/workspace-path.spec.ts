import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PathEscapeError,
  resolveExistingPath,
  resolveWritablePath,
  toWorkspaceRelative,
  readOnlyRootsFromPaths,
  readOnlyRootFor,
  resolveReadPath,
  assertNotReadOnlyPath,
} from './workspace-path';

/**
 * Path containment is the control that stops a hostile repository reading the
 * platform host (ADR-019), so these tests are built on a real filesystem with
 * real symbolic links. A test using mocked fs calls would prove nothing about the
 * property that matters, which is what `realpath` actually resolves to.
 *
 * The escape cases are the point. A test that only proved ordinary paths work
 * would pass against an implementation that checks nothing.
 */
describe('workspace path containment', () => {
  let sandbox: string;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-path-'));
    workspace = join(sandbox, 'workspace', 'repository');
    outside = join(sandbox, 'outside');

    await mkdir(join(workspace, 'models'), { recursive: true });
    await mkdir(join(workspace, '.git'), { recursive: true });
    await mkdir(outside, { recursive: true });

    await writeFile(join(workspace, 'models', 'sale_order.py'), 'class SaleOrder:\n', 'utf8');
    await writeFile(join(workspace, '.git', 'config'), '[core]\n', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'platform secret\n', 'utf8');
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  describe('resolveExistingPath', () => {
    it('resolves a file inside the workspace', async () => {
      const resolved = await resolveExistingPath(workspace, 'models/sale_order.py');
      expect(resolved.startsWith(workspace)).toBe(true);
    });

    it('refuses a path that traverses upwards', async () => {
      await expect(resolveExistingPath(workspace, '../../outside/secret.txt')).rejects.toThrow(
        PathEscapeError,
      );
      await expect(resolveExistingPath(workspace, 'models/../../../outside/secret.txt')).rejects.toThrow(
        /traverses upwards/i,
      );
    });

    it('refuses an absolute path', async () => {
      await expect(resolveExistingPath(workspace, '/etc/passwd')).rejects.toThrow(/absolute/i);
      await expect(resolveExistingPath(workspace, 'C:/Windows/win.ini')).rejects.toThrow(
        /absolute/i,
      );
    });

    /**
     * The case a string check cannot catch. The requested path contains no `..`
     * and looks entirely ordinary; only resolving it reveals that it leaves the
     * workspace.
     */
    it('refuses a symbolic link pointing outside the workspace', async () => {
      await symlink(join(outside, 'secret.txt'), join(workspace, 'innocent.conf'));

      await expect(resolveExistingPath(workspace, 'innocent.conf')).rejects.toThrow(
        /resolves outside the workspace/i,
      );
    });

    it('refuses a file reached through a symlinked directory', async () => {
      await symlink(outside, join(workspace, 'vendor'));

      await expect(resolveExistingPath(workspace, 'vendor/secret.txt')).rejects.toThrow(
        /resolves outside the workspace/i,
      );
    });

    it('permits a symbolic link that stays inside the workspace', async () => {
      await symlink(join(workspace, 'models', 'sale_order.py'), join(workspace, 'alias.py'));

      const resolved = await resolveExistingPath(workspace, 'alias.py');
      expect(resolved).toBe(join(workspace, 'models', 'sale_order.py'));
    });

    it('refuses a circular symbolic link rather than hanging', async () => {
      await symlink(join(workspace, 'loop-b'), join(workspace, 'loop-a'));
      await symlink(join(workspace, 'loop-a'), join(workspace, 'loop-b'));

      await expect(resolveExistingPath(workspace, 'loop-a')).rejects.toThrow(PathEscapeError);
    });

    it('refuses the .git directory, which is not a file tool concern', async () => {
      await expect(resolveExistingPath(workspace, '.git/config')).rejects.toThrow(
        /[.]git directory is not reachable/i,
      );
    });

    it('refuses a missing file', async () => {
      await expect(resolveExistingPath(workspace, 'models/absent.py')).rejects.toThrow(
        /does not exist/i,
      );
    });

    it('refuses empty, over-long and NUL-bearing paths', async () => {
      await expect(resolveExistingPath(workspace, '')).rejects.toThrow(/empty/i);
      await expect(resolveExistingPath(workspace, 'a'.repeat(2000))).rejects.toThrow(/1024/);
      await expect(
        resolveExistingPath(workspace, `models/${String.fromCharCode(0)}.py`),
      ).rejects.toThrow(/NUL/i);
    });
  });

  describe('resolveWritablePath', () => {
    it('resolves a new file whose parent exists', async () => {
      const resolved = await resolveWritablePath(workspace, 'models/new_model.py');
      expect(resolved).toBe(join(workspace, 'models', 'new_model.py'));
    });

    it('resolves a new file in a directory that does not exist yet', async () => {
      const resolved = await resolveWritablePath(workspace, 'views/new/deep/file.xml');
      expect(resolved.startsWith(workspace)).toBe(true);
    });

    it('resolves an existing file', async () => {
      const resolved = await resolveWritablePath(workspace, 'models/sale_order.py');
      expect(resolved).toBe(join(workspace, 'models', 'sale_order.py'));
    });

    /**
     * The write-side equivalent of the read escape, and the more damaging one:
     * writing through a link out of the workspace would modify a host file.
     */
    it('refuses writing through a symlink that points outside', async () => {
      await symlink(join(outside, 'secret.txt'), join(workspace, 'target.conf'));

      await expect(resolveWritablePath(workspace, 'target.conf')).rejects.toThrow(
        /existing link whose target is outside/i,
      );
    });

    it('refuses a new file under a symlinked directory pointing outside', async () => {
      await symlink(outside, join(workspace, 'vendor'));

      await expect(resolveWritablePath(workspace, 'vendor/planted.py')).rejects.toThrow(
        /outside the workspace/i,
      );
    });

    it('refuses traversal and absolute paths', async () => {
      await expect(resolveWritablePath(workspace, '../planted.py')).rejects.toThrow(
        /traverses upwards/i,
      );
      await expect(resolveWritablePath(workspace, '/tmp/planted.py')).rejects.toThrow(
        /absolute/i,
      );
    });

    it('refuses writing into .git', async () => {
      await expect(resolveWritablePath(workspace, '.git/hooks/pre-commit')).rejects.toThrow(
        /[.]git directory is not reachable/i,
      );
    });
  });

  describe('toWorkspaceRelative', () => {
    it('returns a path relative to the workspace root', async () => {
      const relative = await toWorkspaceRelative(
        workspace,
        join(workspace, 'models', 'sale_order.py'),
      );
      expect(relative).toBe('models/sale_order.py');
    });

    it('leaves a path outside the workspace unchanged, rather than mangling it', async () => {
      const absolute = join(outside, 'secret.txt');
      expect(await toWorkspaceRelative(workspace, absolute)).toBe(absolute);
    });
  });

  describe('read-only roots (on-premise base/enterprise)', () => {
    let baseDir: string;
    let enterpriseDir: string;
    let roots: ReturnType<typeof readOnlyRootsFromPaths>;

    beforeEach(async () => {
      baseDir = join(sandbox, 'odoo');
      enterpriseDir = join(sandbox, 'enterprise');
      await mkdir(join(baseDir, 'addons', 'sale', 'models'), { recursive: true });
      await mkdir(join(enterpriseDir, 'account_reports'), { recursive: true });
      await writeFile(
        join(baseDir, 'addons', 'sale', 'models', 'sale_order.py'),
        'class SaleOrder:\n',
        'utf8',
      );
      roots = readOnlyRootsFromPaths([baseDir, enterpriseDir]);
    });

    it('derives a prefix from the directory name', () => {
      expect(roots.map((root) => root.prefix)).toEqual(['odoo', 'enterprise']);
    });

    it('matches a path under a read-only prefix, and nothing else', () => {
      expect(readOnlyRootFor(roots, 'odoo/addons/sale')).toMatchObject({ prefix: 'odoo' });
      expect(readOnlyRootFor(roots, 'odoo')).toMatchObject({ prefix: 'odoo' });
      expect(readOnlyRootFor(roots, 'models/x.py')).toBeNull();
    });

    it('resolves a read under a read-only prefix against the shared directory', async () => {
      const resolved = await resolveReadPath(
        workspace,
        roots,
        'odoo/addons/sale/models/sale_order.py',
      );
      expect(resolved).toBe(join(baseDir, 'addons', 'sale', 'models', 'sale_order.py'));
    });

    it('falls back to the workspace root for an un-prefixed path', async () => {
      const resolved = await resolveReadPath(workspace, roots, 'models/sale_order.py');
      expect(resolved).toBe(join(workspace, 'models', 'sale_order.py'));
    });

    it('refuses traversal out of a read-only root', async () => {
      await expect(
        resolveReadPath(workspace, roots, 'odoo/../outside/secret.txt'),
      ).rejects.toThrow(/traverses upwards/i);
    });

    it('refuses a write that names a read-only prefix', () => {
      expect(() => assertNotReadOnlyPath(roots, 'odoo/addons/x.py')).toThrow(
        /read-only shared path/i,
      );
      expect(() => assertNotReadOnlyPath(roots, 'enterprise/y.py')).toThrow(
        /read-only shared path/i,
      );
    });

    it('permits a write that does not name a read-only prefix', () => {
      expect(() => assertNotReadOnlyPath(roots, 'models/custom.py')).not.toThrow();
    });
  });
});
