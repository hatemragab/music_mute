import { ExecutionEvidenceDto } from './execution-evidence.dto.js';
import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsUUID,
  IsObject,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ClaimDto } from './worker-request.dto.js';

export class ReconcileDto extends ClaimDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID('4')
  eventId?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => ExecutionEvidenceDto)
  executionEvidence?: ExecutionEvidenceDto;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  previousAttemptId!: string;
  @Equals(true) stopped!: true;
}
