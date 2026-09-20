import { Body, Controller, Post, Req } from '@nestjs/common';
import { WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';
import { AppendRuntimeLogsDto } from './worker-diagnostic.dto.js';
import { WorkerDiagnosticsService } from './worker-diagnostics.service.js';

@Controller('worker/v1')
@WorkerRoute('machine')
export class WorkerRuntimeDiagnosticsController {
  constructor(private readonly diagnostics: WorkerDiagnosticsService) {}

  @Post('logs')
  logs(@Req() request: WorkerRequest, @Body() dto: AppendRuntimeLogsDto) {
    return this.diagnostics.appendRuntimeLogs(request.workerPrincipal!, dto);
  }
}
