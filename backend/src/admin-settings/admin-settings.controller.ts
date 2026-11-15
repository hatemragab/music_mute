import { Body, Controller, Get, Header, Put, Query, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import { LimitOperation, OptionalAuth } from '../auth/auth.decorators.js';
import {
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { UpdateAccountPolicyDto } from './dto/account-policy.dto.js';
import { AccountPolicyService } from './account-policy.service.js';
import { jobError } from '../jobs/job-errors.js';
import { parseCloudflareLocation } from '../devices/cloudflare-location.js';

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
  @OptionalAuth()
  @LimitOperation('processing-read')
  @Header('Cache-Control', 'no-store')
  current(@Query() query: Record<string, unknown>, @Req() req: AuthRequest) {
    if (
      Object.keys(query).some(
        (key) => !['schemaVersion', 'mediaLimitsVersion'].includes(key),
      ) ||
      (query.schemaVersion !== undefined &&
        typeof query.schemaVersion !== 'string') ||
      (query.mediaLimitsVersion !== undefined &&
        typeof query.mediaLimitsVersion !== 'string')
    ) {
      throw jobError('PROCESSING_POLICY_INCOMPATIBLE');
    }
    return this.policies.publicPolicy(
      query.schemaVersion,
      query.mediaLimitsVersion,
      parseCloudflareLocation(req.headers).country,
      req.user?._id.toHexString() ?? null,
    );
  }
}
