import { Body, Controller, Post, Req } from '@nestjs/common';
import { WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';
import { RenewWorkerLeasesDto } from './worker-lease.dto.js';
import { WorkerLeaseService } from './worker-lease.service.js';

@Controller('worker/v1/leases')
@WorkerRoute('machine')
export class WorkerLeaseController {
  constructor(private readonly leases: WorkerLeaseService) {}

  @Post('renew')
  renew(@Req() request: WorkerRequest, @Body() dto: RenewWorkerLeasesDto) {
    return this.leases.renew(request.workerPrincipal!, dto);
  }
}
