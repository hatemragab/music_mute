import { Controller, Get } from '@nestjs/common';
import { RequireAdminPermission } from '../admin/admin.decorators.js';
import { AdminHealthService } from './admin-health.service.js';

@Controller('admin/health')
@RequireAdminPermission('health.read')
export class AdminHealthController {
  constructor(private readonly health: AdminHealthService) {}

  @Get()
  read() {
    return this.health.read();
  }
}
