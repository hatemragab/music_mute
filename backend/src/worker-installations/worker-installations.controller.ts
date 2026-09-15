import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/auth-request.js';
import { Public } from '../auth/auth.decorators.js';
import {
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import { InstallationPairingService } from './installation-pairing.service.js';
import { InstallationLimitsService } from './installation-limits.service.js';
import {
  ApproveInstallationDto,
  InstallationOperationDto,
  InstallationQualificationDto,
  RegisterInstallationDto,
  RejectInstallationDto,
  RequestPairingDto,
} from './installation.dto.js';
import {
  WorkerOnly,
  WorkerCleanup,
  type WorkerAuthenticatedRequest,
} from '../worker/worker-routes.js';

@Controller('worker-installations')
@Public()
export class WorkerInstallationsController {
  constructor(
    private readonly service: InstallationPairingService,
    private readonly limits: InstallationLimitsService,
  ) {}
  private async authorize(id: string, req: AuthRequest, res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    if (
      req.rawHeaders.filter(
        (value, index) =>
          index % 2 === 0 && value.toLowerCase() === 'authorization',
      ).length !== 1
    )
      throw new UnauthorizedException();
    await this.service.authenticate(id, req.headers.authorization);
    await this.limits.take([['installation-session', id, 60, 60000]], res);
    return req.headers.authorization;
  }
  @Post()
  async register(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: RegisterInstallationDto,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    await this.limits.take(
      [
        ['installation-register-ip', req.ip ?? 'unknown', 5, 3600000],
        ['installation-register-global', 'all', 1000, 3600000],
      ],
      res,
    );
    return this.service.register(dto);
  }
  @Get(':id')
  async status(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.service.status(id, await this.authorize(id, req, res));
  }
  @Post(':id/renew')
  async renew(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: InstallationOperationDto,
  ) {
    const bearer = await this.authorize(id, req, res);
    await this.limits.take([['installation-renew', id, 10, 3600000]], res);
    return this.service.renew(id, bearer, dto.operationId);
  }
  @Post(':id/qualification')
  async report(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: InstallationQualificationDto,
  ) {
    const bearer = await this.authorize(id, req, res);
    await this.limits.take([['installation-report', id, 10, 3600000]], res);
    return this.service.report(id, bearer, dto);
  }
  @Post(':id/pairing')
  async issue(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: RequestPairingDto,
  ) {
    const bearer = await this.authorize(id, req, res);
    await this.limits.take([['installation-pairing', id, 10, 3600000]], res);
    return this.service.issue(id, bearer, dto);
  }
}
@Controller('admin/worker-installations')
export class AdminWorkerInstallationsController {
  constructor(
    private readonly service: InstallationPairingService,
    private readonly limits: InstallationLimitsService,
  ) {}
  @Get()
  @RequireAdminPermission('workers.read')
  list(@Query() query: Record<string, unknown>) {
    return this.service.list(query);
  }
  @Get(':id')
  @RequireAdminPermission('workers.read')
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }
  @Post('approve')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  async approve(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: ApproveInstallationDto,
  ) {
    await this.limits.take(
      [
        ['installation-approval-ip', req.ip ?? 'unknown', 100, 900000],
        ['installation-approval-global', 'all', 1000, 900000],
      ],
      res,
      true,
    );
    const release = await this.limits.approvalAttempt(req.adminActor!.uid, res);
    const result = await this.service.approve(req.adminActor!, dto);
    await release();
    return result;
  }
  @Post(':id/reject')
  @RequireAdminPermission('workers.manage')
  reject(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: RejectInstallationDto,
  ) {
    return this.service.reject(req.adminActor!, id, dto);
  }
}

@Controller('worker')
@WorkerOnly()
@WorkerCleanup()
export class PermanentWorkerQualificationController {
  constructor(
    private readonly service: InstallationPairingService,
    private readonly limits: InstallationLimitsService,
  ) {}
  @Post('qualification')
  async report(
    @Req() req: WorkerAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: InstallationQualificationDto,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    await this.limits.take(
      [
        ['worker-qualification-hour', req.workerId, 10, 3600000],
        ['worker-qualification-day', req.workerId, 100, 86400000],
      ],
      res,
    );
    return this.service.permanentReport(req.workerIdentity, dto);
  }
}
