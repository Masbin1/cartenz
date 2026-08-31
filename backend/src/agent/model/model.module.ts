import { Global, Module } from '@nestjs/common';
import { ModelProviderResolver } from './model-provider-resolver';

/**
 * Binds the model provider resolver (ADR-03, ADR-020, ADR-023).
 *
 * The important property of this module is still what it does *not* export.
 * `AiSdkModelProvider` and `ScriptedModelProvider` are constructed inside the
 * resolver and never exposed, so there is no way for a caller to obtain one and
 * reach a provider without the AI data boundary. That is a structural guarantee
 * rather than a convention, which is what chapter 12 requires of an egress
 * control.
 *
 * What changed in ADR-023 is *when* the provider is chosen. It used to be bound
 * once at boot from the environment; it is now built per organisation from that
 * organisation's stored configuration, falling back to the environment. The
 * boundary wrapping is identical in both cases.
 */
@Global()
@Module({
  providers: [ModelProviderResolver],
  exports: [ModelProviderResolver],
})
export class ModelModule {}
