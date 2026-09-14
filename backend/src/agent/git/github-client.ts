import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';

/**
 * GitHub repositories, for a project this platform creates (ADR-041).
 *
 * A created project's code lives only on this host, so `GIT_PUSH_ENABLED` on its
 * own changes nothing for it: there is no `origin` and no repository at the other
 * end to receive a push. This client is the missing half — it creates the
 * repository, so that the project's own git repository can point at it.
 *
 * Three properties are deliberate:
 *
 *  1. **No token in a URL and no token in a log.** The token travels in an
 *     `Authorization` header only. The remote the project is given is a plain
 *     `https://github.com/<owner>/<name>.git`, which is what `assertSafeRemoteUrl`
 *     requires and what keeps a credential out of the repository's own config; the
 *     credential is supplied separately, per push, through the existing lease.
 *  2. **Creating is idempotent.** An existing repository is adopted rather than
 *     reported as a conflict, because a retried project creation must not fail on
 *     the repository it made on the first attempt.
 *  3. **A failure is a message a person can act on.** GitHub's own `message` is
 *     surfaced (a token missing `Administration: write` says exactly that), and
 *     nothing else about the request is — no headers, no body, no token.
 */

/** GitHub's API root. Not configurable: a second value would be a second trust anchor. */
const API_ROOT = 'https://api.github.com';

/** GitHub answers quickly or not at all; a hung request must not hold a request open. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A repository name GitHub will accept, and that this platform can push.
 *
 * GitHub's own rules are looser; the scaffold's directory name is already
 * `[a-z][a-z0-9_]*`, and `.`/`-` are allowed here so an existing convention can be
 * adopted without renaming it.
 */
const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    /** What was being attempted, for a message that names the operation. */
    readonly operation: string,
  ) {
    super(`${operation} failed (GitHub responded ${status}): ${detail}`);
    this.name = 'GitHubApiError';
  }
}

export interface GitHubRepository {
  /** `owner/name`, as git and GitHub both spell it. */
  readonly fullName: string;
  readonly name: string;
  readonly cloneUrl: string;
  readonly htmlUrl: string;
  readonly defaultBranch: string;
  /** False when a repository of that name already existed and was adopted. */
  readonly created: boolean;
}

interface GitHubRepositoryPayload {
  readonly name?: string;
  readonly full_name?: string;
  readonly clone_url?: string;
  readonly html_url?: string;
  readonly default_branch?: string;
  readonly private?: boolean;
  readonly message?: string;
}

@Injectable()
export class GitHubClient {
  private readonly logger = new Logger(GitHubClient.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Whether this deployment can create and push to repositories.
   *
   * False unless a token, an owner and the switch are all present, so a
   * half-configured deployment does nothing rather than failing halfway through a
   * project creation. Configuration already folds the three together; they are
   * checked again here because this is the property callers branch on, and a client
   * that answered "available" and then threw for a missing token would be reporting
   * the wrong thing about itself.
   */
  get available(): boolean {
    return (
      this.config.github.repositoryEnabled &&
      Boolean(this.config.github.token) &&
      Boolean(this.config.github.owner)
    );
  }

  /**
   * The repository `owner/name`, creating it under the configured owner if it does
   * not exist yet.
   *
   * The owner's account type decides which endpoint creates it: an organisation has
   * `/orgs/{owner}/repos`, a user account only `/user/repos` (which creates under
   * the token's own account). Asking first means the wrong pair — a token for one
   * account, an owner that is another — is reported as exactly that, rather than as
   * a bare 404 from the create call.
   */
  async ensureRepository(input: {
    readonly name: string;
    readonly description: string | null;
  }): Promise<GitHubRepository> {
    const token = this.requireToken();
    const owner = this.requireOwner();

    if (!REPOSITORY_NAME.test(input.name)) {
      throw new GitHubApiError(
        0,
        `"${input.name}" is not a usable GitHub repository name.`,
        'Creating the repository',
      );
    }

    const existing = await this.request<GitHubRepositoryPayload>(
      token,
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(input.name)}`,
      { notFoundIsNull: true },
    );

    if (existing) {
      const adopted = this.toRepository(existing, false);
      this.logger.log(`Adopted existing GitHub repository ${adopted.fullName}`);
      return adopted;
    }

    const ownerType = await this.accountType(token, owner);
    const created = await this.request<GitHubRepositoryPayload>(
      token,
      'POST',
      ownerType === 'Organization'
        ? `/orgs/${encodeURIComponent(owner)}/repos`
        : '/user/repos',
      {
        body: {
          name: input.name,
          // Private unless the deployment said otherwise: a scaffold is the
          // customer's code (ADR-041).
          private: this.config.github.visibility !== 'public',
          // No initial commit: the scaffold's own commit is the history, and an
          // initialised repository would make the first push a divergent
          // non-fast-forward.
          auto_init: false,
          ...(input.description ? { description: input.description } : {}),
        },
      },
    );

    // A user-account owner that is not the token's own account: `/user/repos`
    // creates under the token's account, so the result would be the wrong owner.
    if (ownerType === 'User' && created.full_name) {
      const createdOwner = created.full_name.split('/')[0];
      if (createdOwner.toLowerCase() !== owner.toLowerCase()) {
        throw new GitHubApiError(
          0,
          `the repository was created under "${createdOwner}", not under the configured ` +
            `GITHUB_OWNER "${owner}". Set GITHUB_OWNER to the account the token belongs to, ` +
            'or to an organisation the token can create repositories in.',
          'Creating the repository',
        );
      }
    }

    const repository = this.toRepository(created, true);
    this.logger.log(
      `Created GitHub repository ${repository.fullName} (${repository.htmlUrl})`,
    );
    return repository;
  }

  /** `Organization` or `User`, so the caller knows which create endpoint applies. */
  private async accountType(token: string, owner: string): Promise<'Organization' | 'User'> {
    const account = await this.request<{ type?: string }>(
      token,
      'GET',
      `/users/${encodeURIComponent(owner)}`,
    );
    return account.type === 'Organization' ? 'Organization' : 'User';
  }

  private toRepository(payload: GitHubRepositoryPayload, created: boolean): GitHubRepository {
    if (!payload.full_name || !payload.clone_url || !payload.name) {
      throw new GitHubApiError(0, 'the response named no repository', 'Creating the repository');
    }
    return {
      fullName: payload.full_name,
      name: payload.name,
      cloneUrl: payload.clone_url,
      htmlUrl: payload.html_url ?? `https://github.com/${payload.full_name}`,
      defaultBranch: payload.default_branch ?? 'main',
      created,
    };
  }

  private requireToken(): string {
    const token = this.config.github.token;
    if (!token) {
      throw new GitHubApiError(0, 'GITHUB_TOKEN is not set', 'Creating the repository');
    }
    return token;
  }

  private requireOwner(): string {
    const owner = this.config.github.owner;
    if (!owner) {
      throw new GitHubApiError(0, 'GITHUB_OWNER is not set', 'Creating the repository');
    }
    return owner;
  }

  /**
   * One API call.
   *
   * `notFoundIsNull` exists for the adopt-or-create sequence, where a 404 is an
   * answer ("no such repository") rather than a failure; without it a 404 throws
   * like any other error, which is why the overloads exist rather than a
   * nullable return everywhere.
   */
  private async request<T>(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    options: { readonly body?: Record<string, unknown>; readonly notFoundIsNull: true },
  ): Promise<T | null>;
  private async request<T>(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    options?: { readonly body?: Record<string, unknown> },
  ): Promise<T>;
  private async request<T>(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    options: { readonly body?: Record<string, unknown>; readonly notFoundIsNull?: boolean } = {},
  ): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${API_ROOT}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'linkederp-cartenz',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      // The token is not in this message: the URL carries only the path, and the
      // error is the transport's own.
      const reason = (error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message;
      throw new GitHubApiError(0, `the request ${reason}`, `Calling ${method} ${path}`);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    if (!response.ok) {
      if (options.notFoundIsNull && response.status === 404) return null;
      throw new GitHubApiError(
        response.status,
        this.readMessage(text),
        `Calling ${method} ${path}`,
      );
    }

    if (text.length === 0) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitHubApiError(response.status, 'the response was not JSON', `Calling ${method} ${path}`);
    }
  }

  /** GitHub's `message`, plus its first field error when it sends one. */
  private readMessage(body: string): string {
    try {
      const parsed = JSON.parse(body) as {
        message?: string;
        errors?: Array<{ message?: string; field?: string }>;
      };
      const first = parsed.errors?.[0];
      const detail = [parsed.message, first?.message, first?.field ? `(${first.field})` : null]
        .filter((part): part is string => Boolean(part))
        .join(' ');
      return detail.length > 0 ? detail : 'no message';
    } catch {
      return body.slice(0, 200) || 'no message';
    }
  }
}
