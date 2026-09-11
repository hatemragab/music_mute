import { Transform } from 'class-transformer';
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
  JOB_FAILURE_CODES,
  type JobFailureCode,
} from '../../jobs/job.types.js';
import { WorkerSelectorDto } from './worker-request.dto.js';

export class WorkerEventDto extends WorkerSelectorDto {
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
  @IsIn(JOB_FAILURE_CODES) code!: JobFailureCode;
  @IsIn(['validating', 'processing', 'uploading_result']) stage!:
    'validating' | 'processing' | 'uploading_result';
  @IsOptional() @IsInt() @Min(-2147483648) @Max(4294967295) exitCode?: number;
}

export class WorkerLocalCleanupDto extends WorkerEventDto {
  @Equals(true) localDataDeleted!: true;
}
