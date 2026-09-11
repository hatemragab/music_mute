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
import { AdminAccessService } from './admin-access.service.js';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from './admin.decorators.js';
import {
  CreateAdminAccessDto,
  UpdateAdminAccessDto,
} from './dto/admin-access.dto.js';

@Controller('admin/access')
@RequireAdminPermission('admin.access.manage')
export class AdminAccessController {
  constructor(private readonly access: AdminAccessService) {}
  @Get() list(@Query() query: Record<string, unknown>) {
    return this.access.list(query);
  }
  @Post()
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  create(@Req() request: AuthRequest, @Body() body: CreateAdminAccessDto) {
    return this.access.create(request.adminActor!, body);
  }
  @Patch(':uid')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  update(
    @Req() request: AuthRequest,
    @Param('uid') uid: string,
    @Body() body: UpdateAdminAccessDto,
  ) {
    return this.access.update(request.adminActor!, uid, body);
  }
}
