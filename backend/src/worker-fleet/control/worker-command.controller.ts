import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import { WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';
import { CompleteWorkerCommandDto } from './worker-control.dto.js';
import { WorkerControlService } from './worker-control.service.js';

@Controller('worker/v1/commands')
@WorkerRoute('machine')
export class WorkerCommandController {
  constructor(private readonly control: WorkerControlService) {}

  @Post(':id/result')
  result(
    @Req() request: WorkerRequest,
    @Param('id') id: string,
    @Body() dto: CompleteWorkerCommandDto,
  ) {
    return this.control.completeCommand(request.workerPrincipal!, id, dto);
  }
}
