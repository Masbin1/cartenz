import { Module } from '@nestjs/common';
import { AiOfficeController } from './ai-office.controller';
import { AiOfficeService } from './ai-office.service';

/**
 * AI Office board (ADR-066). Read-only aggregation over tasks and actions.
 *
 * AuthorizationService comes from the global AuthzModule, so nothing is imported
 * here; like every other route, the board is authorised by injecting it.
 */
@Module({
  controllers: [AiOfficeController],
  providers: [AiOfficeService],
})
export class AiOfficeModule {}
