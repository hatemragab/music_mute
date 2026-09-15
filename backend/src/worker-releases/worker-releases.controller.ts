import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import { Public } from '../auth/auth.decorators.js';
import { AuthRateLimitException } from '../auth/rate-limit.exception.js';
import {
  LimitAdmin,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../admin/admin.decorators.js';
import {
  WorkerOnly,
  WorkerCleanup,
  type WorkerAuthenticatedRequest,
} from '../worker/worker-routes.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { WorkerRolloutsService } from './worker-rollouts.service.js';
type Command = Record<string, unknown> & {
  operationId: string;
  expectedRevision: number;
};
@Controller('admin/worker-groups')
export class WorkerGroupsController {
  constructor(private readonly service: WorkerRolloutsService) {}
  @Get() @RequireAdminPermission('workers.read') list(
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.list('groups', query);
  }
  @Post() @RequireAdminPermission('workers.manage') create(
    @Req() req: AuthRequest,
    @Body() body: Command,
  ) {
    return this.service.saveGroup(req.adminActor!, null, body);
  }
  @Patch(':id') @RequireAdminPermission('workers.manage') update(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: Command,
  ) {
    return this.service.saveGroup(req.adminActor!, id, body);
  }
}
@Controller('admin/worker-releases')
export class WorkerReleasesController {
  constructor(private readonly service: WorkerRolloutsService) {}
  @Get() @RequireAdminPermission('workers.read') list(
    @Query() query: Record<string, unknown>,
  ) {
    return this.service.list('releases', query);
  }
  @Post() @RequireAdminPermission('workers.manage') create(
    @Req() req: AuthRequest,
    @Body() body: Command,
  ) {
    return this.service.createRelease(req.adminActor!, body);
  }
  @Post(':id/publish')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  publish(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: Command,
  ) {
    return this.service.releaseAction(req.adminActor!, id, 'publish', body);
  }
  @Post(':id/withdraw')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  withdraw(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: Command,
  ) {
    return this.service.releaseAction(req.adminActor!, id, 'withdraw', body);
  }
  @Post(':id/stable')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  stable(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: Command,
  ) {
    return this.service.releaseAction(req.adminActor!, id, 'stable', body);
  }
}
@Controller('admin/worker-rollouts')
export class WorkerRolloutsController {
  constructor(private readonly service: WorkerRolloutsService) {}
  @Post('preview') @RequireAdminPermission('workers.read') preview(
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.preview(body);
  }
  @Post()
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  create(@Req() req: AuthRequest, @Body() body: Command) {
    return this.service.confirm(req.adminActor!, body);
  }
  @Get(':id') @RequireAdminPermission('workers.read') detail(
    @Param('id') id: string,
  ) {
    return this.service.detail(id);
  }
  @Post(':id/pause') @RequireAdminPermission('workers.manage') pause(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: Command,
  ) {
    return this.service.rolloutAction(req.adminActor!, id, 'pause', body);
  }
  @Post(':id/retry')
  @RequireAdminPermission('workers.manage')
  @RequireFreshAdminAuth()
  @LimitAdmin('sensitive')
  retry(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: Command,
  ) {
    return this.service.rolloutAction(req.adminActor!, id, 'retry', body);
  }
}
@Controller('worker')
@WorkerOnly()
@WorkerCleanup()
export class WorkerUpdateController {
  constructor(
    private readonly service: WorkerRolloutsService,
    private readonly budget: RateBudgetService,
    private readonly keys: RateLimitKeys,
  ) {}
  private async admit(id: string) {
    const result = await this.budget.reserve([
      {
        key: this.keys.bucket('worker-update', id),
        limit: 60,
        windowMs: 60000,
      },
    ]);
    if (!result.allowed)
      throw new AuthRateLimitException(result.retryAfterSeconds);
  }
  @Get('update-policy') @Header('Cache-Control', 'no-store') async policy(
    @Req() req: WorkerAuthenticatedRequest,
  ) {
    await this.admit(req.workerIdentity.workerId);
    return this.service.getUpdateDecision(req.workerIdentity.workerId);
  }
  @Post('update-status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async status(
    @Req() req: WorkerAuthenticatedRequest,
    @Body() body: Record<string, unknown>,
  ) {
    await this.admit(req.workerIdentity.workerId);
    return this.service.updateStatus(req.workerIdentity, body);
  }
}
@Controller('worker-bootstrap')
export class WorkerBootstrapController {
  constructor(private readonly service: WorkerRolloutsService) {}
  @Public() @Get('stable') @Header('Cache-Control', 'no-store') stable(
    @Query('profileId') profileId: string,
  ) {
    return this.service.stable(profileId);
  }
}
