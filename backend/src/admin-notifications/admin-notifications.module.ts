import { UsersModule } from '../users/users.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { FirebaseModule } from '../auth/firebase.module.js';
import { AudioProcessingModule } from '../processing/processing.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import {
  NotificationCampaign,
  NotificationCampaignSchema,
  CampaignDelivery,
  CampaignDeliverySchema,
} from './notification-campaign.schema.js';
import { AdminNotificationsController } from './admin-notifications.controller.js';
import { AdminNotificationsService } from './admin-notifications.service.js';
import { CampaignDispatcherService } from './campaign-dispatcher.service.js';
@Module({
  imports: [
    UsersModule,
    AdminModule,
    FirebaseModule,
    AudioProcessingModule,
    ProcessingPersistenceModule,
    MongooseModule.forFeature([
      { name: NotificationCampaign.name, schema: NotificationCampaignSchema },
      { name: CampaignDelivery.name, schema: CampaignDeliverySchema },
    ]),
  ],
  controllers: [AdminNotificationsController],
  providers: [AdminNotificationsService, CampaignDispatcherService],
  exports: [AdminNotificationsService],
})
export class AdminNotificationsModule {}
