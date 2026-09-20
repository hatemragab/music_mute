import { Body, Controller, Get, Header, Put, Query, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import { Public } from '../auth/auth.decorators.js';
import {
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { UpdateAccountPolicyDto } from './dto/account-policy.dto.js';
import { AccountPolicyService } from './account-policy.service.js';

@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly policies: AccountPolicyService) {}

  @Get('account-policy')
  @RequireAdminPermission('settings.read')
  current() {
    return this.policies.current();
  }

  @Put('account-policy')
  @RequireAdminPermission('settings.manage')
  @RequireFreshAdminAuth()
  update(@Req() request: AuthRequest, @Body() dto: UpdateAccountPolicyDto) {
    return this.policies.update(request.adminActor!, dto);
  }
}

@Controller('processing-policy')
export class ProcessingPolicyController {
  constructor(private readonly policies: AccountPolicyService) {}

  @Get()
  @Public()
  @Header('Cache-Control', 'no-store')
  current(@Query('schemaVersion') schemaVersion?: string) {
    return this.policies.publicPolicy(schemaVersion);
  }
}
