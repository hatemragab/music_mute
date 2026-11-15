import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { UsersModule } from '../users/users.module.js';
import {
  AdminSettingsController,
  ProcessingPolicyController,
} from './admin-settings.controller.js';
import {
  ProcessingAdmissionFence,
  ProcessingAdmissionFenceSchema,
} from './processing-settings.schema.js';
import { ProcessingAdmissionService } from './processing-admission.service.js';
import {
  AccountPolicy,
  AccountPolicyOverride,
  AccountPolicyOverrideSchema,
  AccountPolicySchema,
} from './account-policy.schema.js';
import { AccountPolicyService } from './account-policy.service.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';

@Module({
  imports: [
    AdminModule,
    UsersModule,
    ProcessingPersistenceModule,
    MongooseModule.forFeature([
      { name: AccountPolicy.name, schema: AccountPolicySchema },
      {
        name: AccountPolicyOverride.name,
        schema: AccountPolicyOverrideSchema,
      },
      {
        name: ProcessingAdmissionFence.name,
        schema: ProcessingAdmissionFenceSchema,
      },
    ]),
  ],
  controllers: [AdminSettingsController, ProcessingPolicyController],
  providers: [
    AccountPolicyService,
    ProcessingUsageService,
    ProcessingAdmissionService,
  ],
  exports: [
    MongooseModule,
    AccountPolicyService,
    ProcessingUsageService,
    ProcessingAdmissionService,
  ],
})
export class AdminSettingsModule {}
