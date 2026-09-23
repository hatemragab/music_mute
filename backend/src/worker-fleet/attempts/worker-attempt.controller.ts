import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import { WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';
import {
  CompleteWorkerAttemptDto,
  FailWorkerAttemptDto,
  WorkerInputGrantDto,
  WorkerOutputGrantDto,
  UpdateWorkerAttemptProgressDto,
} from './worker-attempt.dto.js';
import { WorkerAttemptService } from './worker-attempt.service.js';

@Controller('worker/v1/attempts')
@WorkerRoute('machine')
export class WorkerAttemptController {
  constructor(private readonly attempts: WorkerAttemptService) {}

  @Post(':id/input-grant')
  inputGrant(
    @Req() request: WorkerRequest,
    @Param('id') id: string,
    @Body() dto: WorkerInputGrantDto,
  ) {
    return this.attempts.inputGrant(request.workerPrincipal!, id, dto);
  }

  @Post(':id/output-grant')
  outputGrant(
    @Req() request: WorkerRequest,
    @Param('id') id: string,
    @Body() dto: WorkerOutputGrantDto,
  ) {
    return this.attempts.outputGrant(request.workerPrincipal!, id, dto);
  }

  @Post(':id/progress')
  progress(
    @Req() request: WorkerRequest,
    @Param('id') id: string,
    @Body() dto: UpdateWorkerAttemptProgressDto,
  ) {
    return this.attempts.progress(request.workerPrincipal!, id, dto);
  }

  @Post(':id/complete')
  complete(
    @Req() request: WorkerRequest,
    @Param('id') id: string,
    @Body() dto: CompleteWorkerAttemptDto,
  ) {
    return this.attempts.complete(request.workerPrincipal!, id, dto);
  }

  @Post(':id/fail')
  fail(
    @Req() request: WorkerRequest,
    @Param('id') id: string,
    @Body() dto: FailWorkerAttemptDto,
  ) {
    return this.attempts.fail(request.workerPrincipal!, id, dto);
  }
}
