import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import {
  AdminRoute,
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { MacosUpdateService } from './macos-update.service.js';

@Controller('admin/macos-updates')
@AdminRoute()
export class AdminMacosUpdatesController {
  constructor(private readonly updates: MacosUpdateService) {}
  @Get('configuration')
  @RequireAdminPermission('releases.read')
  configuration() {
    return this.updates.readConfiguration();
  }
  @Put('configuration')
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  configure(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.updates.configure(request.adminActor!, body);
  }
  @Get()
  @RequireAdminPermission('releases.read')
  list(@Query() query: Record<string, unknown>) {
    return this.updates.list(query);
  }
  @Get(':id')
  @RequireAdminPermission('releases.read')
  detail(@Param('id') id: string) {
    return this.updates.detail(id);
  }
  @Post()
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  create(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.updates.create(request.adminActor!, body);
  }
  @Post(':id/completions')
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  complete(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.updates.complete(request.adminActor!, id, body);
  }
  @Post(':id/uploads')
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  upload(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.updates.upload(request.adminActor!, id, body);
  }
  @Post(':id/publications')
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  publish(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.updates.mutate(request.adminActor!, id, 'publish', body);
  }
  @Post(':id/withdrawals')
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  withdraw(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.updates.mutate(request.adminActor!, id, 'withdraw', body);
  }
}
