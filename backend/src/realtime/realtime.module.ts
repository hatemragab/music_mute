import { LocalMediaSyncsModule } from '../local-media-syncs/local-media-syncs.module.js';
import { AdminNotificationsModule } from '../admin-notifications/admin-notifications.module.js';
import { RealtimeSocketService } from './realtime-socket.service.js';
import { QueueProjectionService } from './queue-projection.service.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { AdminJobsModule } from '../admin-jobs/admin-jobs.module.js';
import { AdminHealthModule } from '../admin-observability/admin-health.module.js';
import { AdminObservabilityModule } from '../admin-observability/admin-observability.module.js';
import { AdminSettingsModule } from '../admin-settings/admin-settings.module.js';
import { AdminUsersModule } from '../admin-users/admin-users.module.js';
import { AudioProcessingModule } from '../processing/processing.module.js';
import { ReleasesModule } from '../releases/releases.module.js';
import { WorkerFleetModule } from '../worker-fleet/worker-fleet.module.js';
import { RealtimeResourcesService } from './realtime-resources.service.js';
import { RealtimeFeedModule } from './realtime-feed.module.js';
import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { FirebaseModule } from '../auth/firebase.module.js';
import { RateLimitsModule } from '../rate-limits/rate-limits.module.js';
import { UsersModule } from '../users/users.module.js';
import { RealtimeAuthService } from './realtime-auth.service.js';
import {
  AdminRealtimeTicketController,
  RealtimeTicketController,
} from './realtime-ticket.controller.js';

@Module({
  imports: [
    RealtimeFeedModule,
    ProcessingPersistenceModule,
    AdminModule,
    FirebaseModule,
    RateLimitsModule,
    UsersModule,
    AdminJobsModule,
    AdminHealthModule,
    AdminObservabilityModule,
    AdminSettingsModule,
    AdminUsersModule,
    AudioProcessingModule,
    LocalMediaSyncsModule,
    ReleasesModule,
    WorkerFleetModule,
    AdminNotificationsModule,
  ],
  controllers: [RealtimeTicketController, AdminRealtimeTicketController],
  providers: [
    QueueProjectionService,
    RealtimeSocketService,
    RealtimeAuthService,
    RealtimeResourcesService,
  ],
  exports: [RealtimeAuthService, RealtimeSocketService],
})
export class RealtimeModule {}
