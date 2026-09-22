import { Module } from '@nestjs/common';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { SecurityModule } from './http/security.module.js';
import { HealthController } from './http/health.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { OperationsModule } from './operations/operations.module.js';
import { AudioProcessingModule } from './processing/processing.module.js';
import { PublicPagesModule } from './public-pages/public-pages.module.js';
import { AdminModule } from './admin/admin.module.js';
import { ReleasesModule } from './releases/releases.module.js';
import { AdminUsersModule } from './admin-users/admin-users.module.js';
import { AdminJobsModule } from './admin-jobs/admin-jobs.module.js';
import { AdminMediaModule } from './admin-jobs/admin-media.module.js';
import { AdminObservabilityModule } from './admin-observability/admin-observability.module.js';
import { AdminExportsModule } from './admin-exports/admin-exports.module.js';
import { AdminHealthModule } from './admin-observability/admin-health.module.js';
import { WorkerFleetModule } from './worker-fleet/worker-fleet.module.js';
import { AbuseProtectionModule } from './abuse-protection/abuse-protection.module.js';
import { WorkerHintsModule } from './worker-hints/worker-hints.module.js';

@Module({
  imports: [
    InfrastructureModule,
    SecurityModule,
    WorkerHintsModule,
    AuthModule,
    AbuseProtectionModule,
    OperationsModule,
    AudioProcessingModule,
    PublicPagesModule,
    AdminModule,
    ReleasesModule,
    AdminUsersModule,
    AdminJobsModule,
    AdminMediaModule,
    AdminObservabilityModule,
    AdminExportsModule,
    AdminHealthModule,
    WorkerFleetModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
