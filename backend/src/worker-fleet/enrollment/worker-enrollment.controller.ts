import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import { WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';
import {
  ActivateWorkerInstallationDto,
  ExchangeWorkerInvitationDto,
  ReportWorkerInstallationDto,
} from './worker-enrollment.dto.js';
import { WorkerEnrollmentService } from './worker-enrollment.service.js';
import { AppendInstallationLogsDto } from '../telemetry/worker-diagnostic.dto.js';
import { WorkerDiagnosticsService } from '../telemetry/worker-diagnostics.service.js';

@Controller('worker/v1/installations')
export class WorkerEnrollmentController {
  constructor(
    private readonly enrollment: WorkerEnrollmentService,
    private readonly diagnostics: WorkerDiagnosticsService,
  ) {}

  @Post()
  @WorkerRoute('enrollment')
  exchange(
    @Req() request: WorkerRequest,
    @Body() dto: ExchangeWorkerInvitationDto,
  ) {
    return this.enrollment.exchange(request.workerPrincipal!, dto);
  }

  @Post(':id/report')
  @WorkerRoute('installation')
  report(
    @Req() request: WorkerRequest,
    @Param('id') id: string,
    @Body() dto: ReportWorkerInstallationDto,
  ) {
    return this.enrollment.report(request.workerPrincipal!, id, dto);
  }

  @Post(':id/logs')
  @WorkerRoute('installation')
  logs(
    @Req() request: WorkerRequest,
    @Param('id') id: string,
    @Body() dto: AppendInstallationLogsDto,
  ) {
    return this.diagnostics.appendInstallationLogs(
      request.workerPrincipal!,
      id,
      dto,
    );
  }

  @Post(':id/activate')
  @WorkerRoute('installation')
  activate(
    @Req() request: WorkerRequest,
    @Param('id') id: string,
    @Body() dto: ActivateWorkerInstallationDto,
  ) {
    return this.enrollment.activate(request.workerPrincipal!, id, dto);
  }
}
