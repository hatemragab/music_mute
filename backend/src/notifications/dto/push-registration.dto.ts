import {
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export const PUSH_TOKEN_MAX_LENGTH = 4096;
export const PUSH_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

export class PushRegistrationDto {
  @IsString()
  @Length(1, PUSH_TOKEN_MAX_LENGTH)
  @Matches(PUSH_TOKEN_PATTERN)
  token!: string;
}

/** Omission preserves legacy opt-out; null and coerced numeric strings are rejected. */
export class PushDeactivationDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedBindingRevision?: number;
}
