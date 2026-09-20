import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { JobFailureCode } from '../../jobs/job.types.js';
import {
  WORKER_RECIPE_IDS,
  type WorkerRecipeId,
} from '../protocol/v1/protocol.js';

export class WorkerAttemptOwnershipDto {
  @IsUUID('4') requestId!: string;
  @IsUUID('4') workerId!: string;
  @IsUUID('4') sessionId!: string;
  @IsUUID('4') incarnation!: string;
}

export class WorkerInputGrantDto extends WorkerAttemptOwnershipDto {}

export class WorkerOutputGrantDto extends WorkerAttemptOwnershipDto {
  @IsInt() @Min(1) @Max(30_000_000) bytes!: number;
  @Matches(/^[A-Za-z0-9+/]{43}=$/) sha256!: string;
  @Equals('audio/mpeg') contentType!: 'audio/mpeg';
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.001)
  @Max(1200)
  measuredDurationSeconds!: number;
}

export class CompleteWorkerAttemptDto extends WorkerAttemptOwnershipDto {
  @IsString() @MaxLength(1024) versionId!: string;
  @IsIn(WORKER_RECIPE_IDS) recipeId!: WorkerRecipeId;
  @IsInt() @Min(0) recipeRevision!: number;
  @Matches(/^[a-f0-9]{64}$/) recipeDigest!: string;
  @Matches(/^[a-f0-9]{64}$/) modelDigest!: string;
  @IsBoolean() trimEnabled!: boolean;
  @IsBoolean() denoiseEnabled!: boolean;
  @Equals('mp3') outputFormat!: 'mp3';
  @Equals(192) outputBitrateKbps!: 192;
}

const WORKER_FAILURE_CODES: readonly JobFailureCode[] = [
  'INVALID_AUDIO',
  'INPUT_TOO_LONG',
  'INPUT_CHECKSUM_MISMATCH',
  'SEPARATOR_FAILED',
  'OUTPUT_INVALID',
  'DOWNLOAD_FAILED',
  'OUTPUT_UPLOAD_FAILED',
];

export class FailWorkerAttemptDto extends WorkerAttemptOwnershipDto {
  @IsIn(WORKER_FAILURE_CODES) code!: JobFailureCode;
  @IsString() @MaxLength(500) summary!: string;
}
