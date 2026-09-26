import { Body, Controller, Header, Post, Req } from '@nestjs/common';
import { AdminRoute, LimitAdmin } from '../admin/admin.decorators.js';
import { LimitOperation } from '../auth/auth.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { EmptyBodyPipe } from '../auth/dto/empty-body.pipe.js';
import { RealtimeAuthService } from './realtime-auth.service.js';

@Controller('realtime-tickets')
export class RealtimeTicketController {
  constructor(private readonly auth: RealtimeAuthService) {}

  @Post()
  @LimitOperation('processing-read')
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthRequest, @Body(EmptyBodyPipe) _body: unknown) {
    return this.auth.mint(req, 'owner');
  }
}

@Controller('admin/realtime-tickets')
@AdminRoute()
export class AdminRealtimeTicketController {
  constructor(private readonly auth: RealtimeAuthService) {}

  @Post()
  @LimitAdmin('read')
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthRequest, @Body(EmptyBodyPipe) _body: unknown) {
    return this.auth.mint(req, 'admin');
  }
}
