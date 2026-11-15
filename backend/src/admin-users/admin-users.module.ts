import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { AdminSettingsModule } from '../admin-settings/admin-settings.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminAccountRecoveryController } from './admin-account-recovery.controller.js';
import { AdminAccountRecoveryService } from './admin-account-recovery.service.js';

@Module({
  imports: [
    AdminModule,
    AdminSettingsModule,
    ProcessingPersistenceModule,
    UsersModule,
  ],
  controllers: [AdminUsersController, AdminAccountRecoveryController],
  providers: [AdminUsersService, AdminAccountRecoveryService],
})
export class AdminUsersModule {}
