import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ADMIN_ROLES } from '../admin-access.schema.js';
import type { AdminRole } from '../admin.types.js';

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateAdminAccessDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(320)
  verifiedEmail!: string;

  @IsIn(ADMIN_ROLES)
  role!: AdminRole;

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

export class UpdateAdminAccessDto {
  @IsOptional()
  @IsIn(ADMIN_ROLES)
  role?: AdminRole;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
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
