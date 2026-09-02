import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listOnPremiseFolders } from './on-premise-locations';

describe('listOnPremiseFolders', () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-locations-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('lists immediate subdirectories and marks which are git repositories', async () => {
    await mkdir(join(sandbox, 'linkederp-vania', '.git'), { recursive: true });
    await mkdir(join(sandbox, 'not-a-repo'), { recursive: true });
    await writeFile(join(sandbox, 'a-file.txt'), 'not a directory', 'utf8');

    const folders = await listOnPremiseFolders(sandbox);

    expect(folders.map((folder) => folder.name)).toEqual(['linkederp-vania', 'not-a-repo']);
    expect(folders.find((folder) => folder.name === 'linkederp-vania')?.isGitRepository).toBe(
      true,
    );
    expect(folders.find((folder) => folder.name === 'not-a-repo')?.isGitRepository).toBe(false);
  });

  it('returns an empty list for a missing root', async () => {
    expect(await listOnPremiseFolders(join(sandbox, 'does-not-exist'))).toEqual([]);
  });
});
