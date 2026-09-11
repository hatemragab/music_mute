import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AUDIO_NAME_PATTERN } from '../job-metadata.js';

export class RenameJobDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(AUDIO_NAME_PATTERN)
  displayName!: string;
}
