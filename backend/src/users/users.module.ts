import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './user.schema.js';
import { UsersService } from './users.service.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { AccountAccessService } from './account-access.service.js';
import {
  UserIdentityFence,
  UserIdentityFenceSchema,
} from './user-identity-fence.schema.js';
import { UserIdentityFenceService } from './user-identity-fence.service.js';
import {
  AccountRecoveryRequest,
  AccountRecoveryRequestSchema,
} from './account-recovery-request.schema.js';
import { AccountRecoveryService } from './account-recovery.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: UserIdentityFence.name, schema: UserIdentityFenceSchema },
      {
        name: AccountRecoveryRequest.name,
        schema: AccountRecoveryRequestSchema,
      },
    ]),
  ],
  providers: [
    UsersService,
    AccountDeletionService,
    AccountAccessService,
    UserIdentityFenceService,
    AccountRecoveryService,
  ],
  exports: [
    UsersService,
    AccountDeletionService,
    AccountAccessService,
    UserIdentityFenceService,
    AccountRecoveryService,
    MongooseModule,
  ],
})
export class UsersModule {}
