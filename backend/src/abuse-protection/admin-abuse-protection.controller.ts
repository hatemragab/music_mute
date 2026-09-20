import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { AdminAbuseProtectionService } from './admin-abuse-protection.service.js';
import {
  DeleteAccountRestrictionDto,
  PutAccountRestrictionDto,
} from './dto/account-restriction.dto.js';

@Controller('admin')
@RequireAdminPermission('abuse.read')
export class AdminAbuseProtectionController {
  constructor(private readonly abuse: AdminAbuseProtectionService) {}

  @Get('abuse-events')
  @Header('Cache-Control', 'no-store')
  events(@Query() query: Record<string, unknown>) {
    return this.abuse.listEvents(query);
  }

  @Get('users/:id/restriction')
  @Header('Cache-Control', 'no-store')
  restriction(@Param('id') id: string) {
    return this.abuse.currentRestriction(id);
  }

  @Put('users/:id/restriction')
  @RequireAdminPermission('users.restrictions.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  putRestriction(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: PutAccountRestrictionDto,
  ) {
    return this.abuse.putRestriction(request.adminActor!, id, body);
  }

  @Delete('users/:id/restriction')
  @RequireAdminPermission('users.restrictions.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  deleteRestriction(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: DeleteAccountRestrictionDto,
  ) {
    return this.abuse.deleteRestriction(request.adminActor!, id, body);
  }
}
