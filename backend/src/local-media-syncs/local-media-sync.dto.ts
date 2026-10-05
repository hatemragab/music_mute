import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { InputDeclarationDto } from '../jobs/dto/create-job.dto.js';
import {
  AUDIO_NAME_PATTERN,
  YOUTUBE_SOURCE_URL_PATTERN,
} from '../jobs/job-metadata.js';
import type { UploadGrant } from '../jobs/job.types.js';

export const LOCAL_MEDIA_PROFILE_ID = 'kim-vocal-2-full-timeline-v1';
export class CreateLocalMediaSyncDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  requestId!: string;
  @IsDefined() @IsIn([LOCAL_MEDIA_PROFILE_ID]) profileId!: string;
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
  @IsDefined() @IsIn(['file', 'url']) sourceKind!: 'file' | 'url';
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
  @IsString()
  @Matches(YOUTUBE_SOURCE_URL_PATTERN)
  sourceUrl?: string;
}
export interface LocalMediaSyncView {
  syncId: string;
  jobId: string;
  requestId: string;
  status: 'awaiting_upload' | 'ready' | 'expired';
  expiresAt: string;
  profileId: typeof LOCAL_MEDIA_PROFILE_ID;
  committed: boolean;
  revision: number;
  uploadGrants: { original: UploadGrant; vocals: UploadGrant } | null;
}
