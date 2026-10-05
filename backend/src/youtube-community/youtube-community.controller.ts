import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { authError } from '../auth/auth.errors.js';
import { EmptyBodyPipe } from '../auth/dto/empty-body.pipe.js';
import {
  CreateYouTubeContributionDto,
  YouTubeCacheDeliveryDto,
  YouTubeContributionUploadDto,
} from './youtube-community.dto.js';
import { YouTubeCommunityService } from './youtube-community.service.js';

@Public()
@Controller()
export class YouTubeCommunityController {
  constructor(private readonly community: YouTubeCommunityService) {}
  @Post('youtube-guest-sessions')
  @Header('Cache-Control', 'no-store')
  session(@Req() req: Request, @Body(EmptyBodyPipe) _body: unknown) {
    return this.community.issueSession(req.ip);
  }
  @Post('youtube-cache-deliveries')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async delivery(@Req() req: Request, @Body() dto: YouTubeCacheDeliveryDto) {
    return this.community.delivery(await this.guest(req), dto.url);
  }
  @Post('youtube-contributions')
  @Header('Cache-Control', 'no-store')
  async create(@Req() req: Request, @Body() dto: CreateYouTubeContributionDto) {
    return this.community.create(await this.guest(req), dto);
  }
  @Get('youtube-contributions/:id')
  @Header('Cache-Control', 'no-store')
  async get(@Req() req: Request, @Param('id') id: string) {
    return this.community.get(await this.guest(req), id);
  }
  @Post('youtube-contributions/:id/source-deliveries')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async sourceDelivery(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.community.sourceDelivery(await this.guest(req), id);
  }
  @Post('youtube-contributions/:id/lease-renewals')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async renew(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.community.renewLease(await this.guest(req), id);
  }
  @Post('youtube-contributions/:id/upload-grants')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async grants(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: YouTubeContributionUploadDto,
  ) {
    return this.community.grants(await this.guest(req), id, dto);
  }
  @Post('youtube-contributions/:id/completions')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async complete(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.community.complete(await this.guest(req), id);
  }
  @Post('youtube-contributions/:id/failures')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async fail(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.community.fail(await this.guest(req), id);
  }
  private guest(req: Request) {
    const header = req.headers.authorization;
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
      throw authError('UNAUTHENTICATED');
    return this.community.authenticate(header.slice(7), req.ip);
  }
}
