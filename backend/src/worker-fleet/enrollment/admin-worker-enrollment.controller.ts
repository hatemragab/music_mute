import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import type { AuthRequest } from '../../auth/auth-request.js';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../../admin/admin.decorators.js';
import {
  CreateWorkerInvitationDto,
  WorkerLifecycleDto,
} from './worker-enrollment.dto.js';
import { WorkerEnrollmentService } from './worker-enrollment.service.js';

@Controller('admin/workers')
export class AdminWorkerEnrollmentController {
  constructor(private readonly enrollment: WorkerEnrollmentService) {}

  @Post('invitations')
  @RequireAdminPermission('workers.enroll')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  createInvitation(
    @Req() request: AuthRequest,
    @Body() dto: CreateWorkerInvitationDto,
  ) {
    return this.enrollment.createInvitation(request.adminActor!, dto);
  }

  @Post('machines/:id/pause')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  pause(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() dto: WorkerLifecycleDto,
  ) {
    return this.enrollment.pause(request.adminActor!, id, dto);
  }

  @Post('machines/:id/resume')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  resume(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() dto: WorkerLifecycleDto,
  ) {
    return this.enrollment.resume(request.adminActor!, id, dto);
  }

  @Post('machines/:id/revoke')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  revoke(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() dto: WorkerLifecycleDto,
  ) {
    return this.enrollment.revoke(request.adminActor!, id, dto);
  }
}
