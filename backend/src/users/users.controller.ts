import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import {
  AllowAccountRecovery,
  AllowDeletionRetry,
  LimitOperation,
} from '../auth/auth.decorators.js';
import { EmptyBodyPipe } from '../auth/dto/empty-body.pipe.js';
import { AccountDeletionService } from './account-deletion.service.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { presentUser } from './users.presenter.js';
import { UsersService } from './users.service.js';
import { AccountRecoveryService } from './account-recovery.service.js';
import { AccountRecoveryRequestDto } from './dto/account-recovery.dto.js';

@Controller('users/me')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly deletion: AccountDeletionService,
    private readonly recovery: AccountRecoveryService,
  ) {}
  @Delete()
  @HttpCode(202)
  @AllowDeletionRetry()
  @LimitOperation('profile')
  deleteAccount(@Req() req: AuthRequest, @Body(EmptyBodyPipe) _body: void) {
    return this.deletion.requestDeletion(
      req.user!._id.toHexString(),
      req.identity!.authTimeSec,
    );
  }
  @Get('account-recovery')
  @AllowAccountRecovery()
  recoveryStatus(@Req() req: AuthRequest) {
    return this.recovery.status(req.user!._id.toHexString());
  }

  @Post('account-recovery')
  @HttpCode(202)
  @AllowAccountRecovery()
  requestRecovery(
    @Req() req: AuthRequest,
    @Body() body: AccountRecoveryRequestDto,
  ) {
    return this.recovery.request(req.user!._id.toHexString(), body);
  }
  @Get()
  async me(@Req() req: AuthRequest) {
    await this.users.recordActivity(req.user!._id.toHexString());
    return presentUser(req.user!);
  }
}
