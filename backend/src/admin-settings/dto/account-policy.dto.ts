import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { visitorCountry } from '../../devices/cloudflare-location.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class AccountPolicyValuesDto {
  @IsInt() @Min(1) monthlyProcessingSeconds!: number;
  @IsInt() @Min(1) maxDurationSeconds!: number;
  @IsInt() @Min(1) maxPreparedAudioBytes!: number;
  @IsInt() @Min(1) dailyUploadGrants!: number;
  @IsInt() @Min(1) monthlyUploadGrants!: number;
  @IsInt() @Min(1) monthlyConfirmedUploadBytes!: number;
  @IsInt() @Min(0) maxWaitingJobs!: number;
  @IsInt() @Min(1) maxProcessingJobs!: number;
  @IsInt() @Min(1) maxInfrastructureAttempts!: number;
  @IsInt() @Min(1) maxClientInputAttempts!: number;
  @IsInt() @Min(1) monthlyDownloadGrants!: number;
  @IsInt() @Min(1) monthlyEstimatedDownloadBytes!: number;
  @IsInt() @Min(1) maxRetainedOutputBytes!: number;
  @IsInt() @Min(1) @Max(600) signedUrlTtlSeconds!: number;
  @IsInt() @Min(1) monthlyServiceOutboundBytes!: number;
  @IsInt() @Min(24) deletionGraceHours!: number;
}

export class UpdateAccountPolicyDto extends AccountPolicyValuesDto {
  @IsBoolean() acceptNewJobs!: boolean;

  // Older dashboard writes preserve the current values when these are absent.
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  linkImportEnabled?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(250)
  @ArrayUnique()
  @ValidateBy({
    name: 'assignedCountryCodes',
    validator: {
      validate: (value: unknown) =>
        Array.isArray(value) &&
        value.every((code) => visitorCountry(code) !== null),
    },
  })
  linkImportDisabledCountries?: string[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @ValidateBy({
    name: 'canonicalAccountIds',
    validator: {
      validate: (value: unknown) =>
        Array.isArray(value) &&
        value.every(
          (id) =>
            typeof id === 'string' &&
            id.length === 24 &&
            /^[a-f0-9]{24}$/.test(id),
        ),
    },
  })
  linkImportDisabledUserIds?: string[];

  @Transform(trim)
  @ValidateBy({
    name: 'maintenanceMessageEn',
    validator: {
      validate: (value: unknown, args) =>
        typeof value === 'string' &&
        value.length <= 1000 &&
        ((args?.object as UpdateAccountPolicyDto | undefined)?.acceptNewJobs ===
          true ||
          value.length > 0),
    },
  })
  maintenanceMessageEn!: string;

  @ValidateIf((_object, value) => value !== null)
  @Transform(trim)
  @IsString()
  @Length(0, 1000)
  maintenanceMessageAr!: string | null;

  @IsInt() @Min(0) expectedRevision!: number;
  @IsUUID('4') operationId!: string;
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}

export class AccountPolicyOverrideValuesDto {
  @ValidateIf(
    (object: AccountPolicyOverrideValuesDto, value: unknown) =>
      value !== undefined ||
      Object.values(object).every((candidate) => candidate === undefined),
  )
  @IsInt()
  @Min(1)
  monthlyProcessingSeconds?: number;
  @IsOptional() @IsInt() @Min(1) maxDurationSeconds?: number;
  @IsOptional() @IsInt() @Min(1) maxPreparedAudioBytes?: number;
  @IsOptional() @IsInt() @Min(1) dailyUploadGrants?: number;
  @IsOptional() @IsInt() @Min(1) monthlyUploadGrants?: number;
  @IsOptional() @IsInt() @Min(1) monthlyConfirmedUploadBytes?: number;
  @IsOptional() @IsInt() @Min(1) maxClientInputAttempts?: number;
  @IsOptional() @IsInt() @Min(1) monthlyDownloadGrants?: number;
  @IsOptional() @IsInt() @Min(1) monthlyEstimatedDownloadBytes?: number;
  @IsOptional() @IsInt() @Min(1) maxRetainedOutputBytes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(600) signedUrlTtlSeconds?: number;
}

export class PutAccountPolicyOverrideDto {
  @IsObject()
  @ValidateNested()
  @Type(() => AccountPolicyOverrideValuesDto)
  values!: AccountPolicyOverrideValuesDto;

  @ValidateIf((_object, value) => value !== null)
  @IsISO8601({ strict: true })
  expiresAt!: string | null;

  @IsInt() @Min(0) expectedRevision!: number;
  @IsUUID('4') operationId!: string;
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}

export class DeleteAccountPolicyOverrideDto {
  @IsInt() @Min(1) expectedRevision!: number;
  @IsUUID('4') operationId!: string;
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}
