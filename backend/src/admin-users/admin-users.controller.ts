import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminUserProcessingDto } from './dto/admin-user.dto.js';

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

  @Post(':id/suspend-processing')
  @RequireAdminPermission('users.processing.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  suspend(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: AdminUserProcessingDto,
  ) {
    return this.users.suspend(request.adminActor!, id, body);
  }

  @Post(':id/resume-processing')
  @RequireAdminPermission('users.processing.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  resume(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: AdminUserProcessingDto,
  ) {
    return this.users.resume(request.adminActor!, id, body);
  }
}
