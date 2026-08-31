import { Global, Module } from '@nestjs/common';
import { ModelSettingsService } from './model-settings.service';

/**
 * The organisation's model provider configuration (ADR-023).
 *
 * Global, and separate from OrganizationsModule, to keep the module graph
 * acyclic. The agent's `ModelProviderResolver` needs this service, and this
 * module's own controller endpoints need the resolver; putting the service here
 * means neither module has to import the other.
 *
 * It depends on nothing from the agent layer, which is what makes that possible.
 */
@Global()
@Module({
  providers: [ModelSettingsService],
  exports: [ModelSettingsService],
})
export class ModelSettingsModule {}
