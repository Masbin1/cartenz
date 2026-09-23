import { eq } from 'drizzle-orm';
import type { DatabaseService } from '../../core/database/database.service';
import { projectConnections } from '../../core/database/schema';
import { GIT_CONNECTION_TYPES, type GitTransport } from '../../core/enums';
import type { GitCredentialsService } from '../../modules/settings/git-credentials.service';
import { applyTransportToUrl, effectiveRepositoryUrl } from '../../modules/projects/repository-url';

/**
 * Everything needed to reach a project's repository: the URL to use and the
 * credential to present, resolved once and shared by every caller.
 *
 * This exists because there is more than one caller now. A task's snapshot
 * resolved it (ADR-059), and the long-lived checkout per project (ADR-063)
 * resolves it too - and a second implementation of the three-tier order is how
 * the two would quietly disagree, with the checkout authenticating as one
 * identity and a task as another against the same remote.
 */
export interface ProjectGitAccess {
  /** The URL to clone and fetch from, with the project's transport applied. */
  readonly repositoryUrl: string | null;
  readonly secretRef: string | null;
  readonly credentialKind: 'token' | 'ssh_key';
  readonly sshHostKey: string | null;
  readonly credentialUsername: string | null;
  /** The first connection's metadata, which is where an Odoo Online URL lives. */
  readonly connectionMetadata: Record<string, unknown> | null;
  /** Every connection, for the callers that need to look further than the first. */
  readonly connections: readonly {
    readonly connectionType: string;
    readonly metadata: Record<string, unknown> | null;
  }[];
}

export interface ProjectGitAccessInput {
  readonly projectId: string;
  /** The project's own repository column, which may be null. */
  readonly repositoryUrl: string | null;
  readonly gitCredentialId: string | null;
  readonly gitUsername: string | null;
  readonly gitTransport: string | null;
}

/**
 * Resolves the credential a clone, fetch or push uses (ADR-021, ADR-059).
 *
 * Three tiers, in this order:
 *
 *  1. The project's own choice, when its settings name one. This is the
 *     override an operator sets on the project's Git access panel, and it wins
 *     because it is the most specific statement of intent.
 *  2. The project's first credential-bearing Git connection. Restricted to
 *     connection types that *are* a Git remote (ADR-041): a project can hold
 *     more than one connection - an Odoo Online API key for `odoo_api`, a
 *     repository for `github` - and "the first one with a secret" stops being an
 *     answer once one of them is not a Git credential at all, because the push
 *     would present an Odoo API key to GitHub. Among the qualifying connections
 *     the oldest wins, as it did before.
 *  3. The deployment default registered for the remote's host (ADR-058).
 *
 * Tier 3 is what makes a project connectable without pasting a key into it:
 * before it, a project whose remote was reached with the deployment's own key
 * still had a null `secretRef` here, and the push ran with no credential at all
 * - `could not read Username for 'https://github.com'` when the remote was HTTPS.
 */
export async function resolveProjectGitAccess(
  deps: {
    readonly database: DatabaseService;
    readonly gitCredentials: GitCredentialsService;
  },
  input: ProjectGitAccessInput,
): Promise<ProjectGitAccess> {
  const connections = await deps.database.db
    .select({
      secretRef: projectConnections.secretRef,
      credentialKind: projectConnections.credentialKind,
      sshHostKey: projectConnections.sshHostKey,
      metadata: projectConnections.metadata,
      connectionType: projectConnections.connectionType,
      createdAt: projectConnections.createdAt,
    })
    .from(projectConnections)
    .where(eq(projectConnections.projectId, input.projectId))
    .orderBy(projectConnections.createdAt);

  // The repository URL's own metadata is read here regardless of which tier
  // supplies the credential: an Odoo Online URL, in particular, lives on the
  // connection even when tier 1 or tier 3 is what authenticates the push.
  const connectionMetadata = connections[0]?.metadata ?? null;

  /**
   * The URL this project's repository is reached at, before the transport is
   * applied. Read from both places it can be recorded (ADR-041): a project whose
   * URL lives on its connection looks repository-less when only the column is
   * read, and the clone is then skipped with "no repository connected" naming an
   * action the operator has no reason to take.
   */
  const resolvedUrl = effectiveRepositoryUrl(input.repositoryUrl, connections);

  const finish = (
    credential: Pick<
      ProjectGitAccess,
      'secretRef' | 'credentialKind' | 'sshHostKey'
    >,
  ): ProjectGitAccess => ({
    repositoryUrl: resolvedUrl
      ? applyTransportToUrl(
          resolvedUrl,
          (input.gitTransport ?? 'auto') as GitTransport,
        )
      : null,
    ...credential,
    credentialUsername: input.gitUsername,
    connectionMetadata,
    connections,
  });

  if (input.gitCredentialId) {
    const registered = await deps.gitCredentials
      .resolveForHost({ credentialId: input.gitCredentialId })
      .catch(() => null);
    if (registered) {
      return finish({
        secretRef: registered.secretRef,
        credentialKind: registered.kind,
        sshHostKey: null,
      });
    }
    // A project-level choice that no longer resolves (the row was deleted or
    // disabled after being chosen) falls through to the next tier rather than
    // failing the whole resolution - the same recovery a null credential column
    // always had.
  }

  const gitConnection = connections.find(
    (row) =>
      row.secretRef !== null &&
      (GIT_CONNECTION_TYPES as readonly string[]).includes(row.connectionType),
  );
  if (gitConnection) {
    return finish({
      secretRef: gitConnection.secretRef,
      credentialKind: gitConnection.credentialKind as 'token' | 'ssh_key',
      sshHostKey: gitConnection.sshHostKey,
    });
  }

  const host = resolvedUrl ? deps.gitCredentials.hostOf(resolvedUrl) : null;
  const registeredDefault = await deps.gitCredentials
    .resolveForHost({ host })
    .catch(() => null);

  return finish({
    secretRef: registeredDefault?.secretRef ?? null,
    credentialKind: registeredDefault?.kind ?? 'token',
    sshHostKey: null,
  });
}
