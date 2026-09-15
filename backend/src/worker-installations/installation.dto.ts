import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  INSTALLATION_ID_PATTERN,
  SHA256_PATTERN,
  WorkerRuntimeDto,
  QualificationReportDto,
} from '../worker/dto/worker-runtime.dto.js';
export class RegisterInstallationDto {
  @Matches(INSTALLATION_ID_PATTERN) installationId!: string;
  @Matches(SHA256_PATTERN) tokenSha256!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) installerBuild!: number;
  @IsIn(['windows', 'macos', 'linux']) os!: string;
  @IsIn(['x64', 'arm64']) arch!: string;
}
export class InstallationOperationDto {
  @Matches(INSTALLATION_ID_PATTERN) operationId!: string;
}
export class RequestPairingDto extends InstallationOperationDto {
  @Matches(SHA256_PATTERN) workerKeySha256!: string;
  @Matches(INSTALLATION_ID_PATTERN) reportId!: string;
}
export class InstallationQualificationDto {
  @IsObject()
  @ValidateNested()
  @Type(() => WorkerRuntimeDto)
  runtime!: WorkerRuntimeDto;
  @IsObject()
  @ValidateNested()
  @Type(() => QualificationReportDto)
  qualificationReport!: QualificationReportDto;
  @Matches(SHA256_PATTERN) serviceBindingSha256!: string;
}
export class ApproveInstallationDto extends InstallationOperationDto {
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsString() @MaxLength(11) userCode!: string;
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[^\p{Cc}]+$/u)
  label!: string;
}
export class RejectInstallationDto extends InstallationOperationDto {
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}
