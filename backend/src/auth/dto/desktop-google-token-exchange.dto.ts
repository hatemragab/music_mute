import { IsString, Length, Matches } from 'class-validator';

const LOOPBACK_CALLBACK =
  /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth2callback(?![\s\S])/;

/** The callback is a Google form value, never an outbound request destination. */
export function isDesktopGoogleRedirect(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = LOOPBACK_CALLBACK.exec(value);
  return match !== null && Number(match[1]) <= 65535;
}

export class DesktopGoogleTokenExchangeDto {
  @IsString()
  @Length(1, 4096)
  @Matches(/^[\x21-\x7e]+(?![\s\S])/)
  authorizationCode!: string;

  @IsString()
  @Length(43, 128)
  @Matches(/^[A-Za-z0-9._~-]+(?![\s\S])/)
  codeVerifier!: string;

  @IsString()
  @Length(1, 64)
  @Matches(LOOPBACK_CALLBACK)
  redirectUri!: string;
}
