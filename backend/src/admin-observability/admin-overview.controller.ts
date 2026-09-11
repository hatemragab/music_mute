import { Controller, Get, Query, Req } from '@nestjs/common';
import { RequireAdminPermission } from '../admin/admin.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { AdminOverviewService } from './admin-overview.service.js';
@Controller('admin/overview')
@RequireAdminPermission('overview.read')
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}
  @Get()
  read(@Req() req: AuthRequest, @Query() raw: Record<string, unknown>) {
    return this.overview.read(req.adminActor!, raw);
  }
}
