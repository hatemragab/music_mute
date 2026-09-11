import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { adminError } from '../admin/admin-errors.js';
import { ReleasePolicyService } from './release-policy.service.js';
import { ReleaseDownloadService } from './release-download.service.js';
import { releaseId } from './release-drafts.service.js';
@Controller('app-updates')
export class AppUpdatesController {
  constructor(
    private readonly policies: ReleasePolicyService,
    private readonly downloads: ReleaseDownloadService,
  ) {}
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
  @Post('releases/:id/download')
  @Public()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  download(@Param('id') id: string, @Body() body: unknown) {
    this.empty(body);
    return this.downloads.grant(id);
  }
  @Get('releases/:id')
  @Public()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  landing(@Param('id') id: string) {
    releaseId(id);
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Update MusicMute</title><style>body{font:18px system-ui;margin:10vh auto;padding:24px;max-width:560px;color:#14231f;background:#f3f7f5}button{font:inherit;background:#146c50;color:white;border:0;border-radius:12px;padding:14px 24px}p{line-height:1.6}</style><main><h1>Update MusicMute</h1><p>Download the signed Android update, then open the APK to install it. Your audio and account stay on your device.</p><form method="post" action="/api/v1/app-updates/releases/${id}/open"><button type="submit">Download APK</button></form><p>This link works while the release is available.</p></main></html>`;
  }
  @Post('releases/:id/open')
  @Public()
  @Header('Cache-Control', 'no-store')
  async open(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    this.empty(body);
    const grant = await this.downloads.grant(id);
    response.redirect(303, grant.url);
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
