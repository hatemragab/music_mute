import {
  Equals,
  IsIn,
  IsInt,
  IsNumber,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

const lowercase = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value;

export class ClaimDto {
  @Transform(lowercase) @IsUUID('4') sessionId!: string;
}
export class WorkerClaimDto extends ClaimDto {
  @IsInt() @Min(0) @Max(25) waitSeconds = 0;
}
export class WorkerSelectorDto extends ClaimDto {
  @Transform(lowercase) @Matches(/^[a-f0-9]{24}$/) jobId!: string;
  @Transform(lowercase) @IsUUID('4') attemptId!: string;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) generation!: number;
}
export class WorkerStageDto extends WorkerSelectorDto {
  @Transform(lowercase) @IsUUID('4') eventId!: string;
  @IsIn(['processing']) stage!: 'processing';
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(Number.MIN_VALUE)
  @Max(599.9999999999999)
  durationSeconds!: number;
  @Equals(true) decodable!: true;
  @Equals(true) hasAudio!: true;
}
