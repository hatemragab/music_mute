import { ResetAccountUsageDto } from './reset-account-usage.dto.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  HttpCode,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { AdminUsersService } from './admin-users.service.js';
import { PutWorkerRegistrationDto } from './worker-registration.dto.js';
import {
  DeleteAccountPolicyOverrideDto,
  PutAccountPolicyOverrideDto,
} from '../admin-settings/dto/account-policy.dto.js';

@Controller('admin/users')
@RequireAdminPermission('users.read')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.users.list(query);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.users.detail(id);
  }

  @Put(':id/worker-registration')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('users.worker-registration.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  workerRegistration(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: PutWorkerRegistrationDto,
  ) {
    return this.users.putWorkerRegistration(request.adminActor!, id, body);
  }

  @Get(':id/account-usage')
  @Header('Cache-Control', 'no-store')
  usage(@Param('id') id: string) {
    return this.users.accountUsage(id);
  }

  @Post(':id/account-usage-resets')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('users.processing.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  resetUsage(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: ResetAccountUsageDto,
  ) {
    return this.users.resetUsage(request.adminActor!, id, body);
  }

  @Put(':id/account-policy-override')
  @RequireAdminPermission('users.processing.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  policyOverride(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: PutAccountPolicyOverrideDto,
  ) {
    return this.users.putPolicyOverride(request.adminActor!, id, body);
  }

  @Delete(':id/account-policy-override')
  @RequireAdminPermission('users.processing.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  clearPolicyOverride(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: DeleteAccountPolicyOverrideDto,
  ) {
    return this.users.deletePolicyOverride(request.adminActor!, id, body);
  }
}
