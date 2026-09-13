import { QueuePolicyService } from './queue-policy.service.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { UsersModule } from '../users/users.module.js';
import {
  AdminSettingsController,
  ProcessingPolicyController,
} from './admin-settings.controller.js';
import { ProcessingAdmissionService } from './processing-admission.service.js';
import {
  ProcessingAdmissionFence,
  ProcessingAdmissionFenceSchema,
  ProcessingSettings,
  ProcessingSettingsSchema,
} from './processing-settings.schema.js';
import { ProcessingSettingsService } from './processing-settings.service.js';

@Module({
  imports: [
    AdminModule,
    UsersModule,
    ProcessingPersistenceModule,
    MongooseModule.forFeature([
      { name: ProcessingSettings.name, schema: ProcessingSettingsSchema },
      {
        name: ProcessingAdmissionFence.name,
        schema: ProcessingAdmissionFenceSchema,
      },
    ]),
  ],
  controllers: [AdminSettingsController, ProcessingPolicyController],
  providers: [
    ProcessingSettingsService,
    ProcessingAdmissionService,
    QueuePolicyService,
  ],
  exports: [
    MongooseModule,
    ProcessingSettingsService,
    ProcessingAdmissionService,
  ],
})
export class AdminSettingsModule {}
