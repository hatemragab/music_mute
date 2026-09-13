import {
  Body,
  Controller,
  Header,
  HttpCode,
  Optional,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { WorkerOnly, WorkerCleanup } from './worker-routes.js';
import type { WorkerAuthenticatedRequest } from './worker-routes.js';
import { WorkerIdentityService } from './worker-identity.service.js';
import { authError } from '../auth/auth.errors.js';
import { WorkerCoordinatorService } from './worker-coordinator.service.js';
import { WorkerClaimWaitService } from './worker-claim-wait.service.js';
import {
  WorkerClaimDto,
  WorkerSelectorDto,
  WorkerStageDto,
} from './dto/worker-request.dto.js';
import { WorkerOutputService } from './worker-output.service.js';
import { WorkerTerminalService } from './worker-terminal.service.js';
import { WorkerRecoveryService } from './worker-recovery.service.js';
import { WorkerOutputDto } from './dto/worker-output.dto.js';
import {
  WorkerEventDto,
  WorkerFailDto,
  WorkerLocalCleanupDto,
  WorkerStoppedDto,
} from './dto/worker-event.dto.js';
import { ReconcileDto } from './dto/reconcile.dto.js';

@Controller('worker')
@WorkerOnly()
export class WorkerController {
  constructor(
    private readonly coordinator: WorkerCoordinatorService,
    private readonly output: WorkerOutputService,
    private readonly terminal: WorkerTerminalService,
    private readonly recovery: WorkerRecoveryService,
    private readonly claimWait: WorkerClaimWaitService,
    @Optional() private readonly identities?: WorkerIdentityService,
  ) {}

  @Post('identity')
  @WorkerCleanup()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  identity(@Body() body: unknown, @Req() req: WorkerAuthenticatedRequest) {
    if (
      body !== undefined &&
      (body === null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0)
    )
      throw authError('INVALID_INPUT');
    if (!this.identities) throw authError('SERVICE_UNAVAILABLE');
    return this.identities.describe(req.workerIdentity);
  }

  @Post('output-url')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  outputUrl(
    @Body() dto: WorkerOutputDto,
    @Req() req?: WorkerAuthenticatedRequest,
  ) {
    return this.output.reserve(dto, req?.workerIdentity);
  }

  @Post('complete')
  @HttpCode(200)
  complete(
    @Body() dto: WorkerEventDto,
    @Req() req?: WorkerAuthenticatedRequest,
  ) {
    return this.terminal.complete(dto, req?.workerIdentity);
  }

  @Post('local-cleanup')
  @WorkerCleanup()
  @HttpCode(200)
  localCleanup(
    @Body() dto: WorkerLocalCleanupDto,
    @Req() req?: WorkerAuthenticatedRequest,
  ) {
    return this.terminal.confirmLocalCleanup(dto, req?.workerIdentity);
  }

  @Post('fail')
  @WorkerCleanup()
  @HttpCode(200)
  fail(@Body() dto: WorkerFailDto, @Req() req?: WorkerAuthenticatedRequest) {
    return this.terminal.stopped(dto, 'fail', req?.workerIdentity);
  }

  @Post('cancelled')
  @WorkerCleanup()
  @HttpCode(200)
  cancelled(
    @Body() dto: WorkerStoppedDto,
    @Req() req?: WorkerAuthenticatedRequest,
  ) {
    return this.terminal.stopped(dto, 'cancelled', req?.workerIdentity);
  }

  @Post('reconcile')
  @WorkerCleanup()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  reconcile(
    @Body() dto: ReconcileDto,
    @Req() req?: WorkerAuthenticatedRequest,
  ) {
    return this.recovery.reconcile(
      dto.sessionId,
      dto.previousAttemptId,
      dto.stopped,
      req?.workerIdentity,
      { eventId: dto.eventId, executionEvidence: dto.executionEvidence },
    );
  }

  @Post('claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async claim(
    @Body() dto: WorkerClaimDto,
    @Res({ passthrough: true }) response: Response,
    @Req() req?: WorkerAuthenticatedRequest,
  ) {
    const client = new AbortController();
    const disconnected = () => client.abort();
    response.once('close', disconnected);
    if (response.destroyed) client.abort();
    try {
      const assignment = await this.claimWait.claim(
        dto.sessionId,
        dto.waitSeconds,
        client.signal,
        req?.workerIdentity,
        dto.mediaPolicyVersion,
      );
      if (client.signal.aborted) return;
      if (!assignment) {
        response.status(204);
        response.setHeader('Retry-After', dto.waitSeconds > 0 ? '0' : '15');
        return;
      }
      return assignment;
    } finally {
      response.removeListener('close', disconnected);
    }
  }

  @Post('heartbeat')
  @WorkerCleanup()
  @HttpCode(200)
  heartbeat(
    @Body() dto: WorkerSelectorDto,
    @Req() req?: WorkerAuthenticatedRequest,
  ) {
    return this.coordinator.heartbeat(dto, req?.workerIdentity);
  }

  @Post('stage')
  @HttpCode(200)
  stage(@Body() dto: WorkerStageDto, @Req() req?: WorkerAuthenticatedRequest) {
    return this.coordinator.stage(dto, dto, req?.workerIdentity);
  }
}
