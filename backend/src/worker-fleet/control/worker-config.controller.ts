import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { WorkerRoute } from '../auth/worker-auth.decorators.js';
import type { WorkerRequest } from '../auth/worker-auth.types.js';
import {
  ApplyWorkerConfigDto,
  WorkerConfigQueryDto,
} from './worker-control.dto.js';
import { WorkerControlService } from './worker-control.service.js';

@Controller('worker/v1/config')
@WorkerRoute('machine')
export class WorkerConfigController {
  constructor(private readonly control: WorkerControlService) {}

  @Get()
  get(@Req() request: WorkerRequest, @Query() query: WorkerConfigQueryDto) {
    return this.control.config(request.workerPrincipal!, query);
  }

  @Post('applied')
  applied(@Req() request: WorkerRequest, @Body() dto: ApplyWorkerConfigDto) {
    return this.control.applyConfig(request.workerPrincipal!, dto);
  }
}
