import { Global, Module } from '@nestjs/common';
import { CommandRunner } from './command-runner.service';

/**
 * Global so that the single process-spawning chokepoint is reachable without
 * each module importing it, and so that there is visibly one instance.
 */
@Global()
@Module({
  providers: [CommandRunner],
  exports: [CommandRunner],
})
export class ProcessModule {}
