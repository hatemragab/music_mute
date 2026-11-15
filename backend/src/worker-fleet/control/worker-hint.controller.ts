import { Controller, Post, Req } from '@nestjs/common';
import { WorkerHintService } from '../../worker-hints/worker-hint.service.js';
import { WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';

@Controller('worker/v1/hints')
@WorkerRoute('machine')
export class WorkerHintController {
  constructor(private readonly hints: WorkerHintService) {}

  @Post('ticket')
  ticket(@Req() request: WorkerRequest) {
    return this.hints.mintTicket(request.workerPrincipal!.subjectId);
  }
}
