import { Global, Module } from '@nestjs/common';
import { AiBoundaryService } from './ai-boundary.service';

/**
 * Global so that the single egress chokepoint is one instance, visibly. Nothing
 * but the guarded model provider should inject it.
 */
@Global()
@Module({
  providers: [AiBoundaryService],
  exports: [AiBoundaryService],
})
export class AiBoundaryModule {}
