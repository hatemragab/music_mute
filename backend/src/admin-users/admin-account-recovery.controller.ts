import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { AdminAccountRecoveryService } from './admin-account-recovery.service.js';
import { AdminAccountRecoveryDecisionDto } from './dto/admin-account-recovery.dto.js';

@Controller('admin/account-recovery-requests')
@RequireAdminPermission('users.account-recovery.manage')
export class AdminAccountRecoveryController {
  constructor(private readonly recovery: AdminAccountRecoveryService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.recovery.list(query);
  }

  @Get('summary')
  summary() {
    return this.recovery.summary();
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.recovery.detail(id);
  }

  @Post(':id/approve')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  approve(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: AdminAccountRecoveryDecisionDto,
  ) {
    return this.recovery.decide(request.adminActor!, id, body, true);
  }

  @Post(':id/reject')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  reject(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: AdminAccountRecoveryDecisionDto,
  ) {
    return this.recovery.decide(request.adminActor!, id, body, false);
  }
}
