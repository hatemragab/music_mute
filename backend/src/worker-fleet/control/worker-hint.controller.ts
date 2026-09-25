import { Controller, Post, Req } from '@nestjs/common';
import { WorkerHintService } from '../../worker-hints/worker-hint.service.js';
import { LimitWorker, WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';

@Controller('worker/hints')
@WorkerRoute('machine')
export class WorkerHintController {
  constructor(private readonly hints: WorkerHintService) {}

  @Post('tickets')
  @LimitWorker('poll')
  ticket(@Req() request: WorkerRequest) {
    return this.hints.mintTicket(request.workerPrincipal!.subjectId);
  }
}
