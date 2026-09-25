import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { WorkerConfigQueryDto } from '../control/worker-control.dto.js';
import { WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';
import { AppendRuntimeLogsDto } from './worker-diagnostic.dto.js';
import { WorkerDiagnosticsService } from './worker-diagnostics.service.js';

@Controller('worker/v1')
@WorkerRoute('machine')
export class WorkerRuntimeDiagnosticsController {
  constructor(private readonly diagnostics: WorkerDiagnosticsService) {}

  @Get('logs/cursor')
  cursor(@Req() request: WorkerRequest, @Query() dto: WorkerConfigQueryDto) {
    return this.diagnostics.runtimeLogCursor(request.workerPrincipal!, dto);
  }

  @Post('logs')
  logs(@Req() request: WorkerRequest, @Body() dto: AppendRuntimeLogsDto) {
    return this.diagnostics.appendRuntimeLogs(request.workerPrincipal!, dto);
  }
}
