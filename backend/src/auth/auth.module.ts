import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FirebaseModule } from './firebase.module.js';
import { UsersModule } from '../users/users.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { AppPolicyModule } from '../app-policy/app-policy.module.js';
import { RateLimitsModule } from '../rate-limits/rate-limits.module.js';
import { AuthGuard } from './auth.guard.js';
import { ProcessingAccessGuard } from '../app-policy/processing-access.guard.js';
import { AuthController } from './auth.controller.js';
import { UsersController } from '../users/users.controller.js';
import { DevicesController } from '../devices/devices.controller.js';
import { AppPolicyController } from '../app-policy/app-policy.controller.js';
import { AuthService } from './auth.service.js';
import { AuthMailService } from './auth-mail.service.js';
import { FirebaseMailService } from './firebase-mail.service.js';
import { LogoutService } from './logout.service.js';

@Module({
  imports: [
    FirebaseModule,
    UsersModule,
    DevicesModule,
    AppPolicyModule,
    RateLimitsModule,
  ],
  controllers: [
    AuthController,
    UsersController,
    DevicesController,
    AppPolicyController,
  ],
  providers: [
    AuthService,
    AuthMailService,
    FirebaseMailService,
    LogoutService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ProcessingAccessGuard },
  ],
})
export class AuthModule {}
