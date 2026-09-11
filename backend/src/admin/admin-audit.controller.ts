import { Controller, Get, Query } from '@nestjs/common';
import { RequireAdminPermission } from './admin.decorators.js';
import { AdminAuditService } from './admin-audit.service.js';

@Controller('admin/audit')
@RequireAdminPermission('audit.read')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.audit.list(query);
  }
}
