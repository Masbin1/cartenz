import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { AppModule } from '../app.module';
import { DatabaseService } from '../core/database/database.service';
import { projectConnections, projects } from '../core/database/schema';
import { SECRETS_PROVIDER, type SecretsProvider } from '../core/secrets/secrets.provider';

const run = promisify(execFile);

/**
 * Read-only check that a project's stored SSH connection actually works:
 * unseals the key exactly as git_push would, then runs `git push --dry-run`
 * of the remote's own HEAD to a probe ref. Nothing is created (dry run) and
 * the unsealed key is removed in a finally block.
 *
 * Usage (as cartenz, from /opt/cartenz/backend):
 *   set -a && . /opt/cartenz/.env && set +a
 *   npx ts-node -r tsconfig-paths/register src/scripts/verify-ssh-connection.ts <projectId>
 */
async function main(): Promise<void> {
    const [projectId] = process.argv.slice(2);

  if (!projectId) throw new Error('usage: verify-ssh-connection.ts <projectId>');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const say = (message: string): void => console.log(`[verify] ${message}`);

  let directory: string | null = null;

  try {
    const secrets = app.get<SecretsProvider>(SECRETS_PROVIDER);
    const database = app.get(DatabaseService);

    const [project] = await database.db
      .select({ id: projects.id, name: projects.name, repositoryUrl: projects.repositoryUrl })
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project) throw new Error(`no project with id ${projectId}`);

    const [connection] = await database.db
      .select({
        secretRef: projectConnections.secretRef,
        credentialKind: projectConnections.credentialKind,
        sshHostKey: projectConnections.sshHostKey,
      })
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId));

    if (!connection) throw new Error(`project ${project.name} has no connection row`);
    if (connection.credentialKind !== 'ssh_key') {
      throw new Error(`connection is ${connection.credentialKind}, not ssh_key`);
    }
    if (!connection.secretRef) throw new Error('connection has no secretRef');

    say(`repositoryUrl: ${project.repositoryUrl}`);

    const key = await secrets.read(connection.secretRef);
    say(`unsealed key: ${key.length} bytes, header ok=${key.startsWith('-----BEGIN')}`);

    directory = await mkdtemp(join(tmpdir(), 'cartenz-ssh-verify-'));
    const keyPath = join(directory, 'id_ssh');
    const knownHostsPath = join(directory, 'known_hosts');

    await writeFile(keyPath, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 });
    await chmod(keyPath, 0o600);
    await writeFile(knownHostsPath, `${(connection.sshHostKey ?? '').trim()}\n`, { mode: 0o600 });

    const sshCommand = [
      'ssh',
      '-i',
      keyPath,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHostsPath}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'ConnectTimeout=20',
    ].join(' ');

    const env = { ...process.env, GIT_SSH_COMMAND: sshCommand, GIT_TERMINAL_PROMPT: '0' };
    const url = project.repositoryUrl;
    if (!url) throw new Error('project has no repositoryUrl');

    const ls = await run('git', ['ls-remote', url, 'HEAD'], { env });
    const head = ls.stdout.trim().split('\t')[0];
    say(`ls-remote OK, remote HEAD=${head}`);

    // git push refuses to run outside a repository, even when every ref it is
    // asked about lives on the remote. An empty one is enough.
    await run('git', ['init', '--quiet', '--bare'], { env, cwd: directory });

    // Push the remote's OWN head to a probe ref: proves write permission while
    // being a no-op even if --dry-run were not honoured.
    const push = await run(
      'git',
      [
        'push',
        '--dry-run',
        url,
        `${head}:refs/heads/cartenz-write-probe-delete-me`,
      ],
      { env, cwd: directory },
    );
    say(`push --dry-run OK:\n${(push.stderr || push.stdout).trim()}`);
    say('RESULT: sealed SSH credential is valid and has WRITE access.');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    await app.close();
  }
}

main().catch((err) => {
  console.error('ERROR:', err?.stderr ?? err?.message ?? err);
  process.exit(1);
});
