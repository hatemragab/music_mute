import { Body, Controller, Get, Post } from '@nestjs/common';
import { RequireAdminPermission } from '../admin/admin.decorators.js';
import { ReleasePublicationService } from './release-publication.service.js';
@Controller('admin/update-policy')
@RequireAdminPermission('releases.read')
export class AdminUpdatePolicyController {
  constructor(private readonly publication: ReleasePublicationService) {}
  @Get() current() {
    return this.publication.current();
  }
  @Post('previews') preview(@Body() body: unknown) {
    return this.publication.preview(body);
  }
}
