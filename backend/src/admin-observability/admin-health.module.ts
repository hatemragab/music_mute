import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { ReleasesModule } from '../releases/releases.module.js';
import { StorageTransfersModule } from '../storage/storage-transfers.module.js';
import { AdminAlert, AdminAlertSchema } from './admin-alert.schema.js';
import {
  AdminAlertObservation,
  AdminAlertObservationSchema,
} from './admin-alert-observation.schema.js';
import { AdminAlertsController } from './admin-alerts.controller.js';
import { AdminAlertsService } from './admin-alerts.service.js';
import { AdminHealthController } from './admin-health.controller.js';
import { AdminHealthService } from './admin-health.service.js';
import { HealthSamplerService } from './health-sampler.service.js';

@Module({
  imports: [
    AdminModule,
    ProcessingPersistenceModule,
    ReleasesModule,
    StorageTransfersModule,
    MongooseModule.forFeature([
      { name: AdminAlert.name, schema: AdminAlertSchema },
      {
        name: AdminAlertObservation.name,
        schema: AdminAlertObservationSchema,
      },
    ]),
  ],
  providers: [AdminAlertsService, HealthSamplerService, AdminHealthService],
  controllers: [AdminHealthController, AdminAlertsController],
  exports: [AdminAlertsService, HealthSamplerService],
})
export class AdminHealthModule {}
