import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { AdminObservabilityModule } from '../admin-observability/admin-observability.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { AdminExportsController } from './admin-exports.controller.js';
import { AdminExportsService } from './admin-exports.service.js';

@Module({
  imports: [AdminModule, AdminObservabilityModule, ProcessingPersistenceModule],
  controllers: [AdminExportsController],
  providers: [AdminExportsService],
})
export class AdminExportsModule {}
