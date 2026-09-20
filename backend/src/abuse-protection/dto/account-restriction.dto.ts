import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  RESTRICTION_REASON_CODES,
  type RestrictionReasonCode,
} from '../abuse-protection.types.js';

export class PutAccountRestrictionDto {
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @IsUUID('4')
  operationId!: string;

  @IsIn(RESTRICTION_REASON_CODES)
  reasonCode!: RestrictionReasonCode;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string;
}

export class DeleteAccountRestrictionDto {
  @IsInt()
  @Min(1)
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
