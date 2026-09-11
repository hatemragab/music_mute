import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsMongoId,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { WORKER_ID_PATTERN } from '../../worker/worker-registration.schema.js';
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export class WorkerOperationDto {
  @IsUUID('4') operationId!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}
export class CreateAdminWorkerDto extends WorkerOperationDto {
  @IsString() @Matches(WORKER_ID_PATTERN) id!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) label!: string;
}
export class UpdateAdminWorkerDto extends WorkerOperationDto {
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) expectedRevision!: number;
}
export class RenameAdminWorkerDto extends UpdateAdminWorkerDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) label!: string;
}
export class RevokeAdminWorkerDto extends UpdateAdminWorkerDto {
  @IsBoolean() emergency!: boolean;
}
export class ReleaseStoppedWorkerDto extends UpdateAdminWorkerDto {
  @IsMongoId() jobId!: string;
  @IsUUID('4') attemptId!: string;
  @IsUUID('4') sessionId!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) generation!: number;
  @IsISO8601({ strict: true }) stoppedAt!: string;
  @Transform(trim)
  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  stopEvidence!: string;
}
