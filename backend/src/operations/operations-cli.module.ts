import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppPolicyModule } from '../app-policy/app-policy.module.js';
import { EnvironmentModule } from '../config/environment.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { databaseOptions } from '../infrastructure/database.module.js';
import { UsersModule } from '../users/users.module.js';
import { PolicyCommand } from './policy-command.js';
import { FirebaseModule } from '../auth/firebase.module.js';
import {
  AdminAccess,
  AdminAccessSchema,
} from '../admin/admin-access.schema.js';
import {
  AdminOwnerFence,
  AdminOwnerFenceSchema,
} from '../admin/admin-owner-fence.schema.js';
import { AdminCommand } from './admin-command.js';

@Module({
  imports: [
    EnvironmentModule,
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => databaseOptions(config, false),
    }),
    UsersModule,
    DevicesModule,
    AppPolicyModule,
    FirebaseModule,
    MongooseModule.forFeature([
      { name: AdminAccess.name, schema: AdminAccessSchema },
      { name: AdminOwnerFence.name, schema: AdminOwnerFenceSchema },
    ]),
  ],
  providers: [PolicyCommand, AdminCommand],
})
export class OperationsCliModule {}
