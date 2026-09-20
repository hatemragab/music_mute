import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  WORKER_PLATFORMS,
  WORKER_PROVIDERS,
  WORKER_PROTOCOL_VERSION,
  WORKER_RECIPE_IDS,
  type WorkerPlatform,
  type WorkerProvider,
  type WorkerRecipeId,
} from '../protocol/v1/protocol.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateWorkerInvitationDto {
  @IsUUID('4') operationId!: string;
  @IsInt() @Min(300) @Max(86400) expiresInSeconds!: number;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  initialPolicyId?: string;
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}

export class ExchangeWorkerInvitationDto {
  @IsUUID('4') requestId!: string;
}

export class GetWorkerInstallationArtifactsDto {
  @IsIn(WORKER_PLATFORMS) platform!: WorkerPlatform;
}

export class CreateWorkerQualificationUploadDto {
  @IsUUID('4') requestId!: string;
  @IsInt() @Min(1) @Max(30_000_000) bytes!: number;
  @Matches(/^[a-f0-9]{64}$/) sha256!: string;
}

export class ConfirmWorkerQualificationUploadDto {
  @IsUUID('4') requestId!: string;
  @Transform(trim)
  @IsString()
  @Length(1, 1024)
  @Matches(/^[A-Za-z0-9+/=_.,:-]+$/)
  versionId!: string;
}

export class WorkerGpuReportDto {
  @Transform(trim) @IsString() @Length(1, 128) id!: string;
  @Transform(trim) @IsString() @Length(1, 200) name!: string;
  @Transform(trim) @IsString() @Length(1, 100) driverVersion!: string;
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  memoryBytes?: number;
}

export class WorkerHardwareReportDto {
  @Transform(trim) @IsString() @Length(1, 100) os!: string;
  @Transform(trim) @IsString() @Length(1, 100) osBuild!: string;
  @Transform(trim) @IsString() @Length(1, 50) architecture!: string;
  @Transform(trim) @IsString() @Length(1, 200) cpu!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) memoryBytes!: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => WorkerGpuReportDto)
  gpus!: WorkerGpuReportDto[];
}

export class WorkerRuntimeIdentityDto {
  @Transform(trim) @IsString() @Length(1, 100) workerVersion!: string;
  @IsIn([WORKER_PROTOCOL_VERSION]) protocolVersion!: number;
  @Matches(/^[a-f0-9]{64}$/) manifestDigest!: string;
  @Matches(/^[a-f0-9]{64}$/) modelDigest!: string;
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  providerRuntimeVersion!: string;
}

export class WorkerCapabilityDto {
  @IsIn(WORKER_PLATFORMS) platform!: WorkerPlatform;
  @IsIn(WORKER_PROVIDERS) provider!: WorkerProvider;
  @Transform(trim) @IsString() @Length(1, 128) gpuId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @IsIn(WORKER_RECIPE_IDS, { each: true })
  recipeIds!: WorkerRecipeId[];
  @IsInt() @Min(1) @Max(16) maxSlots!: number;
}

export class ReportWorkerInstallationDto {
  @IsUUID('4') requestId!: string;
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  expectedRevision!: number;
  @Transform(trim) @IsString() @Length(1, 120) label!: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  groupId?: string;
  @ValidateNested()
  @Type(() => WorkerHardwareReportDto)
  hardware!: WorkerHardwareReportDto;
  @ValidateNested()
  @Type(() => WorkerRuntimeIdentityDto)
  runtime!: WorkerRuntimeIdentityDto;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => WorkerCapabilityDto)
  capabilities!: WorkerCapabilityDto[];
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  summary!: string;
}

export class ActivateWorkerInstallationDto {
  @IsUUID('4') requestId!: string;
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  expectedRevision!: number;
  @Matches(/^[a-f0-9]{64}$/) credentialDigest!: string;
}

export class WorkerLifecycleDto {
  @IsUUID('4') operationId!: string;
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  expectedRevision!: number;
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}
