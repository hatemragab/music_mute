import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { RequireAdminPermission } from '../admin/admin.decorators.js';
import {
  WorkerOnly,
  WorkerCleanup,
  type WorkerAuthenticatedRequest,
} from '../worker/worker-routes.js';
import { WorkerEventsService } from './worker-events.service.js';
import { WorkerEventsQueryService } from './worker-events-query.service.js';

export type EventRequest = Request & { eventBodyBytes?: number };
@Controller('worker-installations')
@Public()
export class InstallationEventsController {
  constructor(private readonly events: WorkerEventsService) {}
  @Post(':id/events')
  ingest(
    @Param('id') id: string,
    @Req() req: EventRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    if (
      req.rawHeaders.filter(
        (value, index) =>
          index % 2 === 0 && value.toLowerCase() === 'authorization',
      ).length !== 1
    )
      throw new UnauthorizedException();
    return this.events.ingestSetup(
      id,
      req.headers.authorization,
      body,
      req.eventBodyBytes ?? 0,
    );
  }
}
@Controller('worker')
@WorkerOnly()
export class PermanentWorkerEventsController {
  constructor(private readonly events: WorkerEventsService) {}
  @Post('events')
  @WorkerCleanup()
  ingest(
    @Req() req: WorkerAuthenticatedRequest & EventRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.events.ingestWorker(
      req.workerIdentity,
      body,
      req.eventBodyBytes ?? 0,
    );
  }
}
@Controller('admin/worker-installations')
export class AdminInstallationEventsController {
  constructor(private readonly events: WorkerEventsQueryService) {}
  @Get(':id/events')
  @RequireAdminPermission('workers.read')
  list(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.events.forInstallation(id, query);
  }
}
@Controller('admin/workers')
export class AdminWorkerEventsController {
  constructor(private readonly events: WorkerEventsQueryService) {}
  @Get(':id/events')
  @RequireAdminPermission('workers.read')
  list(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.events.forWorker(id, query);
  }
}
