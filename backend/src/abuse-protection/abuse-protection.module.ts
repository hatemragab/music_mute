import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { AdminSettingsModule } from '../admin-settings/admin-settings.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import {
  AbuseEventBucket,
  AbuseEventBucketSchema,
  AbuseMonthlySummary,
  AbuseMonthlySummarySchema,
} from './abuse-event.schema.js';
import {
  AccountRestriction,
  AccountRestrictionSchema,
} from './account-restriction.schema.js';
import { AbuseEventsService } from './abuse-events.service.js';
import { AccountRestrictionsService } from './account-restrictions.service.js';
import { RestrictionJobsService } from './restriction-jobs.service.js';
import { AdminAbuseProtectionService } from './admin-abuse-protection.service.js';
import { AdminAbuseProtectionController } from './admin-abuse-protection.controller.js';
import { AbuseEventInterceptor } from './abuse-event.interceptor.js';
import { UsersModule } from '../users/users.module.js';

@Global()
@Module({
  imports: [
    AdminModule,
    AdminSettingsModule,
    ProcessingPersistenceModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: AbuseEventBucket.name, schema: AbuseEventBucketSchema },
      { name: AbuseMonthlySummary.name, schema: AbuseMonthlySummarySchema },
      { name: AccountRestriction.name, schema: AccountRestrictionSchema },
    ]),
  ],
  controllers: [AdminAbuseProtectionController],
  providers: [
    AbuseEventsService,
    AccountRestrictionsService,
    RestrictionJobsService,
    AdminAbuseProtectionService,
    { provide: APP_INTERCEPTOR, useClass: AbuseEventInterceptor },
  ],
  exports: [
    MongooseModule,
    AbuseEventsService,
    AccountRestrictionsService,
    AdminAbuseProtectionService,
  ],
})
export class AbuseProtectionModule {}
