import { Controller, Get, Header, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import { ProcessingUsageService } from './processing-usage.service.js';
@Controller('processing-usage')
export class ProcessingUsageController {
  constructor(private readonly usage: ProcessingUsageService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  current(@Req() request: AuthRequest) {
    return this.usage.readUsage(request.user!._id);
  }
}
