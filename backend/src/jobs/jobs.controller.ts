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
  UseGuards,
} from '@nestjs/common';
import type { AuthRequest } from '../auth/auth-request.js';
import { RequireProcessingAccess } from '../auth/auth.decorators.js';
import { EmptyBodyPipe } from '../auth/dto/empty-body.pipe.js';
import { ProcessingEnabledGuard } from '../processing/processing-enabled.guard.js';
import { CreateJobDto } from './dto/create-job.dto.js';
import { JobsService } from './jobs.service.js';
import { JobsQueryService } from './jobs-query.service.js';
import { DownloadJobDto } from './dto/download-job.dto.js';
import { JobActionsService } from './job-actions.service.js';
import { RetryJobDto } from './dto/retry-job.dto.js';
import { RenameJobDto } from './dto/rename-job.dto.js';
import { JobMetadataService } from './job-metadata.service.js';
import { JobDeletionService } from './job-deletion.service.js';

@Controller('jobs')
@UseGuards(ProcessingEnabledGuard)
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly query: JobsQueryService,
    private readonly actions: JobActionsService,
    private readonly metadata: JobMetadataService,
    private readonly deletion: JobDeletionService,
  ) {}

  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    await this.deletion.delete(req.user!._id.toHexString(), id);
  }

  @Patch(':id')
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
  @HttpCode(200)
  cancel(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.actions.cancel(req.user!._id.toHexString(), id);
  }

  @Post(':id/retry')
  @RequireProcessingAccess()
  retry(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() dto: RetryJobDto,
  ) {
    return this.actions.retry(req.user!._id.toHexString(), id, dto.requestId);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: AuthRequest,
    @Query() query: { limit?: string; cursor?: string; status?: string },
  ) {
    return this.query.list(req.user!._id.toHexString(), query);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.query.detail(req.user!._id.toHexString(), id);
  }

  @Post(':id/download-url')
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
  @RequireProcessingAccess()
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthRequest, @Body() dto: CreateJobDto) {
    return this.jobs.create(
      req.user!._id.toHexString(),
      dto.input,
      dto.requestId,
      {
        sourceTitle: dto.sourceTitle,
        sourceKind: dto.sourceKind,
        sourceUrl: dto.sourceUrl,
        clientStartedAt: dto.clientStartedAt,
      },
    );
  }

  @Post(':id/upload-url')
  @HttpCode(200)
  @RequireProcessingAccess()
  @Header('Cache-Control', 'no-store')
  renew(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.jobs.renewUpload(req.user!._id.toHexString(), id);
  }

  @Post(':id/upload-complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  confirm(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body(EmptyBodyPipe) _body: unknown,
  ) {
    return this.jobs.confirmUpload(req.user!._id.toHexString(), id);
  }
}
