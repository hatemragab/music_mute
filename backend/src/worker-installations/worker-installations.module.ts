import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { AudioProcessingModule } from '../processing/processing.module.js';
import {
  InstallationOperation,
  InstallationOperationSchema,
  WorkerInstallation,
  WorkerInstallationSchema,
} from './worker-installation.schema.js';
import { InstallationPairingService } from './installation-pairing.service.js';
import { InstallationLimitsService } from './installation-limits.service.js';
import {
  AdminWorkerInstallationsController,
  WorkerInstallationsController,
  PermanentWorkerQualificationController,
} from './worker-installations.controller.js';
@Module({
  imports: [
    AdminModule,
    AudioProcessingModule,
    MongooseModule.forFeature([
      { name: WorkerInstallation.name, schema: WorkerInstallationSchema },
      { name: InstallationOperation.name, schema: InstallationOperationSchema },
    ]),
  ],
  providers: [InstallationPairingService, InstallationLimitsService],
  controllers: [
    WorkerInstallationsController,
    AdminWorkerInstallationsController,
    PermanentWorkerQualificationController,
  ],
  exports: [
    InstallationPairingService,
    InstallationLimitsService,
    MongooseModule,
  ],
})
export class WorkerInstallationsModule {}
