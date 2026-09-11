import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { FirebaseModule } from '../auth/firebase.module.js';
import { AdminAccess, AdminAccessSchema } from './admin-access.schema.js';
import { AdminAccessStartup } from './admin-access.startup.js';
import { AdminGuard } from './admin.guard.js';
import { AdminRateLimitService } from './admin-rate-limit.service.js';
import { AdminSessionController } from './admin-session.controller.js';
import {
  AdminAuditEvent,
  AdminAuditEventSchema,
} from './admin-audit.schema.js';
import {
  AdminOperation,
  AdminOperationSchema,
} from './admin-operation.schema.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminOperationsService } from './admin-operations.service.js';
import { AdminAuditController } from './admin-audit.controller.js';
import { AdminOperationsController } from './admin-operations.controller.js';
import { AdminAccessController } from './admin-access.controller.js';
import { AdminAccessService } from './admin-access.service.js';
import {
  AdminOwnerFence,
  AdminOwnerFenceSchema,
} from './admin-owner-fence.schema.js';

@Module({
  imports: [
    FirebaseModule,
    MongooseModule.forFeature([
      { name: AdminAccess.name, schema: AdminAccessSchema },
      { name: AdminAuditEvent.name, schema: AdminAuditEventSchema },
      { name: AdminOperation.name, schema: AdminOperationSchema },
      { name: AdminOwnerFence.name, schema: AdminOwnerFenceSchema },
    ]),
  ],
  controllers: [
    AdminSessionController,
    AdminAuditController,
    AdminOperationsController,
    AdminAccessController,
  ],
  providers: [
    AdminAccessStartup,
    AdminRateLimitService,
    AdminAuditService,
    AdminOperationsService,
    AdminAccessService,
    { provide: APP_GUARD, useClass: AdminGuard },
  ],
  exports: [
    MongooseModule,
    AdminRateLimitService,
    AdminAuditService,
    AdminOperationsService,
    AdminAccessService,
  ],
})
export class AdminModule {}
