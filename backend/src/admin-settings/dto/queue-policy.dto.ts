import { Type } from 'class-transformer';
import { IsObject, ValidateIf, ValidateNested } from 'class-validator';
import { ProcessingQualificationDto } from './processing-qualification.dto.js';
import { Equals, IsBoolean, IsInt, Max, Min } from 'class-validator';
import { AdminUserProcessingDto } from '../../admin-users/dto/admin-user.dto.js';
import type { QueuePolicyValues } from '../queue-policy.schema.js';
export class UpdateQueuePolicyDto
  extends AdminUserProcessingDto
  implements QueuePolicyValues
{
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsObject()
  @ValidateNested()
  @Type(() => ProcessingQualificationDto)
  qualification?: ProcessingQualificationDto | null;
  @Equals(2) schemaVersion!: 2;
  @IsBoolean() acceptNewJobs!: boolean;
  @IsBoolean() acceptLongJobs!: boolean;
  @IsInt() @Min(1) @Max(1800) maxDurationSeconds!: number;
  @IsInt() @Min(1) @Max(100_000_000) maxPreparedAudioBytes!: number;
  @Equals(1) maxActiveJobsPerUser!: number;
  @IsInt() @Min(3600) @Max(86400) allowanceAudioSeconds!: number;
  @Equals(86400) allowanceWindowSeconds!: number;
  @IsInt() @Min(1) @Max(1000) maxOutstandingJobs!: number;
  @IsInt() @Min(1) @Max(1_800_000) maxOutstandingAudioSeconds!: number;
  @IsInt() @Min(1) @Max(86400) agingThresholdSeconds!: number;
}
