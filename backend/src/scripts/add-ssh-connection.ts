import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { AppModule } from '../app.module';
import { DatabaseService } from '../core/database/database.service';
import { projectConnections, projects } from '../core/database/schema';
import { SECRETS_PROVIDER, type SecretsProvider } from '../core/secrets/secrets.provider';

/**
 * One-off: add an SSH-keyed github connection for a project that currently has
 * only a bare repositoryUrl and no project_connections row at all, so git_push
 * (which reads the credential from the project's first connection) has a
 * credential to lease instead of failing with "terminal prompts disabled".
 *
 * Usage (as cartenz, from /opt/cartenz/backend):
 *   set -a && . /opt/cartenz/.env && set +a
 *   npx ts-node -r tsconfig-paths/register src/scripts/add-ssh-connection.ts \
 *     <projectId> <keyPath> <sshHostKeyLine>
 */
async function main(): Promise<void> {
  const logger = new Logger('AddSshConnection');
  const [projectId, keyPath, ...hostKeyParts] = process.argv.slice(2);
  const sshHostKey = hostKeyParts.join(' ');

  if (!projectId || !keyPath || !sshHostKey) {
    throw new Error('usage: add-ssh-connection.ts <projectId> <keyPath> <sshHostKeyLine>');
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const secrets = app.get<SecretsProvider>(SECRETS_PROVIDER);
    const database = app.get(DatabaseService);

    const [project] = await database.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId));

    if (!project) {
      throw new Error(`no project with id ${projectId}`);
    }

    const existing = await database.db
      .select({ id: projectConnections.id })
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId));

    if (existing.length > 0) {
      throw new Error(
        `project ${project.name} already has ${existing.length} connection(s); refusing to add a duplicate`,
      );
    }

    const privateKey = await readFile(keyPath, 'utf8');

    const secretRef = await secrets.write({
      projectId,
      purpose: 'github-ssh_key',
      value: privateKey,
    });
    logger.log(`Secret sealed: ${secretRef.ref}`);

    const [connection] = await database.db
      .insert(projectConnections)
      .values({
        projectId,
        connectionType: 'github',
        secretRef: secretRef.ref,
        credentialKind: 'ssh_key',
        sshHostKey,
        status: 'connected',
        metadata: { host: 'github.com', sshUser: 'git' },
        lastCheckedAt: new Date(),
      })
      .returning({
        id: projectConnections.id,
        connectionType: projectConnections.connectionType,
        status: projectConnections.status,
      });

    logger.log(`Connection created for ${project.name}: ${JSON.stringify(connection)}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});
