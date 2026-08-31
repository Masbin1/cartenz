import { Module, forwardRef } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { ApprovalsController } from './approvals.controller';
import { AgentModule } from '../../agent/agent.module';

@Module({
  imports: [forwardRef(() => AgentModule)],
  controllers: [ApprovalsController],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalsModule {}
