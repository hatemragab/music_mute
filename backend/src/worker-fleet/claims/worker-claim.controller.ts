import { Body, Controller, Post, Req } from '@nestjs/common';
import { LimitWorker, WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';
import {
  ClaimWorkerJobDto,
  OpenWorkerSessionDto,
  RegisterWorkerSlotDto,
} from './worker-claim.dto.js';
import { WorkerClaimService } from './worker-claim.service.js';

@Controller('worker')
@WorkerRoute('machine')
export class WorkerClaimController {
  constructor(private readonly claims: WorkerClaimService) {}

  @Post('sessions')
  openSession(
    @Req() request: WorkerRequest,
    @Body() dto: OpenWorkerSessionDto,
  ) {
    return this.claims.openSession(request.workerPrincipal!, dto);
  }

  @Post('slots')
  registerSlot(
    @Req() request: WorkerRequest,
    @Body() dto: RegisterWorkerSlotDto,
  ) {
    return this.claims.registerSlot(request.workerPrincipal!, dto);
  }

  @Post('claims')
  @LimitWorker('poll')
  claim(@Req() request: WorkerRequest, @Body() dto: ClaimWorkerJobDto) {
    return this.claims.claim(request.workerPrincipal!, dto);
  }
}
