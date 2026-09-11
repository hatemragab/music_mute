import { Body, Controller, Post, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import { ClientErrorDto } from './client-error.dto.js';
import { ClientErrorsService } from './client-errors.service.js';

@Controller('client-errors')
export class ClientErrorsController {
  constructor(private readonly clientErrors: ClientErrorsService) {}

  @Post()
  report(@Req() req: AuthRequest, @Body() dto: ClientErrorDto) {
    return this.clientErrors.report(req.user!._id.toHexString(), dto);
  }
}
