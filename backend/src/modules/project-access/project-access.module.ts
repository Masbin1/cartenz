import { Module } from '@nestjs/common';
import { ProjectAccessController } from './project-access.controller';
import { ProjectAccessService } from './project-access.service';

@Module({
  controllers: [ProjectAccessController],
  providers: [ProjectAccessService],
  exports: [ProjectAccessService],
})
export class ProjectAccessModule {}
