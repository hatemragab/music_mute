import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { AdminWorkersService } from './admin-workers.service.js';
import {
  ReleaseStoppedWorkerDto,
  RenameAdminWorkerDto,
  RevokeAdminWorkerDto,
  UpdateAdminWorkerDto,
} from './dto/admin-worker.dto.js';

@Controller('admin/workers')
export class AdminWorkersController {
  constructor(private readonly workers: AdminWorkersService) {}
  @Get()
  @RequireAdminPermission('workers.read')
  list(@Query() query: Record<string, unknown>) {
    return this.workers.list(query);
  }
  @Get(':id')
  @RequireAdminPermission('workers.read')
  detail(@Param('id') id: string) {
    return this.workers.detail(id);
  }
  @Patch(':id')
  @RequireAdminPermission('workers.manage')
  rename(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: RenameAdminWorkerDto,
  ) {
    return this.workers.update(request.adminActor!, id, 'rename', body);
  }
  @Post(':id/drain')
  @RequireAdminPermission('workers.manage')
  drain(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateAdminWorkerDto,
  ) {
    return this.workers.update(request.adminActor!, id, 'drain', body);
  }
  @Post(':id/enable')
  @RequireAdminPermission('workers.manage')
  enable(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateAdminWorkerDto,
  ) {
    return this.workers.update(request.adminActor!, id, 'enable', body);
  }
  @Post(':id/rotate-key')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  rotateKey(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateAdminWorkerDto,
  ) {
    return this.workers.update(request.adminActor!, id, 'rotate-key', body);
  }
  @Post(':id/revoke')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  revoke(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: RevokeAdminWorkerDto,
  ) {
    return this.workers.update(request.adminActor!, id, 'revoke', body);
  }
  @Post(':id/release-stopped')
  @RequireAdminPermission('workers.recover')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  releaseStopped(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: ReleaseStoppedWorkerDto,
  ) {
    return this.workers.update(
      request.adminActor!,
      id,
      'release-stopped',
      body,
    );
  }
}
