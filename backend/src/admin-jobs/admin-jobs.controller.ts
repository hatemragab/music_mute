import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  LimitAdmin,
  RequireAdminPermission,
} from '../admin/admin.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { AdminJobsQueryService } from './admin-jobs-query.service.js';
import { AdminJobActionsService } from './admin-job-actions.service.js';
import { AdminJobActionDto } from './dto/admin-job-action.dto.js';
@Controller('admin/jobs')
@RequireAdminPermission('jobs.read')
export class AdminJobsController {
  constructor(
    private readonly jobs: AdminJobsQueryService,
    private readonly actions: AdminJobActionsService,
  ) {}
  @Get() list(
    @Req() req: AuthRequest,
    @Query() query: Record<string, unknown>,
  ) {
    return this.jobs.list(req.adminActor!, query);
  }
  @Get(':id') detail(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.jobs.detail(req.adminActor!, id);
  }
  @Post(':id/cancel')
  @HttpCode(200)
  @RequireAdminPermission('jobs.manage')
  @LimitAdmin('write')
  cancel(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: AdminJobActionDto,
  ) {
    return this.actions.cancel(req.adminActor!, id, body);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @RequireAdminPermission('jobs.manage')
  @LimitAdmin('write')
  retry(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: AdminJobActionDto,
  ) {
    return this.actions.retry(req.adminActor!, id, body);
  }
}
