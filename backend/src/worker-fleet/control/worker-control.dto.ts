import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  WORKER_PLATFORMS,
  WORKER_RECIPE_IDS,
  type WorkerPlatform,
  type WorkerRecipeId,
} from '../protocol/v1/protocol.js';
import type { WorkerMachineStatus } from '../worker-fleet.types.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class WorkerConfigQueryDto {
  @IsUUID('4') sessionId!: string;
  @IsUUID('4') incarnation!: string;
}

export class ApplyWorkerConfigDto extends WorkerConfigQueryDto {
  @IsUUID('4') requestId!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) revision!: number;
}

export class WorkerRecipePolicyDto {
  @IsIn(WORKER_RECIPE_IDS) recipeId!: WorkerRecipeId;
  @IsBoolean() enabled!: boolean;
  @IsInt() @Min(1) @Max(2) maxSlotsPerMachine!: number;
}

export class UpdateWorkerFleetPolicyDto {
  @IsUUID('4') operationId!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) expectedRevision!: number;
  @IsBoolean() acceptClaims!: boolean;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => WorkerRecipePolicyDto)
  recipes!: WorkerRecipePolicyDto[];
  @IsInt() @Min(15) @Max(300) leaseSeconds!: number;
  @IsInt() @Min(60) @Max(7200) processingDeadlineSeconds!: number;
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}

export class AdminWorkerListQueryDto {
  @IsOptional()
  @IsIn(['pending', 'active', 'paused', 'draining', 'revoked'])
  status?: WorkerMachineStatus;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) groupId?: string;
  @IsOptional() @IsIn(WORKER_PLATFORMS) platform?: WorkerPlatform;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  releaseVersion?: string;
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class AdminWorkerPageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class RequestWorkerDoctorDto {
  @IsUUID('4') operationId!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) expectedRevision!: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsIn(['service', 'storage', 'model', 'provider', 'ffmpeg'], { each: true })
  checks!: string[];
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}

export class RequestWorkerBenchmarkDto {
  @IsUUID('4') operationId!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) expectedRevision!: number;
  @IsIn(WORKER_RECIPE_IDS) recipeId!: WorkerRecipeId;
  @IsInt() @Min(1) @Max(1) iterations!: number;
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}

export class WorkerCommandMetricDto {
  @Transform(trim) @IsString() @Length(1, 100) name!: string;
  @IsNumber() value!: number;
  @Transform(trim) @IsString() @Length(1, 30) unit!: string;
}

export class CompleteWorkerCommandDto extends WorkerConfigQueryDto {
  @IsUUID('4') requestId!: string;
  @IsIn(['succeeded', 'failed']) outcome!: 'succeeded' | 'failed';
  @Transform(trim) @IsString() @MaxLength(500) summary!: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => WorkerCommandMetricDto)
  metrics!: WorkerCommandMetricDto[];
}
