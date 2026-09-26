export type SupportedProvider = 'password' | 'google.com' | 'apple.com';
export type Platform = 'android' | 'ios';
export type ClientPlatform = Platform | 'web';

export interface VerifiedIdentity {
  uid: string;
  authTimeSec: number;
  provider: SupportedProvider;
  tokenEmailVerified: boolean;
}

export interface DeviceReport {
  installationId: string;
  platform: ClientPlatform;
  appVersion: string;
  buildNumber: number;
  metadataRevision: number;
  osVersion: string;
  deviceModel?: string;
}

export interface RateBucket {
  key: string;
  limit: number;
  windowMs: number;
}

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export type ProcessingDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'EMAIL_VERIFICATION_REQUIRED'
        | 'APP_UPDATE_REQUIRED'
        | 'DEVICE_SYNC_REQUIRED';
    };
