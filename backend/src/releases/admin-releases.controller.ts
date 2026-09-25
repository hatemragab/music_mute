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
  AdminRoute,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { ReleaseDraftsService } from './release-drafts.service.js';
import { ReleasePublicationService } from './release-publication.service.js';
import {
  EditReleaseDraftDto,
  ReleaseDraftDto,
} from './dto/release-draft.dto.js';
@Controller('admin/releases')
@AdminRoute()
export class AdminReleasesController {
  constructor(
    private readonly drafts: ReleaseDraftsService,
    private readonly publication: ReleasePublicationService,
  ) {}

  @Post(':id/publications')
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  publish(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.publication.mutate(request.adminActor!, id, 'publish', body);
  }
  @Post(':id/withdrawals')
  @RequireAdminPermission('releases.manage')
  @RequireFreshAdminAuth()
  withdraw(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.publication.mutate(request.adminActor!, id, 'withdraw', body);
  }
  @Get()
  @RequireAdminPermission('releases.read')
  list(@Query() query: Record<string, unknown>) {
    return this.drafts.list(query);
  }
  @Get('proposal')
  @RequireAdminPermission('releases.read')
  proposal(@Query() query: Record<string, unknown>) {
    return this.drafts.proposal(query);
  }
  @Get(':id')
  @RequireAdminPermission('releases.read')
  detail(@Param('id') id: string) {
    return this.drafts.detail(id);
  }
  @Post()
  @RequireAdminPermission('releases.manage')
  create(@Req() request: AuthRequest, @Body() dto: ReleaseDraftDto) {
    return this.drafts.create(request.adminActor!, dto);
  }
  @Patch(':id')
  @RequireAdminPermission('releases.manage')
  edit(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() dto: EditReleaseDraftDto,
  ) {
    return this.drafts.edit(request.adminActor!, id, dto);
  }
}
