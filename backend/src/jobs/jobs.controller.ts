import {
  Body,
  Controller,
  Delete,
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
import { SkipThrottle } from '@nestjs/throttler';
import {
  LimitOperation,
  RequireProcessingAccess,
} from '../auth/auth.decorators.js';
import { EmptyBodyPipe } from '../auth/dto/empty-body.pipe.js';
import { ProcessingUnavailableService } from '../processing/processing-unavailable.service.js';
import { CreateJobDto } from './dto/create-job.dto.js';
import { JobsQueryService } from './jobs-query.service.js';
import { DownloadJobDto } from './dto/download-job.dto.js';
import { JobActionsService } from './job-actions.service.js';
import { RetryJobDto } from './dto/retry-job.dto.js';
import { RenameJobDto } from './dto/rename-job.dto.js';
import { JobMetadataService } from './job-metadata.service.js';
import { JobDeletionService } from './job-deletion.service.js';

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly query: JobsQueryService,
    private readonly actions: JobActionsService,
    private readonly metadata: JobMetadataService,
    private readonly deletion: JobDeletionService,
    private readonly unavailable: ProcessingUnavailableService,
  ) {}

  @Delete(':id')
  @LimitOperation('processing-mutation')
  @HttpCode(204)
  async delete(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    await this.deletion.delete(req.user!._id.toHexString(), id);
  }

  @Patch(':id')
  @LimitOperation('processing-mutation')
  @Header('Cache-Control', 'no-store')
  rename(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: RenameJobDto,
  ) {
    return this.metadata.rename(
      req.user!._id.toHexString(),
      id,
      dto.displayName,
    );
  }

  @Post(':id/cancel')
  @LimitOperation('processing-mutation')
  @HttpCode(200)
  cancel(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.actions.cancel(req.user!._id.toHexString(), id);
  }

  @Post(':id/retry')
  @LimitOperation('processing-create')
  @RequireProcessingAccess()
  retry(
    @Req() _req: AuthRequest,
    @Param('id') _id: string,
    @Body() _dto: RetryJobDto,
  ) {
    return this.unavailable.reject();
  }

  @Get()
  @LimitOperation('processing-read')
  @SkipThrottle({ default: true })
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: AuthRequest,
    @Query() query: { limit?: string; cursor?: string; status?: string },
  ) {
    return this.query.list(req.user!._id.toHexString(), query);
  }

  @Get(':id')
  @LimitOperation('processing-read')
  @SkipThrottle({ default: true })
  @Header('Cache-Control', 'no-store')
  detail(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.query.detail(req.user!._id.toHexString(), id);
  }

  @Post(':id/download-url')
  @LimitOperation('processing-grant')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  download(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: DownloadJobDto,
  ) {
    return this.query.download(req.user!._id.toHexString(), id, dto.artifact);
  }

  @Post()
  @LimitOperation('processing-create')
  @RequireProcessingAccess()
  @Header('Cache-Control', 'no-store')
  create(@Req() _req: AuthRequest, @Body() _dto: CreateJobDto) {
    return this.unavailable.reject();
  }

  @Post(':id/upload-url')
  @LimitOperation('processing-grant')
  @RequireProcessingAccess()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  renew(
    @Req() _req: AuthRequest,
    @Param('id') _id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.unavailable.reject();
  }

  @Post(':id/upload-complete')
  @LimitOperation('processing-grant')
  @RequireProcessingAccess()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  confirm(
    @Req() _req: AuthRequest,
    @Param('id') _id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.unavailable.reject();
  }
}
