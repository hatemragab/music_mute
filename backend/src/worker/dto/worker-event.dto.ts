import { IsObject, ValidateIf, ValidateNested } from 'class-validator';
import { ExecutionEvidenceDto } from './execution-evidence.dto.js';
import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  WORKER_FAILURE_CODES,
  type WorkerFailureCode,
} from '../../jobs/job.types.js';
import { WorkerSelectorDto } from './worker-request.dto.js';

export class WorkerEventDto extends WorkerSelectorDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => ExecutionEvidenceDto)
  executionEvidence?: ExecutionEvidenceDto;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  eventId!: string;
}
export class WorkerStoppedDto extends WorkerEventDto {
  @Equals(true) stopped!: true;
}
export class WorkerFailDto extends WorkerStoppedDto {
  @IsIn(WORKER_FAILURE_CODES) code!: WorkerFailureCode;
  @IsIn(['validating', 'processing', 'uploading_result']) stage!:
    'validating' | 'processing' | 'uploading_result';
  @IsOptional() @IsInt() @Min(-2147483648) @Max(4294967295) exitCode?: number;
}

export class WorkerLocalCleanupDto extends WorkerEventDto {
  @Equals(true) localDataDeleted!: true;
}
