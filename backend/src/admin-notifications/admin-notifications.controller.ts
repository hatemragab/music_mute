import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { CreateNotificationDto } from './create-notification.dto.js';
import { AdminNotificationsService } from './admin-notifications.service.js';
@Controller('admin/notifications')
@RequireAdminPermission('notifications.read')
export class AdminNotificationsController {
  constructor(private readonly notifications: AdminNotificationsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: Record<string, unknown>) {
    return this.notifications.list(query);
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(@Param('id') id: string) {
    return this.notifications.detail(id);
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('notifications.send')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  create(@Req() request: AuthRequest, @Body() dto: CreateNotificationDto) {
    return this.notifications.create(request.adminActor!, dto);
  }
}
