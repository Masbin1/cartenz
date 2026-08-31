import { Global, Module } from '@nestjs/common';
import { AppConfig, loadConfig } from './configuration';

/** Injection token for the validated application configuration. */
export const APP_CONFIG = 'APP_CONFIG';

/**
 * Global module supplying the validated configuration. Registered first in
 * AppModule so that a configuration failure aborts the boot before any
 * connection is opened.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
