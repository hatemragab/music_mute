import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import {
  AllowRevokedMachine,
  LimitWorker,
  WorkerRoute,
} from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';
import { WorkerMachineLifecycleService } from './worker-machine-lifecycle.service.js';
import {
  GetWorkerUpdateDto,
  UnpairWorkerMachineDto,
} from './worker-machine-lifecycle.dto.js';
import { WorkerInstallationArtifactsService } from '../enrollment/worker-installation-artifacts.service.js';

@Controller('worker')
@WorkerRoute('machine')
export class WorkerMachineLifecycleController {
  constructor(
    private readonly lifecycle: WorkerMachineLifecycleService,
    private readonly artifacts: WorkerInstallationArtifactsService,
  ) {}

  @Get('status')
  @LimitWorker('poll')
  status(@Req() request: WorkerRequest) {
    return this.lifecycle.status(request.workerPrincipal!);
  }

  @Post('updates')
  @LimitWorker('transfer')
  update(@Req() request: WorkerRequest, @Body() dto: GetWorkerUpdateDto) {
    return this.artifacts.createUpdateGrant(
      request.workerPrincipal!,
      dto.platform,
      dto.download === true,
    );
  }

  @Post('unpairings')
  @AllowRevokedMachine()
  unpair(@Req() request: WorkerRequest, @Body() dto: UnpairWorkerMachineDto) {
    return this.lifecycle.unpair(request.workerPrincipal!, dto.force === true);
  }
}
