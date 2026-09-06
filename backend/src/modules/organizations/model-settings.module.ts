import { Global, Module } from '@nestjs/common';
import { ModelSettingsService } from './model-settings.service';
import { OdooSettingsService } from './odoo-settings.service';

/**
 * The organisation's model provider configuration (ADR-023) and its Odoo paths
 * (ADR-033).
 *
 * Global, and separate from OrganizationsModule, to keep the module graph
 * acyclic. The agent's `ModelProviderResolver` needs this service, and this
 * module's own controller endpoints need the resolver; putting the service here
 * means neither module has to import the other. The Odoo settings live here for
 * the same reason: the workspace layer reads them, and so does the controller.
 *
 * It depends on nothing from the agent layer, which is what makes that possible.
 */
@Global()
@Module({
  providers: [ModelSettingsService, OdooSettingsService],
  exports: [ModelSettingsService, OdooSettingsService],
})
export class ModelSettingsModule {}
