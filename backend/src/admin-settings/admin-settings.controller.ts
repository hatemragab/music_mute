import { Body, Controller, Get, Header, Put, Query, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import { Public } from '../auth/auth.decorators.js';
import {
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { UpdateProcessingSettingsDto } from './dto/processing-settings.dto.js';
import { ProcessingSettingsService } from './processing-settings.service.js';

@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settings: ProcessingSettingsService) {}

  @Get('processing')
  @RequireAdminPermission('settings.read')
  current() {
    return this.settings.current();
  }

  @Put('processing')
  @RequireAdminPermission('settings.manage')
  @RequireFreshAdminAuth()
  update(
    @Req() request: AuthRequest,
    @Body() dto: UpdateProcessingSettingsDto,
  ) {
    return this.settings.update(request.adminActor!, dto);
  }
}

@Controller('processing-policy')
export class ProcessingPolicyController {
  constructor(private readonly settings: ProcessingSettingsService) {}

  @Get()
  @Public()
  @Header('Cache-Control', 'no-store')
  current(@Query('schemaVersion') schemaVersion?: string) {
    return this.settings.publicPolicy(schemaVersion);
  }
}
