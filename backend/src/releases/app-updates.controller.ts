import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators.js';
import { adminError } from '../admin/admin-errors.js';
import { ReleasePolicyService } from './release-policy.service.js';
import { releaseId } from './release-drafts.service.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { ConfigService } from '@nestjs/config';
@Controller('app-updates')
export class AppUpdatesController {
  constructor(
    private readonly policies: ReleasePolicyService,
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly config: ConfigService,
  ) {}
  private async limitGrant(
    request: Request,
    response: Response,
  ): Promise<void> {
    const decision = await this.budgets.reserve([
      {
        key: this.keys.bucket(
          'public-release-grant-ip',
          request.ip ?? 'unknown',
        ),
        limit: 10,
        windowMs: 60_000,
      },
      {
        key: this.keys.bucket('public-release-grant-service', 'global'),
        limit: this.config.get<number>('PUBLIC_RELEASE_GRANTS_PER_MINUTE', 300),
        windowMs: 60_000,
      },
    ]);
    if (!decision.allowed) {
      response.setHeader('Retry-After', decision.retryAfterSeconds);
      throw adminError('RATE_LIMITED');
    }
  }
  private empty(body: unknown) {
    if (
      body !== undefined &&
      (!body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length)
    )
      throw adminError('INVALID_REQUEST');
  }
  @Post('releases/:id/download-grants')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async download(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.empty(body);
    releaseId(id);
    await this.limitGrant(request, response);
    throw adminError('RESOURCE_NOT_FOUND');
  }
  @Get('releases/:id')
  @Public()
  @Header('Cache-Control', 'no-store')
  landing(@Param('id') id: string) {
    releaseId(id);
    throw adminError('RESOURCE_NOT_FOUND');
  }
  @Post('releases/:id/download-redirects')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  async open(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.empty(body);
    releaseId(id);
    await this.limitGrant(request, response);
    throw adminError('RESOURCE_NOT_FOUND');
  }
  @Get('policy')
  @Public()
  @Header('Cache-Control', 'no-store')
  policy(@Query() query: Record<string, unknown>) {
    if (
      Object.keys(query).some((k) => !['platform', 'distribution'].includes(k))
    )
      throw adminError('INVALID_REQUEST');
    return this.policies.snapshot(query.platform, query.distribution);
  }
}
