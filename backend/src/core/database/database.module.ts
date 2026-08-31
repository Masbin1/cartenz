import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

/**
 * Global so that feature modules inject DatabaseService without each importing
 * the module. The service is a singleton holding one pool per process.
 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
