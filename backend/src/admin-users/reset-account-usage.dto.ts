import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class ResetAccountUsageDto {
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedRevision!: number;
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) periodKey!: string;
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/) dayKey!: string;
  @IsUUID('4') operationId!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 500)
  reason!: string;
}
