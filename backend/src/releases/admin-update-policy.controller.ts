import { Body, Controller, Get, Patch, Post, Req } from '@nestjs/common';
import {
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { ReleasePublicationService } from './release-publication.service.js';
import { DesktopUpdatePolicyService } from './desktop-policy.service.js';
@Controller('admin/update-policy')
@RequireAdminPermission('releases.read')
export class AdminUpdatePolicyController {
  constructor(
    private readonly publication: ReleasePublicationService,
    private readonly desktop: DesktopUpdatePolicyService,
  ) {}
  @Get() current() {
    return this.publication.current();
  }
  @Post('previews') preview(@Body() body: unknown) {
    return this.publication.preview(body);
  }
  @Get('desktop') currentDesktop() {
    return this.desktop.current();
  }
  @Patch('desktop')
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  updateDesktop(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.desktop.update(request.adminActor!, body);
  }
}
