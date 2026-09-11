import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import type { Platform } from '../../auth/auth.types.js';
import type { UpdateSource } from '../release.types.js';
export class ReleaseMutationDto {
  @IsUUID('4') operationId!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 500)
  reason!: string;
}
export class ReleaseDraftDto extends ReleaseMutationDto {
  @IsIn(['android', 'ios']) platform!: Platform;
  @IsIn(['direct_apk', 'google_play', 'app_store']) source!: UpdateSource;
  @IsString() @Length(1, 64) versionName!: string;
  @IsInt() @Min(1) @Max(2147483647) buildNumber!: number;
  @IsString() @Length(1, 10000) changelogEn!: string;
  @ValidateIf((_o, v) => v !== null) @IsString() @Length(1, 2048) storeUrl!:
    string | null;
}
export class EditReleaseDraftDto extends ReleaseMutationDto {
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) expectedRevision!: number;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 64)
  versionName?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  buildNumber?: number;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 10000)
  changelogEn?: string;
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @IsString()
  @Length(1, 2048)
  storeUrl?: string | null;
}
