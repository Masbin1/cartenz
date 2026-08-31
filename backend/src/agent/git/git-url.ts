/**
 * Remote URL validation (ADR-019).
 *
 * A git remote URL is not an inert string. Several of git's transports treat it
 * as something closer to a command, and a URL is the one field a customer
 * supplies that reaches a process invocation. This module is the only place a
 * remote is accepted, and it accepts by allow-list.
 *
 * The specific attacks it refuses:
 *
 *  - `ext::sh -c "..."` - the ext transport runs an arbitrary command. This is
 *    the reason a scheme allow-list is used rather than a deny-list.
 *  - `file:///path` and bare local paths - would let a caller clone any
 *    repository on the platform host, including another customer's workspace.
 *    Permitted only when explicitly enabled for testing.
 *  - `-u./payload`, `--upload-pack=...` - a URL beginning with a hyphen is read
 *    by git as an option, not an operand.
 *  - Credentials embedded in the URL - refused so that a token cannot be stored
 *    in `.git/config` or appear in a process listing. Credentials are supplied
 *    through the askpass helper instead.
 *  - Control characters, which could split a config file or a log line.
 */

/** Schemes the platform will clone from. */
const ALLOWED_SCHEMES = new Set(['https:', 'ssh:']);

/**
 * Schemes named explicitly so a refusal says why. `ext` and `file` are the
 * dangerous ones; the rest are unencrypted or unsupported.
 */
const REJECTED_SCHEME_REASONS: Readonly<Record<string, string>> = {
  'ext:': 'the ext transport executes an arbitrary command',
  'file:': 'a local path could read any repository on the platform host',
  'http:': 'plaintext HTTP is not permitted; use https',
  'git:': 'the git protocol is unauthenticated and unencrypted',
  'ftp:': 'FTP is not a supported transport',
  'ftps:': 'FTPS is not a supported transport',
};

export class UnsafeRemoteUrlError extends Error {
  constructor(reason: string) {
    super(`The repository URL was refused: ${reason}`);
    this.name = 'UnsafeRemoteUrlError';
  }
}

export interface ParsedRemote {
  /** The URL as it will be given to git, with any credentials removed. */
  readonly url: string;
  readonly scheme: 'https' | 'ssh' | 'file';
  readonly host: string;
  /**
   * SSH account name, where one is given. This is not a credential: for SSH,
   * `git@host` names the account the key authenticates against, and git needs it.
   * Always null for https, where a username is refused.
   */
  readonly sshUser: string | null;
  /** Repository path without a leading slash, e.g. `linkederp/omnisurge`. */
  readonly path: string;
  /** True when the remote is a local file:// path permitted for testing. */
  readonly isLocal: boolean;
}

export interface RemoteUrlOptions {
  /** Permits file:// remotes. Test-only; refused in production by config. */
  readonly allowLocal?: boolean;
}

/**
 * True when the string contains a C0 control character or DEL.
 *
 * Written as a loop over character codes rather than a regular expression
 * containing literal control bytes, which are invisible in a diff and easy to
 * get wrong.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates and normalises a remote URL, or throws.
 *
 * Returns the URL with credentials stripped, because the credential path is the
 * askpass helper and a URL is not allowed to carry one.
 */
export function assertSafeRemoteUrl(raw: string, options: RemoteUrlOptions = {}): ParsedRemote {
  if (typeof raw !== 'string') {
    throw new UnsafeRemoteUrlError('it is not a string');
  }

  const value = raw.trim();

  if (value.length === 0) {
    throw new UnsafeRemoteUrlError('it is empty');
  }
  if (value.length > 2048) {
    throw new UnsafeRemoteUrlError('it is longer than 2048 characters');
  }

  // Checked before parsing: a control character can split a config file or a log
  // line regardless of whether the rest of the URL is well formed.
  if (hasControlCharacter(value)) {
    throw new UnsafeRemoteUrlError('it contains a control character');
  }

  // Checked before parsing: git reads a leading hyphen as an option.
  if (value.startsWith('-')) {
    throw new UnsafeRemoteUrlError('it begins with a hyphen, which git reads as an option');
  }

  // Matched on the raw string as well as the parsed scheme, because `ext::` is
  // not a scheme the URL parser recognises.
  if (/^ext::/i.test(value)) {
    throw new UnsafeRemoteUrlError('the ext transport executes an arbitrary command');
  }

  // git also accepts scp-style remotes: git@host:owner/repo.git. Normalised to
  // ssh:// so that one parser handles every accepted form.
  const scpStyle = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?![/])(.+)$/.exec(value);
  const candidate = scpStyle
    ? `ssh://${scpStyle[1]}@${scpStyle[2]}/${scpStyle[3]}`
    : value;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new UnsafeRemoteUrlError(
      'it is not an absolute URL. Use https://host/owner/repo.git or git@host:owner/repo.git',
    );
  }

  const isLocal = parsed.protocol === 'file:';

  if (isLocal) {
    if (options.allowLocal !== true) {
      throw new UnsafeRemoteUrlError(REJECTED_SCHEME_REASONS['file:']);
    }
  } else if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    const reason =
      REJECTED_SCHEME_REASONS[parsed.protocol] ??
      `the ${parsed.protocol.replace(':', '')} scheme is not supported`;
    throw new UnsafeRemoteUrlError(reason);
  }

  /**
   * Credential handling differs by scheme, and the distinction is real rather
   * than pedantic.
   *
   * For SSH, `git@host` is the account the key authenticates against. It is not
   * a secret, it is the conventional form every Git host documents, and git needs
   * it. A password in an SSH URL, on the other hand, is never meaningful.
   *
   * For HTTPS, a username is exactly how a token gets smuggled into a URL - and
   * from there into `.git/config` and a process listing - so both parts are
   * refused. The credential path is the askpass helper.
   *
   * Refused rather than silently stripped: a caller who put a token in a URL needs
   * to be told it was not used.
   */
  if (parsed.password.length > 0) {
    throw new UnsafeRemoteUrlError(
      'it embeds a password. Supply the access token as a project connection instead',
    );
  }

  const isSsh = parsed.protocol === 'ssh:';

  if (parsed.username.length > 0 && !isSsh) {
    throw new UnsafeRemoteUrlError(
      'it embeds credentials. Supply the access token as a project connection instead',
    );
  }

  const sshUser = isSsh && parsed.username.length > 0 ? parsed.username : null;

  if (!isLocal && parsed.hostname.length === 0) {
    throw new UnsafeRemoteUrlError('it has no host');
  }

  const path = parsed.pathname.replace(/^[/]+/, '');
  if (path.length === 0) {
    throw new UnsafeRemoteUrlError('it names no repository path');
  }

  // A query string or fragment on a git remote is meaningless and is more likely
  // to be an attempt to smuggle something than a mistake.
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new UnsafeRemoteUrlError('it carries a query string or fragment');
  }

  const authority = sshUser ? `${sshUser}@${parsed.host}` : parsed.host;

  return {
    url: isLocal ? `file://${parsed.pathname}` : `${parsed.protocol}//${authority}/${path}`,
    scheme: isLocal ? 'file' : (parsed.protocol.replace(':', '') as 'https' | 'ssh'),
    host: parsed.hostname,
    sshUser,
    path,
    isLocal,
  };
}

/**
 * Validates a git ref name for use as a branch.
 *
 * Deliberately stricter than git itself. git permits characters the platform has
 * no use for, and a branch name reaches an argument vector, a `.git` path and a
 * remote, so the accepted set is the smallest that serves the naming scheme.
 */
export function assertSafeRefName(name: string): string {
  const value = String(name);

  if (value.length === 0 || value.length > 200) {
    throw new UnsafeRemoteUrlError('a branch name must be between 1 and 200 characters');
  }
  if (hasControlCharacter(value)) {
    throw new UnsafeRemoteUrlError('a branch name must not contain a control character');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new UnsafeRemoteUrlError(
      'a branch name may contain only letters, digits, dot, underscore, slash and hyphen',
    );
  }
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) {
    throw new UnsafeRemoteUrlError('a branch name must not begin with a hyphen or slash, or end with a slash');
  }
  // git's own rules, the ones that would cause a confusing failure later.
  if (value.includes('..') || value.includes('//') || value.endsWith('.lock') || value.endsWith('.')) {
    throw new UnsafeRemoteUrlError('a branch name must not contain .. or //, or end with . or .lock');
  }

  return value;
}
