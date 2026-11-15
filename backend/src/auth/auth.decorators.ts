import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = Symbol('PUBLIC_ROUTE');
export const ALLOW_UNPROVISIONED = Symbol('ALLOW_UNPROVISIONED');
export const AUTH_OPERATION = Symbol('AUTH_OPERATION');
export const PROCESSING_ACCESS = Symbol('PROCESSING_ACCESS');
export const ACCOUNT_DELETION = Symbol('ACCOUNT_DELETION');
export const ACCOUNT_RECOVERY = Symbol('ACCOUNT_RECOVERY');
export const AllowDeletionRetry = () => SetMetadata(ACCOUNT_DELETION, true);
export const AllowAccountRecovery = () => SetMetadata(ACCOUNT_RECOVERY, true);
export type AuthOperation =
  | 'profile'
  | 'device'
  | 'logout'
  | 'account-deletion'
  | 'account-recovery'
  | 'processing-read'
  | 'processing-create'
  | 'processing-upload-grant'
  | 'processing-upload-confirm'
  | 'processing-download'
  | 'processing-retry'
  | 'processing-cancel'
  | 'processing-mutation';
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const AllowUnprovisioned = () => SetMetadata(ALLOW_UNPROVISIONED, true);
export const LimitOperation = (operation: AuthOperation) =>
  SetMetadata(AUTH_OPERATION, operation);
export const RequireProcessingAccess = () =>
  SetMetadata(PROCESSING_ACCESS, true);
