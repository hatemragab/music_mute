import { HttpException, HttpStatus } from '@nestjs/common';

const authErrors = {
  REAUTHENTICATION_REQUIRED: {
    statusCode: HttpStatus.UNAUTHORIZED,
    message: 'Sign in again to delete your account',
  },
  INVALID_INPUT: {
    statusCode: HttpStatus.BAD_REQUEST,
    message: 'Invalid input',
  },
  UNAUTHENTICATED: {
    statusCode: HttpStatus.UNAUTHORIZED,
    message: 'Authentication required',
  },
  ACCOUNT_DISABLED: {
    statusCode: HttpStatus.FORBIDDEN,
    message: 'Account disabled',
  },
  ACCOUNT_DELETION_PENDING: {
    statusCode: HttpStatus.FORBIDDEN,
    message: 'Account deletion is pending',
  },
  ACCOUNT_RECOVERY_EXPIRED: {
    statusCode: HttpStatus.GONE,
    message: 'The account recovery period has ended',
  },
  PROFILE_SYNC_REQUIRED: {
    statusCode: HttpStatus.CONFLICT,
    message: 'Profile synchronization required',
  },
  DEVICE_REPORT_CONFLICT: {
    statusCode: HttpStatus.CONFLICT,
    message: 'Device report conflict',
  },
  RATE_LIMITED: {
    statusCode: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Too many requests',
  },
  SERVICE_UNAVAILABLE: {
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Service unavailable',
  },
  EMAIL_VERIFICATION_REQUIRED: {
    statusCode: HttpStatus.FORBIDDEN,
    message: 'Email verification required',
  },
  APP_UPDATE_REQUIRED: {
    statusCode: HttpStatus.FORBIDDEN,
    message: 'Application update required',
  },
  DEVICE_SYNC_REQUIRED: {
    statusCode: HttpStatus.CONFLICT,
    message: 'Device synchronization required',
  },
} as const;

export type AuthErrorCode = keyof typeof authErrors;

export function authError(code: AuthErrorCode): HttpException {
  const definition = authErrors[code];
  return new HttpException(
    { statusCode: definition.statusCode, code, message: definition.message },
    definition.statusCode,
  );
}
