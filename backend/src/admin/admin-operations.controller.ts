import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import { AdminRoute } from './admin.decorators.js';
import { AdminOperationsService } from './admin-operations.service.js';
import { adminError } from './admin-errors.js';

@Controller('admin/operations')
@AdminRoute()
export class AdminOperationsController {
  constructor(private readonly operations: AdminOperationsService) {}

  @Get(':operationId')
  read(
    @Req() request: AuthRequest,
    @Param('operationId') operationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (
      Object.keys(query).some((key) => key !== 'actorUid') ||
      (query.actorUid !== undefined && typeof query.actorUid !== 'string')
    )
      throw adminError('INVALID_REQUEST');
    return this.operations.read(
      request.adminActor!,
      operationId,
      query.actorUid as string | undefined,
    );
  }
}
