import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './core/config/config.module';
import { DatabaseModule } from './core/database/database.module';
import { RedisModule } from './core/redis/redis.module';
import { ProcessModule } from './core/process/process.module';
import { AiBoundaryModule } from './core/ai-boundary/ai-boundary.module';
import { SecretsModule } from './core/secrets/secrets.module';
import { AuditModule } from './core/audit/audit.module';
import { AuthzModule } from './core/authz/authz.module';
import { EventsModule } from './core/events/events.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { HealthModule } from './modules/health/health.module';
import { ModelSettingsModule } from './modules/organizations/model-settings.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AgentModule } from './agent/agent.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { AuditController } from './modules/organizations/audit.controller';

/**
 * The application root, shared by both entry points: the API (main.ts) and the
 * agent worker (worker.ts). One module graph, two processes (ADR-016).
 *
 * ConfigModule is first so that a configuration failure aborts the boot before a
 * database or Redis connection is opened.
 *
 * JwtAuthGuard is registered globally, which makes authentication the default:
 * a new endpoint is protected unless it is explicitly marked @Public.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    ProcessModule,
    AiBoundaryModule,
    SecretsModule,
    AuditModule,
    AuthzModule,
    EventsModule,
    AuthModule,
    HealthModule,
    ModelSettingsModule,
    OrganizationsModule,
    ProjectsModule,
    AgentModule,
    TasksModule,
    ApprovalsModule,
    RealtimeModule,
  ],
  controllers: [AuditController],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
