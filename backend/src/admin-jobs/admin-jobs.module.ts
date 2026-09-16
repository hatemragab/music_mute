import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { User, UserSchema } from '../users/user.schema.js';
import { AdminJobsQueryService } from './admin-jobs-query.service.js';
import { AdminJobsController } from './admin-jobs.controller.js';
import { AdminJobActionsService } from './admin-job-actions.service.js';
import { JobActionsService } from '../jobs/job-actions.service.js';
import { EnqueueService } from '../jobs/enqueue.service.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { UsersModule } from '../users/users.module.js';
import { AdminSettingsModule } from '../admin-settings/admin-settings.module.js';
import { ProcessingUnavailableService } from '../processing/processing-unavailable.service.js';
@Module({
  imports: [
    AdminModule,
    UsersModule,
    AdminSettingsModule,
    ProcessingPersistenceModule,
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
  ],
  providers: [
    AdminJobsQueryService,
    AdminJobActionsService,
    JobActionsService,
    EnqueueService,
    ProcessingTransactions,
    ProcessingUnavailableService,
  ],
  controllers: [AdminJobsController],
  exports: [AdminJobsQueryService],
})
export class AdminJobsModule {}
