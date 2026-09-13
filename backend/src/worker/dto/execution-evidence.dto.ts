import {
  IsBoolean,
  ValidateIf,
  IsISO8601,
  IsNumber,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import type { AttemptExecutionEvidence } from '../execution-evidence.js';
export class ExecutionEvidenceDto implements AttemptExecutionEvidence {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  separationCompleted?: boolean;
  @IsUUID('4') eventId!: string;
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(86400)
  separatorExecutionSeconds!: number;
  @IsISO8601({ strict: true }) processingStartedAt!: string;
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(Number.MIN_VALUE)
  @Max(1800)
  measuredAudioSeconds!: number;
  @IsBoolean() stoppedConfirmed!: boolean;
}
