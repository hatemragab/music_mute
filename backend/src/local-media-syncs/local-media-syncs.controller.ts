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
import { LimitOperation } from '../auth/auth.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { authError } from '../auth/auth.errors.js';
import { EmptyBodyPipe } from '../auth/dto/empty-body.pipe.js';
import { FirebaseIdentityService } from '../auth/firebase-identity.service.js';
import { UploadGrantDto } from '../jobs/dto/upload-grant.dto.js';
import { CreateLocalMediaSyncDto } from './local-media-sync.dto.js';
import { LocalMediaSyncsService } from './local-media-syncs.service.js';
@Controller('local-media-syncs')
export class LocalMediaSyncsController {
  constructor(
    private readonly syncs: LocalMediaSyncsService,
    private readonly firebase: FirebaseIdentityService,
  ) {}
  @Post()
  @LimitOperation('processing-create')
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthRequest, @Body() dto: CreateLocalMediaSyncDto) {
    return this.syncs.create(
      req.user!._id.toHexString(),
      dto,
      req.identity.authTimeSec,
    );
  }
  @Get(':id')
  @LimitOperation('processing-read')
  @Header('Cache-Control', 'no-store')
  get(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.syncs.get(req.user!._id.toHexString(), id);
  }
  @Post(':id/upload-grants')
  @LimitOperation('processing-upload-grant')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  grants(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: UploadGrantDto,
  ) {
    return this.syncs.grants(
      req.user!._id.toHexString(),
      id,
      dto.requestId,
      req.identity.authTimeSec,
    );
  }
  @Post(':id/completions')
  @LimitOperation('processing-upload-confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  complete(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.syncs.complete(
      req.user!._id.toHexString(),
      id,
      req.identity.authTimeSec,
      async () => {
        const refreshed = await this.firebase.verifySession(req.bearer);
        if (
          refreshed.uid !== req.identity.uid ||
          refreshed.authTimeSec !== req.identity.authTimeSec
        )
          throw authError('UNAUTHENTICATED');
      },
    );
  }
}
