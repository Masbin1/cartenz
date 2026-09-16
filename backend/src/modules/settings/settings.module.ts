import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { AuditController } from './audit.controller';
import { ModelSettingsModule } from './model-settings.module';

/**
 * The settings surface at /api/v1/settings (ADR-023, ADR-033, ADR-044).
 *
 * Only the controllers are declared here. The services (`ModelSettingsService`,
 * `OdooSettingsService`), the resolver (`ModelProviderResolver`) and the guard
 * helpers (`AuthorizationService`, `AuditService`) all come from `@Global()`
 * modules, so importing `ModelSettingsModule` here is for readability rather
 * than necessity.
 */
@Module({
  imports: [ModelSettingsModule],
  controllers: [SettingsController, AuditController],
})
export class SettingsModule {}
