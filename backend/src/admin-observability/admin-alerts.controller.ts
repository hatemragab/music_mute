import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RequireAdminPermission } from '../admin/admin.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { AdminAlertsService } from './admin-alerts.service.js';
import { AcknowledgeAdminAlertDto } from './dto/admin-alert.dto.js';

@Controller('admin/alerts')
export class AdminAlertsController {
  constructor(private readonly alerts: AdminAlertsService) {}

  @Get()
  @RequireAdminPermission('health.read')
  list(@Query() query: Record<string, unknown>) {
    return this.alerts.list(query);
  }

  @Post(':id/acknowledge')
  @RequireAdminPermission('alerts.manage')
  acknowledge(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: AcknowledgeAdminAlertDto,
  ) {
    return this.alerts.acknowledge(req.adminActor!, id, dto);
  }
}
