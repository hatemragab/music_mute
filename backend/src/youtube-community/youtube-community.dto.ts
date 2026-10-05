import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsObject,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { InputDeclarationDto } from '../jobs/dto/create-job.dto.js';
import { YOUTUBE_COMMUNITY_PROFILE_ID } from './youtube-community.types.js';

export class YouTubeCacheDeliveryDto {
  @IsString() @MinLength(1) @MaxLength(2048) url!: string;
}
export class CreateYouTubeContributionDto extends YouTubeCacheDeliveryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  requestId!: string;
  @IsDefined() @IsIn([YOUTUBE_COMMUNITY_PROFILE_ID]) profileId!: string;
}
export class YouTubeContributionUploadDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  requestId!: string;
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => InputDeclarationDto)
  original!: InputDeclarationDto;
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => InputDeclarationDto)
  vocals!: InputDeclarationDto;
}
