import { Controller, Get, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import { AdminRoute } from './admin.decorators.js';
import type { AdminSession } from './admin.types.js';

@Controller('admin')
export class AdminSessionController {
  @Get('session')
  @AdminRoute()
  session(@Req() req: AuthRequest): AdminSession {
    return { ...req.adminActor!, serverTime: new Date().toISOString() };
  }
}
