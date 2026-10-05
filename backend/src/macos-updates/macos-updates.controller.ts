import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators.js';
import { MacosUpdateService } from './macos-update.service.js';

@Controller('macos-updates')
export class MacosUpdatesController {
  constructor(private readonly updates: MacosUpdateService) {}
  @Get('appcast.xml')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async feed(@Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/xml; charset=utf-8');
    const feed = await this.updates.appcast();
    if (!feed) {
      response.status(404).end();
      return;
    }
    response.status(200).send(feed);
  }
  @Get('artifacts/:archiveName')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async artifact(
    @Param('archiveName') archiveName: string,
    @Res() response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(302, await this.updates.download(archiveName));
  }
}
