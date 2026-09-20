import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  AUDIO_TYPES,
  PREPARATION_PROFILE_ID,
  type InputDeclaration,
  type InputSource,
} from '../job.types.js';
import { isSha256 } from '../job-state.js';
import {
  AUDIO_NAME_PATTERN,
  YOUTUBE_SOURCE_URL_PATTERN,
} from '../job-metadata.js';

export class InputDeclarationDto implements InputDeclaration {
  @IsIn(Object.keys(AUDIO_TYPES)) extension!: keyof typeof AUDIO_TYPES;
  @IsString() @IsIn(Object.values(AUDIO_TYPES)) contentType!: string;
  @IsInt() @Min(1) @Max(50_000_000) bytes!: number;
  @ValidateBy({
    name: 'audioDuration',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value > 0 &&
        value <= 1_200,
    },
  })
  durationSeconds!: number;
  @ValidateBy({ name: 'sha256', validator: { validate: isSha256 } })
  sha256!: string;
}

export class CreateJobDto {
  @IsDefined()
  @IsIn([2])
  policyVersion!: 2;
  @IsDefined()
  @IsIn([PREPARATION_PROFILE_ID])
  preparationProfileId!: string;
  @IsDefined()
  @IsIn(['audio_file', 'video_file', 'youtube'])
  source!: InputSource;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  requestId!: string;
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => InputDeclarationDto)
  input!: InputDeclarationDto;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(AUDIO_NAME_PATTERN)
  sourceTitle?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['url', 'file'])
  sourceKind?: 'url' | 'file';

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(64)
  @Matches(YOUTUBE_SOURCE_URL_PATTERN)
  sourceUrl?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/)
  clientStartedAt?: string;
}
