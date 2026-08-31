import { Global, Module } from '@nestjs/common';
import { EnvelopeEncryptionSecretsProvider } from './envelope-secrets.provider';
import { SECRETS_PROVIDER } from './secrets.provider';

/**
 * Binds the secrets provider. Only the envelope provider is implemented; the
 * `vault` setting is rejected here rather than silently falling back, so that a
 * deployment configured for Vault cannot start on the development provider.
 */
@Global()
@Module({
  providers: [
    EnvelopeEncryptionSecretsProvider,
    {
      provide: SECRETS_PROVIDER,
      useExisting: EnvelopeEncryptionSecretsProvider,
    },
  ],
  exports: [SECRETS_PROVIDER],
})
export class SecretsModule {}
