import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsISO8601,
  IsInt,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { ProcessingQualification } from '../processing-qualification.js';
export class ProcessingQualificationDto implements ProcessingQualification {
  @IsString() @MinLength(1) @MaxLength(200) evidenceReference!: string;
  @IsString() @MinLength(1) @MaxLength(200) compatibilityRevision!: string;
  @IsISO8601({ strict: true }) measuredAt!: string;
  @IsISO8601({ strict: true }) expiresAt!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Matches(/^[a-z0-9][a-z0-9-]{0,63}$/, { each: true })
  qualifiedWorkerIds!: string[];
  @IsInt() @Min(1) @Max(20_000_000_000) maxLocalSourceBytes!: number;
  @IsInt() @Min(1) @Max(2_000_000_000) maxSourceDownloadBytes!: number;
  @IsInt() @Min(1) @Max(86400) maxPreparationSeconds!: number;
  @IsInt() @Min(1) @Max(86400) maxSourceDownloadSeconds!: number;
  @IsInt() @Min(1) @Max(100_000_000) maxOutputBytes!: number;
  @IsInt() @Min(1) @Max(3600) probeTimeoutSeconds!: number;
  @IsInt() @Min(1) @Max(86400) processingTimeoutSeconds!: number;
  @IsInt()
  @Min(1)
  @Max(86400_000)
  maxOutstandingEstimatedWorkerSeconds!: number;
  @IsString() @MinLength(1) @MaxLength(200) costModelRevision!: string;
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(Number.MIN_VALUE)
  @Max(1000)
  referenceProcessingSecondsPerAudioSecond!: number;
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(3600)
  fixedJobOverheadSeconds!: number;
}
