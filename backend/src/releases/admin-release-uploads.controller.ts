import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import { RequireAdminPermission } from '../admin/admin.decorators.js';
import { ReleaseUploadService } from './release-upload.service.js';

@Controller('admin/releases/:id/uploads')
export class AdminReleaseUploadsController {
  constructor(private readonly uploads: ReleaseUploadService) {}
  @Post()
  @RequireAdminPermission('releases.manage')
  reserve(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.uploads.reserve(request.adminActor!, id, body);
  }
  @Post(':uploadId/complete')
  @RequireAdminPermission('releases.manage')
  complete(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Param('uploadId') uploadId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.uploads.complete(request.adminActor!, id, uploadId, body);
  }
  @Get(':uploadId')
  @RequireAdminPermission('releases.read')
  read(@Param('id') id: string, @Param('uploadId') uploadId: string) {
    return this.uploads.read(id, uploadId);
  }
}
