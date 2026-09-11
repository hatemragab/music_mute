import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateProcessingSettingsDto {
  @IsBoolean() acceptNewJobs!: boolean;
  @Transform(trim)
  @ValidateBy({
    name: 'maintenanceMessageEn',
    validator: {
      validate: (value: unknown, args) =>
        typeof value === 'string' &&
        value.length <= 1000 &&
        ((args?.object as UpdateProcessingSettingsDto | undefined)
          ?.acceptNewJobs === true ||
          value.length > 0),
    },
  })
  maintenanceMessageEn!: string;
  @ValidateIf((_object, value) => value !== null)
  @Transform(trim)
  @IsString()
  @Length(0, 1000)
  maintenanceMessageAr!: string | null;
  @IsInt() @Min(2) @Max(30_000_000) maxInputBytesExclusive!: number;
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(Number.MIN_VALUE)
  @Max(600)
  maxDurationSecondsExclusive!: number;
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(100)
  maxActiveJobsPerUser!: number | null;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) expectedRevision!: number;
  @IsUUID('4') operationId!: string;
  @Transform(trim) @IsString() @Length(1, 500) reason!: string;
}
