import { Global, Module } from '@nestjs/common';
import { ModelSettingsService } from './model-settings.service';
import { OdooSettingsService } from './odoo-settings.service';
import { OdooVersionsService } from './odoo-versions.service';
import { GitCredentialsService } from './git-credentials.service';

/**
 * Deployment settings: the model provider chain, the Odoo estate, and
 * registered git credentials.
 *
 * Global, and separate from the controller that exposes it, because the agent
 * runtime needs `ModelSettingsService` and the controller needs
 * `ModelProviderResolver`, which needs the agent module. Keeping the services in
 * a module that imports nothing from the agent keeps that graph acyclic.
 */
@Global()
@Module({
  providers: [
    ModelSettingsService,
    OdooSettingsService,
    OdooVersionsService,
    GitCredentialsService,
  ],
  exports: [
    ModelSettingsService,
    OdooSettingsService,
    OdooVersionsService,
    GitCredentialsService,
  ],
})
export class ModelSettingsModule {}
