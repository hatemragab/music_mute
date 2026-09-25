import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { WorkerConfigQueryDto } from '../control/worker-control.dto.js';
import { LimitWorker, WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';
import { AppendRuntimeLogsDto } from './worker-diagnostic.dto.js';
import { WorkerDiagnosticsService } from './worker-diagnostics.service.js';

@Controller('worker')
@WorkerRoute('machine')
export class WorkerRuntimeDiagnosticsController {
  constructor(private readonly diagnostics: WorkerDiagnosticsService) {}

  @Get('logs/cursor')
  @LimitWorker('telemetry')
  cursor(@Req() request: WorkerRequest, @Query() dto: WorkerConfigQueryDto) {
    return this.diagnostics.runtimeLogCursor(request.workerPrincipal!, dto);
  }

  @Post('logs')
  @LimitWorker('telemetry')
  logs(@Req() request: WorkerRequest, @Body() dto: AppendRuntimeLogsDto) {
    return this.diagnostics.appendRuntimeLogs(request.workerPrincipal!, dto);
  }
}
