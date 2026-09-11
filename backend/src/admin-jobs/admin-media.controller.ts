import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { AdminMediaGrantDto } from './dto/admin-media-grant.dto.js';
import { AdminMediaService } from './admin-media.service.js';

@Controller('admin/jobs')
@RequireAdminPermission('jobs.read', 'media.read')
@RequireFreshAdminAuth()
@LimitAdmin('media')
export class AdminMediaController {
  constructor(private readonly media: AdminMediaService) {}
  @Post(':id/media-grants')
  grant(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: AdminMediaGrantDto,
  ) {
    return this.media.grant(req.adminActor!, id, dto);
  }
}
