import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { AuditController } from './audit.controller';
import { ModelSettingsModule } from './model-settings.module';
import { AgentModule } from '../../agent/agent.module';

/**
 * The settings surface at /api/v1/settings (ADR-023, ADR-033, ADR-044, ADR-058).
 *
 * Only the controllers are declared here. The services (`ModelSettingsService`,
 * `OdooSettingsService`, `GitCredentialsService`), the resolver
 * (`ModelProviderResolver`) and the guard helpers (`AuthorizationService`,
 * `AuditService`) all come from `@Global()` modules, so importing
 * `ModelSettingsModule` here is for readability rather than necessity.
 *
 * `AgentModule` is the exception, and is a real import: testing a registered git
 * credential runs `git ls-remote` through `GitService`, which owns the
 * credential lease and the git hardening flags. Reaching a remote from a request
 * is exactly the path that must not be reimplemented.
 */
@Module({
  imports: [ModelSettingsModule, AgentModule],
  controllers: [SettingsController, AuditController],
})
export class SettingsModule {}
