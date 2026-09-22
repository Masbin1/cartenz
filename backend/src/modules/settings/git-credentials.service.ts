import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { gitCredentials } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { normalizePrivateKey } from '../../agent/git/git-credentials';
import { assertSafeRemoteUrl } from '../../agent/git/git-url';
import { CREDENTIAL_KINDS, type CredentialKind } from '../../core/enums';

/**
 * One registered credential, as the portal is shown it (ADR-058).
 *
 * Deliberately has nowhere to put the value. The key is write-only across this
 * boundary: `hasValue` is the only thing said about it, and no endpoint returns
 * it. `hosts` and `note` are shown because they are what a person uses to tell
 * two credentials apart.
 */
export interface PublicGitCredential {
  readonly id: string;
  readonly label: string;
  readonly credentialKind: CredentialKind;
  readonly hosts: readonly string[];
  readonly isDefault: boolean;
  readonly enabled: boolean;
  readonly note: string | null;
  readonly hasValue: boolean;
  readonly lastVerifiedAt: Date | null;
  readonly lastVerifyError: string | null;
  readonly createdAt: Date;
}

export interface CreateGitCredentialInput {
  readonly label: string;
  readonly value: string;
  readonly credentialKind?: CredentialKind;
  readonly hosts?: readonly string[];
  readonly isDefault?: boolean;
  readonly note?: string | null;
}

export interface UpdateGitCredentialInput {
  readonly label?: string;
  /** Omitted leaves the stored value alone; the portal cannot read it back. */
  readonly value?: string;
  readonly credentialKind?: CredentialKind;
  readonly hosts?: readonly string[];
  readonly isDefault?: boolean;
  readonly enabled?: boolean;
  readonly note?: string | null;
}

/** What a caller about to reach a remote needs, without knowing where it came from. */
export interface ResolvedCredential {
  readonly kind: CredentialKind;
  readonly value: string;
  /** Which registered row it came from, or null when the caller supplied its own. */
  readonly credentialId: string | null;
  readonly secretRef: string | null;
}

/**
 * Deployment-wide git credentials (ADR-021, ADR-058).
 *
 * The problem: a credential could only be stored on a project connection, so
 * every connect-existing form asked again for the same SSH key. Re-pasting a key
 * is where the flattened-newline failure ("Load key ...: error in libcrypto")
 * kept happening, and no shared key meant rotating one meant editing every
 * project.
 *
 * Why deployment scope rather than per-user: Cartenz is operated by one team on
 * one host against repositories that belong to the organisation, not to the
 * person who happens to be signed in. A key registered here is available to
 * every project; `createdByUserId` records who added it.
 *
 * The value is sealed by the secrets provider under the global data key
 * (`projectId: null`), which the provider already supported for the provisioning
 * master password. Nothing about the value is ever returned by an endpoint.
 */
@Injectable()
export class GitCredentialsService {
  private readonly logger = new Logger(GitCredentialsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {}

  /** Every registered credential, default first. Never includes a value. */
  async list(): Promise<PublicGitCredential[]> {
    const rows = await this.database.db
      .select({
        id: gitCredentials.id,
        label: gitCredentials.label,
        credentialKind: gitCredentials.credentialKind,
        hosts: gitCredentials.hosts,
        isDefault: gitCredentials.isDefault,
        enabled: gitCredentials.enabled,
        note: gitCredentials.note,
        lastVerifiedAt: gitCredentials.lastVerifiedAt,
        lastVerifyError: gitCredentials.lastVerifyError,
        createdAt: gitCredentials.createdAt,
      })
      .from(gitCredentials)
      .orderBy(sql`${gitCredentials.isDefault} desc`, gitCredentials.label);

    return rows.map((row) => ({
      ...row,
      credentialKind: row.credentialKind as CredentialKind,
      hosts: row.hosts ?? [],
      hasValue: true,
    }));
  }

  async create(userId: string, input: CreateGitCredentialInput): Promise<PublicGitCredential> {
    const label = this.normaliseLabel(input.label);
    const kind = input.credentialKind ?? 'ssh_key';
    this.assertKind(kind);

    const value = this.normaliseValue(kind, input.value);
    const hosts = this.normaliseHosts(input.hosts ?? []);
    const note = this.normaliseNote(input.note);

    const reference = await this.secrets.write({
      // Deployment scope: one global data key, not a project's.
      projectId: null,
      purpose: `git-credential-${kind}`,
      value,
    });

    // The partial unique index would reject a second default anyway; clearing
    // first turns that into a working "make this the default" instead of a
    // constraint error naming an index.
    if (input.isDefault) await this.clearDefault();

    const [row] = await this.database.db
      .insert(gitCredentials)
      .values({
        label,
        secretRef: reference.ref,
        credentialKind: kind,
        hosts,
        isDefault: Boolean(input.isDefault),
        note,
        createdByUserId: userId,
      })
      .returning({ id: gitCredentials.id });

    await this.audit.record({
      event: AUDIT_EVENTS.GIT_CREDENTIAL_CREATED,
      userId,
      // The label and kind, never the value.
      metadata: { id: row.id, label, credentialKind: kind, isDefault: Boolean(input.isDefault) },
    });

    this.logger.log(`Git credential registered: ${label} (${kind})`);

    return this.getOrThrow(row.id);
  }

  async update(
    userId: string,
    id: string,
    input: UpdateGitCredentialInput,
  ): Promise<PublicGitCredential> {
    const existing = await this.findRow(id);
    if (!existing) throw new NotFoundException('No such git credential.');

    const kind = input.credentialKind ?? (existing.credentialKind as CredentialKind);
    this.assertKind(kind);

    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (input.label !== undefined) patch.label = this.normaliseLabel(input.label);
    if (input.hosts !== undefined) patch.hosts = this.normaliseHosts(input.hosts);
    if (input.note !== undefined) patch.note = this.normaliseNote(input.note);
    if (input.credentialKind !== undefined) patch.credentialKind = kind;

    /**
     * Disabling a credential also drops its default flag, because a disabled
     * default would make every form silently fall back to prompting for a value
     * while the settings page still showed a default as chosen.
     */
    if (input.enabled !== undefined) {
      patch.enabled = input.enabled;
      if (!input.enabled && existing.isDefault) patch.isDefault = false;
    }

    /**
     * Replacing the value writes a new secret and destroys the old one only
     * after the row points at the new reference, so a failure in between leaves
     * the credential usable rather than broken.
     */
    let previousRef: string | null = null;
    if (input.value !== undefined && input.value.trim().length > 0) {
      const reference = await this.secrets.write({
        projectId: null,
        purpose: `git-credential-${kind}`,
        value: this.normaliseValue(kind, input.value),
      });
      previousRef = existing.secretRef;
      patch.secretRef = reference.ref;
      // A changed value invalidates whatever the last verify concluded.
      patch.lastVerifiedAt = null;
      patch.lastVerifyError = null;
    }

    if (input.isDefault === true) {
      await this.clearDefault(id);
      patch.isDefault = true;
    } else if (input.isDefault === false) {
      patch.isDefault = false;
    }

    await this.database.db.update(gitCredentials).set(patch).where(eq(gitCredentials.id, id));

    if (previousRef) {
      await this.secrets.destroy(previousRef).catch((error: Error) => {
        this.logger.warn(`Could not destroy superseded secret ${previousRef}: ${error.message}`);
      });
    }

    await this.audit.record({
      event: AUDIT_EVENTS.GIT_CREDENTIAL_UPDATED,
      userId,
      metadata: {
        id,
        label: (patch.label as string) ?? existing.label,
        credentialKind: kind,
        valueReplaced: previousRef !== null,
      },
    });

    return this.getOrThrow(id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const existing = await this.findRow(id);
    if (!existing) throw new NotFoundException('No such git credential.');

    await this.database.db.delete(gitCredentials).where(eq(gitCredentials.id, id));

    await this.secrets.destroy(existing.secretRef).catch((error: Error) => {
      this.logger.warn(`Could not destroy ${existing.secretRef}: ${error.message}`);
    });

    await this.audit.record({
      event: AUDIT_EVENTS.GIT_CREDENTIAL_REMOVED,
      userId,
      metadata: { id, label: existing.label },
    });

    this.logger.log(`Git credential removed: ${existing.label}`);
  }

  /**
   * The credential a caller should use, resolved without asking them.
   *
   * Precedence: an explicitly named id, then the default. Only an enabled row
   * is ever returned, so disabling is a real withdrawal rather than a label.
   *
   * `host` filters on the registered `hosts` list when that list is non-empty:
   * a credential registered for `github.com` is not offered to `gitlab.com`,
   * which keeps a default from being presented to a host it was never meant for.
   * An empty list means the operator registered it deliberately for any host.
   */
  async resolveForHost(options: {
    readonly credentialId?: string | null;
    readonly host?: string | null;
  }): Promise<ResolvedCredential | null> {
    const row = options.credentialId
      ? await this.findEnabledRow(options.credentialId)
      : await this.findDefault();

    if (!row) return null;

    const hosts = row.hosts ?? [];
    if (options.host && hosts.length > 0 && !hosts.includes(options.host.toLowerCase())) {
      throw new BadRequestException(
        `The credential "${row.label}" is registered for ${hosts.join(', ')}, not for ${options.host}.`,
      );
    }

    return {
      kind: row.credentialKind as CredentialKind,
      value: await this.secrets.read(row.secretRef),
      credentialId: row.id,
      secretRef: row.secretRef,
    };
  }

  /**
   * Proves a stored credential against a repository, and records the outcome.
   *
   * Worth an endpoint for the same reason the model provider test is: the
   * alternative way to discover a wrong key is a project whose first task fails
   * after cloning, and the `ls-remote` failure it produces ("error in libcrypto")
   * reads like a GitHub permissions problem rather than a bad paste.
   */
  async recordVerification(id: string, error: string | null): Promise<void> {
    await this.database.db
      .update(gitCredentials)
      .set({
        lastVerifiedAt: error ? null : new Date(),
        lastVerifyError: error,
        updatedAt: new Date(),
      })
      .where(eq(gitCredentials.id, id));
  }

  /** The label of the current default, for the creation form's own messaging. */
  async defaultLabel(): Promise<string | null> {
    return (await this.findDefault())?.label ?? null;
  }

  private async getOrThrow(id: string): Promise<PublicGitCredential> {
    const [row] = await this.list().then((rows) => rows.filter((entry) => entry.id === id));
    if (!row) throw new NotFoundException('No such git credential.');
    return row;
  }

  private async findRow(id: string) {
    const [row] = await this.database.db
      .select()
      .from(gitCredentials)
      .where(eq(gitCredentials.id, id))
      .limit(1);
    return row ?? null;
  }

  private async findEnabledRow(id: string) {
    const [row] = await this.database.db
      .select()
      .from(gitCredentials)
      .where(and(eq(gitCredentials.id, id), eq(gitCredentials.enabled, true)))
      .limit(1);
    return row ?? null;
  }

  private async findDefault() {
    const [row] = await this.database.db
      .select()
      .from(gitCredentials)
      .where(and(eq(gitCredentials.isDefault, true), eq(gitCredentials.enabled, true)))
      .limit(1);
    return row ?? null;
  }

  /** Clears the current default, excluding `exceptId` when it is the row being set. */
  private async clearDefault(exceptId?: string): Promise<void> {
    const condition = exceptId
      ? and(eq(gitCredentials.isDefault, true), ne(gitCredentials.id, exceptId))
      : eq(gitCredentials.isDefault, true);

    await this.database.db.update(gitCredentials).set({ isDefault: false }).where(condition);
  }

  private normaliseLabel(value: string): string {
    const label = (value ?? '').trim();
    if (label.length === 0) throw new BadRequestException('A label is required.');
    if (label.length > 120) throw new BadRequestException('The label is too long (max 120).');
    return label;
  }

  private assertKind(kind: string): void {
    if (!CREDENTIAL_KINDS.includes(kind as CredentialKind)) {
      throw new BadRequestException(`credentialKind must be one of: ${CREDENTIAL_KINDS.join(', ')}`);
    }
  }

  /**
   * Trims, and repairs an SSH key whose line breaks were lost in a paste.
   *
   * The repair is the same one the lease performs at use time; doing it at write
   * time means a credential that never had usable newlines is stored usable, and
   * the operator finds out on the settings page rather than on a project.
   */
  private normaliseValue(kind: CredentialKind, value: string): string {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0) throw new BadRequestException('A credential value is required.');
    if (trimmed.length > 16384) throw new BadRequestException('The credential is too long.');
    return kind === 'ssh_key' ? normalizePrivateKey(trimmed) : trimmed;
  }

  /**
   * Hosts are stored lowercased and without a port or trailing dot, so that
   * `GitHub.com:22` and `github.com` are the same host rather than two entries
   * that look identical to a person.
   */
  private normaliseHosts(hosts: readonly string[]): string[] {
    const cleaned = hosts
      .map((host) => (typeof host === 'string' ? host.trim().toLowerCase() : ''))
      .map((host) => host.replace(/^\[|\]$/g, '').replace(/:\d+$/, '').replace(/\.$/, ''))
      .filter((host) => host.length > 0);

    return [...new Set(cleaned)].slice(0, 32);
  }

  private normaliseNote(note: string | null | undefined): string | null {
    if (note === undefined || note === null) return null;
    const trimmed = note.trim();
    return trimmed.length === 0 ? null : trimmed.slice(0, 500);
  }

  /**
   * The host of a remote URL, for the `hosts` check. Uses the same parser as the
   * clone path so a URL cannot be one thing here and another there.
   */
  hostOf(repositoryUrl: string): string | null {
    try {
      return assertSafeRemoteUrl(repositoryUrl, { allowLocal: false }).host.toLowerCase();
    } catch {
      return null;
    }
  }
}
