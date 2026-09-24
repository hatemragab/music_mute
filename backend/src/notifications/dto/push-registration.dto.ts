import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

export const PUSH_TOKEN_MAX_LENGTH = 4096;
export const PUSH_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

export class PushRegistrationDto {
  @IsString()
  @Length(1, PUSH_TOKEN_MAX_LENGTH)
  @Matches(PUSH_TOKEN_PATTERN)
  token!: string;
}

export class PushDeactivationDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedBindingRevision!: number;
}
