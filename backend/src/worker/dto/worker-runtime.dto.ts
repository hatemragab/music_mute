import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const INSTALLATION_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,95}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class WorkerRuntimeDto {
  @Matches(INSTALLATION_ID_PATTERN) installationId!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) workerBuild!: number;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) launcherBuild!: number;
  // Keep numeric validation separate so obsolete clients receive a safe actionable reason.
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) protocolVersion!: number;
  @Matches(PROFILE_ID_PATTERN) profileId!: string;
  @Matches(SHA256_PATTERN) modelSha256!: string;
  @Matches(SHA256_PATTERN) runtimeLockSha256!: string;
  @IsIn(['windows', 'macos', 'linux']) os!: 'windows' | 'macos' | 'linux';
  @IsIn(['x64', 'arm64']) arch!: 'x64' | 'arm64';
  @IsIn([
    'starting',
    'ready',
    'busy',
    'updating',
    'paused',
    'recovery_required',
  ])
  activity!: string;
  @IsBoolean() bootVerified!: boolean;
}

export class QualificationReportDto {
  @Matches(PROFILE_ID_PATTERN) profileId!: string;
  @Matches(SHA256_PATTERN) modelSha256!: string;
  @Matches(SHA256_PATTERN) fixtureSha256!: string;
  @IsBoolean() acceleratorUsed!: boolean;
  @IsIn([
    'CUDAExecutionProvider',
    'DmlExecutionProvider',
    'CoreMLExecutionProvider',
    'MIGraphXExecutionProvider',
    'OpenVINOExecutionProvider',
    'ArmNNExecutionProvider',
  ])
  provider!: string;
  @IsString() @MinLength(1) @MaxLength(256) deviceLabel!: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) wallMilliseconds!: number;
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  peakRamBytes!: number | null;
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  peakGpuMemoryBytes!: number | null;
  @IsBoolean() outputValid!: boolean;
  @IsBoolean() referenceCheckPassed!: boolean;
  @IsBoolean() serviceContextPassed!: boolean;
  @IsArray()
  @ArrayMaxSize(32)
  @ArrayUnique()
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/, { each: true })
  reasonCodes!: string[];
}

export class BootReportDto {
  @Matches(SHA256_PATTERN) serviceBindingSha256!: string;
  @Matches(PROFILE_ID_PATTERN) profileId!: string;
  @IsBoolean() installed!: boolean;
  @IsBoolean() serviceContextPassed!: boolean;
  @IsBoolean() unattendedRebootPassed!: boolean;
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  observedBootId!: string | null;
  @IsDateString({ strict: true }) @MaxLength(35) observedAt!: string;
  @IsArray()
  @ArrayMaxSize(32)
  @ArrayUnique()
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/, { each: true })
  reasonCodes!: string[];
}

export class InstallationReadyDto {
  @Matches(INSTALLATION_ID_PATTERN) installationId!: string;
  @IsObject()
  @ValidateNested()
  @Type(() => WorkerRuntimeDto)
  runtime!: WorkerRuntimeDto;
  @Matches(INSTALLATION_ID_PATTERN) qualificationReportId!: string;
  @IsObject()
  @ValidateNested()
  @Type(() => BootReportDto)
  bootReport!: BootReportDto;
}
