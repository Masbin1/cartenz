import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { secretDataKeys, secretRecords } from '../database/schema';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/configuration';
import {
  SecretNotFoundError,
  SecretReference,
  SecretWriteRequest,
  SecretsProvider,
} from './secrets.provider';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const DATA_KEY_BYTES = 32;

/** A sealed value. All three components are base64 encoded. */
interface SealedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Envelope encryption over PostgreSQL (ADR-014).
 *
 * A per-scope data key is generated on first use and sealed under the configured
 * root key; secret values are sealed under the data key. The root key exists
 * only in the process environment and is never written anywhere.
 *
 * This reproduces the key custody model Vault will provide - one key per
 * project, so that the compromise of one data key does not expose another -
 * without taking the operational dependency in the foundation milestone. It is
 * rejected by configuration validation in production.
 */
@Injectable()
export class EnvelopeEncryptionSecretsProvider implements SecretsProvider {
  private readonly rootKey: Buffer;

  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.rootKey = config.secrets.rootKey;
  }

  async write(request: SecretWriteRequest): Promise<SecretReference> {
    const dataKey = await this.resolveDataKey(request.organizationId, request.projectId);
    const sealed = this.seal(dataKey.key, Buffer.from(request.value, 'utf8'));
    const ref = mintReference(request.purpose);

    await this.database.db.insert(secretRecords).values({
      organizationId: request.organizationId,
      projectId: request.projectId,
      ref,
      dataKeyId: dataKey.id,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
    });

    return { ref };
  }

  async read(ref: string): Promise<string> {
    const [record] = await this.database.db
      .select()
      .from(secretRecords)
      .where(eq(secretRecords.ref, ref))
      .limit(1);

    if (!record) throw new SecretNotFoundError(ref);

    const [keyRow] = await this.database.db
      .select()
      .from(secretDataKeys)
      .where(eq(secretDataKeys.id, record.dataKeyId))
      .limit(1);

    if (!keyRow) throw new SecretNotFoundError(ref);

    const dataKey = this.unseal(this.rootKey, {
      ciphertext: keyRow.wrappedKey,
      iv: keyRow.iv,
      authTag: keyRow.authTag,
    });

    const plaintext = this.unseal(dataKey, {
      ciphertext: record.ciphertext,
      iv: record.iv,
      authTag: record.authTag,
    });

    return plaintext.toString('utf8');
  }

  async destroy(ref: string): Promise<void> {
    await this.database.db.delete(secretRecords).where(eq(secretRecords.ref, ref));
  }

  async exists(ref: string): Promise<boolean> {
    const [record] = await this.database.db
      .select({ id: secretRecords.id })
      .from(secretRecords)
      .where(eq(secretRecords.ref, ref))
      .limit(1);
    return record !== undefined;
  }

  /**
   * Returns the data key for a scope, generating and sealing one on first use.
   * The scope is the project where there is one, otherwise the organisation.
   */
  private async resolveDataKey(
    organizationId: string,
    projectId: string | null,
  ): Promise<{ id: string; key: Buffer }> {
    const scopeMatch = projectId
      ? and(
          eq(secretDataKeys.organizationId, organizationId),
          eq(secretDataKeys.projectId, projectId),
        )
      : and(
          eq(secretDataKeys.organizationId, organizationId),
          isNull(secretDataKeys.projectId),
        );

    const [existing] = await this.database.db
      .select()
      .from(secretDataKeys)
      .where(scopeMatch)
      .limit(1);

    if (existing) {
      return {
        id: existing.id,
        key: this.unseal(this.rootKey, {
          ciphertext: existing.wrappedKey,
          iv: existing.iv,
          authTag: existing.authTag,
        }),
      };
    }

    const key = randomBytes(DATA_KEY_BYTES);
    const wrapped = this.seal(this.rootKey, key);

    const [created] = await this.database.db
      .insert(secretDataKeys)
      .values({
        organizationId,
        projectId,
        wrappedKey: wrapped.ciphertext,
        iv: wrapped.iv,
        authTag: wrapped.authTag,
      })
      .returning({ id: secretDataKeys.id });

    return { id: created.id, key };
  }

  private seal(key: Buffer, plaintext: Buffer): SealedValue {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  private unseal(key: Buffer, sealed: SealedValue): Buffer {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]);
  }
}

/**
 * Builds an opaque reference. The purpose is included so that an operator
 * reading a connection row can tell what a reference is for; the random suffix
 * makes references unguessable and unique.
 */
function mintReference(purpose: string): string {
  const normalised = purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return `secret:${normalised || 'credential'}:${randomUUID()}`;
}
