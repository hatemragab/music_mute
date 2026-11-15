import { Controller, Get, Param, Post } from '@nestjs/common';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { ReleaseUploadService } from './release-upload.service.js';
import { adminError } from '../admin/admin-errors.js';

@Controller('admin/releases/:id/uploads')
export class AdminReleaseUploadsController {
  constructor(private readonly uploads: ReleaseUploadService) {}
  @Post()
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  reserve() {
    throw adminError('INVALID_REQUEST');
  }
  @Post(':uploadId/completions')
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  complete() {
    throw adminError('INVALID_REQUEST');
  }
  @Get(':uploadId')
  @RequireAdminPermission('releases.read')
  read(@Param('id') id: string, @Param('uploadId') uploadId: string) {
    return this.uploads.read(id, uploadId);
  }
}
