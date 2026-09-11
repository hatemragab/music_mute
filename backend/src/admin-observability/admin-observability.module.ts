import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { ReleasesModule } from '../releases/releases.module.js';
import { AdminOverviewService } from './admin-overview.service.js';
import { AdminOverviewController } from './admin-overview.controller.js';
@Module({
  imports: [AdminModule, ProcessingPersistenceModule, ReleasesModule],
  providers: [AdminOverviewService],
  controllers: [AdminOverviewController],
  exports: [AdminOverviewService],
})
export class AdminObservabilityModule {}
