import { GIT_CONNECTION_TYPES, type GitTransport } from '../../core/enums';
import { assertSafeRemoteUrl, type ParsedRemote } from '../../agent/git/git-url';

/**
 * A project's repository URL, resolved from both places one can be recorded
 * (ADR-041's lesson, applied to ADR-057's readers).
 *
 * A project can hold a repository in one of two places, and both are in use:
 *
 *  - `projects.repository_url` — set when a person typed a URL into the creation
 *    form. This is what every reader used to look at, and only at.
 *  - a `projects_connections` row of a Git type — set when the platform created
 *    the repository itself (ADR-041). The row's metadata carries `cloneUrl`;
 *    `repository_url` stays null on purpose, because the connection is what holds
 *    the credential.
 *
 * ADR-041 records what happens when a reader only asks the first question: a
 * project with a perfectly good GitHub connection is refused with "connect a
 * repository first" — naming an action the person has no reason to take. The
 * affected readers then were the task-submission guard. They are now the Deploy
 * button and the ADR-057 merge/restart actions, which is the same bug in a new
 * place: "when a new flow records a fact somewhere new, audit the readers of the
 * old location rather than only the writer."
 *
 * Kept pure and free of any database access so the resolution can be asserted
 * without one — the shape `project-access-list` and `project-deletion` already
 * use for the parts of this module that are easy to get quietly wrong.
 */
export interface RepositoryConnectionFacts {
  readonly connectionType: string;
  readonly metadata: Record<string, unknown> | null;
}

/**
 * Metadata keys that can carry a cloneable URL, most specific first.
 *
 * `cloneUrl` is what `GitHubRepositoryService` records (the `.git` form, which is
 * what a clone wants). `repositoryUrl` is what the creation form sends for a
 * connection a person configured by hand. `url` is the human-facing address most
 * connections record, kept last because for a GitHub connection it is the HTML
 * page rather than the clone endpoint — still cloneable, but not the one to
 * prefer.
 */
const URL_KEYS = ['cloneUrl', 'repositoryUrl', 'url'] as const;

/** Whether a connection type is a Git remote. `odoo_api` is not: it is an API key. */
function isGitConnection(connectionType: string): boolean {
  return (GIT_CONNECTION_TYPES as readonly string[]).includes(connectionType);
}

/** The first usable clone URL a Git connection's metadata records, or null. */
export function repositoryUrlFromConnections(
  connections: readonly RepositoryConnectionFacts[],
): string | null {
  for (const connection of connections) {
    // An `odoo_api` secret authenticates an HTTP API and is not a clone
    // credential. The same filter `gitCredential` and the task guard apply.
    if (!isGitConnection(connection.connectionType)) continue;

    const metadata = connection.metadata ?? {};
    for (const key of URL_KEYS) {
      const value = metadata[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  return null;
}

/**
 * Where this project's repository actually is, or null when it has none.
 *
 * The project's own column wins when it is set: a person who typed a URL meant
 * that URL, even if a connection was arranged alongside it.
 */
export function effectiveRepositoryUrl(
  projectUrl: string | null | undefined,
  connections: readonly RepositoryConnectionFacts[],
): string | null {
  if (typeof projectUrl === 'string' && projectUrl.trim().length > 0) {
    return projectUrl.trim();
  }

  return repositoryUrlFromConnections(connections);
}

/** The transport a URL's own scheme implies, or null when it cannot be read. */
export function transportOfUrl(url: string): 'ssh' | 'https' | null {
  try {
    return assertSafeRemoteUrl(url, { allowLocal: true }).scheme === 'ssh' ? 'ssh' : 'https';
  } catch {
    return null;
  }
}

/**
 * Rewrites a remote URL into the form the chosen transport needs (ADR-059).
 *
 * The point of the setting is that a person picks "SSH" or "HTTPS" and the URL
 * follows, rather than having to know that `https://github.com/owner/repo.git`
 * and `git@github.com:owner/repo.git` are the same repository reached two ways.
 * Getting that wrong by hand is exactly how a project ends up with an HTTPS
 * remote and an SSH key.
 *
 * Returns the URL unchanged when:
 *  - the transport is `auto`, which by definition does not override the URL;
 *  - the URL is already in the requested form (so the rewrite is idempotent and
 *    a portal that saves the whole object twice does not mangle it);
 *  - the URL cannot be parsed, or is a local `file://` remote. A URL the parser
 *    refuses is left exactly as the caller wrote it, so the failure surfaces
 *    later as a git error naming the real URL rather than as a silently
 *    invented one.
 */
export function applyTransportToUrl(url: string, transport: GitTransport): string {
  if (transport === 'auto') return url;

  let parsed: ParsedRemote;
  try {
    parsed = assertSafeRemoteUrl(url, { allowLocal: true });
  } catch {
    return url;
  }

  if (parsed.isLocal) return url;

  // A non-default port survives the rewrite by keeping the URL untouched, in
  // either direction: `https://host:port/path` is a different service than
  // `https://host/path` would silently become, and neither the https nor the
  // ssh branch below has a way to carry a port over correctly.
  const port = safePort(parsed.url);
  if (port) return url;

  if (transport === 'https') {
    if (parsed.scheme === 'https') return url;
    return `https://${parsed.host}/${parsed.path}`;
  }

  // ssh: keeps the URL's own account when it names one (an operator may have a
  // non-standard deploy user); falls back to `git`, what every major host
  // expects for a deploy key, when the URL had none to carry over.
  if (parsed.scheme === 'ssh') return url;
  const account = parsed.sshUser ?? 'git';
  return `ssh://${account}@${parsed.host}/${parsed.path}`;
}

/** The port on a normalised `ssh://`/`https://` URL, or null when it is the default. */
function safePort(normalisedUrl: string): string | null {
  try {
    const port = new URL(normalisedUrl).port;
    return port.length > 0 ? port : null;
  } catch {
    return null;
  }
}
