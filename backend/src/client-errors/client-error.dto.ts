import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const CLIENT_ERROR_STAGES = [
  'UNKNOWN',
  'SOURCE_INTAKE',
  'DOWNLOADING_SOURCE',
  'PREPARING_INPUT',
  'RESERVING_JOB',
  'UPLOADING_INPUT',
  'CONFIRMING_UPLOAD',
  'REFRESHING_JOB',
  'CANCELLING',
  'RETRYING',
  'FETCHING_OUTPUT',
  'PLAYBACK',
  'EXPORTING',
] as const;

export const CLIENT_ERROR_CODES = [
  'UNKNOWN',
  'NETWORK',
  'TIMEOUT',
  'AUTHENTICATION',
  'INVALID_MEDIA',
  'SOURCE_UNAVAILABLE',
  'STORAGE',
  'SERVER',
  'JOB_NOT_FOUND',
  'JOB_CONFLICT',
  'CHECKSUM_MISMATCH',
  'LOCAL_IO',
] as const;

export type ClientErrorStage = (typeof CLIENT_ERROR_STAGES)[number];
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

const printable = /^[^\p{Cc}\p{Cf}]+$/u;
const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class ClientErrorDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  eventId!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  operationId!: string;

  @IsOptional()
  @IsMongoId()
  jobId?: string;

  @IsString()
  @IsIn(CLIENT_ERROR_STAGES)
  stage!: ClientErrorStage;

  @IsString()
  @IsIn(CLIENT_ERROR_CODES)
  code!: ClientErrorCode;

  @IsBoolean()
  retryable!: boolean;

  @IsString()
  @IsIn(['android', 'ios'])
  platform!: 'android' | 'ios';

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(printable)
  appVersion!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(printable)
  osVersion!: string;

  @IsString()
  @IsDateString({ strict: true, strictSeparator: true })
  @Matches(utcTimestamp)
  occurredAt!: string;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(599)
  httpStatus?: number;
}
