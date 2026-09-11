import { Transform } from 'class-transformer';
import { Equals, IsUUID } from 'class-validator';
import { ClaimDto } from './worker-request.dto.js';

export class ReconcileDto extends ClaimDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  previousAttemptId!: string;
  @Equals(true) stopped!: true;
}
