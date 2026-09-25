import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  IsBoolean,
  ValidateIf,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/auth-request.js';
import {
  LimitOperation,
  RequireProcessingAccess,
} from '../auth/auth.decorators.js';
import { ImportsService } from './imports.service.js';

export class CreateImportDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  trimEnabled?: boolean;

  @IsString() @MaxLength(2048) url!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  requestId!: string;
}

@Controller('media-imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @LimitOperation('processing-create')
  @RequireProcessingAccess()
  async create(
    @Req() req: AuthRequest,
    @Body() body: CreateImportDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.imports.create(
      req.user!._id.toHexString(),
      body.url,
      body.requestId,
      body.trimEnabled,
    );
    response.setHeader('Location', `/media-imports/${result.importId}`);
    return result;
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @LimitOperation('processing-read')
  get(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.imports.get(req.user!._id.toHexString(), id);
  }
}
