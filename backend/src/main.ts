import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Server } from 'node:http';
import { loadDefaultDotEnv } from './core/config/dotenv';
import { AppModule } from './app.module';
import { APP_CONFIG } from './core/config/config.module';
import type { AppConfig } from './core/config/configuration';
import { AllExceptionsFilter } from './core/http/all-exceptions.filter';
import { TaskEventsGateway } from './modules/realtime/task-events.gateway';

/**
 * API entry point.
 *
 * The environment is loaded before the Nest container is created, because
 * ConfigModule validates it during instantiation and must fail the boot rather
 * than the first request.
 */
async function bootstrap(): Promise<void> {
  loadDefaultDotEnv();

  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest's own logger, at a level that shows lifecycle without being noisy.
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get<AppConfig>(APP_CONFIG);

  app.setGlobalPrefix('api/v1');

  /**
   * Whitelist and forbid: a request carrying a property the DTO does not declare
   * is rejected rather than silently stripped, so a client sending an
   * unrecognised field is told rather than left believing it took effect.
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableCors({
    origin: [...config.api.corsOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Shutdown hooks drive OnApplicationShutdown on the pool, the Redis
  // connections and the queue, so a container stop closes them cleanly.
  app.enableShutdownHooks();

  await app.listen(config.api.port, config.api.host);

  // The WebSocket server shares the HTTP server, so one port and one proxy
  // route serve both REST and realtime.
  const gateway = app.get(TaskEventsGateway);
  gateway.attach(app.getHttpServer() as Server, '/ws');

  logger.log(`API listening on http://${config.api.host}:${config.api.port}/api/v1`);
  logger.log(`Environment: ${config.env}; AI provider: ${config.ai.provider}`);

  if (config.secrets.provider === 'envelope') {
    logger.warn(
      'Secrets are held by the envelope provider (ADR-014). Not permitted in production.',
    );
  }
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`Failed to start the API: ${(error as Error).message}\n`);
  process.exit(1);
});
