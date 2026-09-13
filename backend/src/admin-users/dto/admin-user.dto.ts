import { IsISO8601, Max, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class AdminUserProcessingDto {
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @IsUUID('4')
  operationId!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AdminAllowanceDto extends AdminUserProcessingDto {
  @IsInt() @Min(3600) @Max(86400) allowanceAudioSeconds!: number;
  @IsISO8601({ strict: true }) expiresAt!: string;
}
export class AdminSuspensionDto extends AdminUserProcessingDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true })
  expiresAt?: string;
}
