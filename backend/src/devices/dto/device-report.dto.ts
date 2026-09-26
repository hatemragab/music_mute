import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import type { ClientPlatform } from '../../auth/auth.types.js';

const printable = /^[^\p{Cc}\p{Cf}]+$/u;

export class DeviceMetadataDto {
  @IsIn(['android', 'ios', 'web'])
  platform!: ClientPlatform;

  @IsString()
  @Length(1, 32)
  @Matches(printable)
  appVersion!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  buildNumber!: number;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  metadataRevision!: number;

  @IsString()
  @Length(1, 64)
  @Matches(printable)
  osVersion!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Matches(printable)
  deviceModel?: string;
}

export class DeviceReportDto extends DeviceMetadataDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  installationId!: string;
}
