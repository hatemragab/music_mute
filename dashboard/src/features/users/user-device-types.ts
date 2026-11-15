export interface AdminUserDeviceLocation {
  country: string | null;
  continent: string | null;
  region: string | null;
  regionCode: string | null;
  city: string | null;
  postalCode: string | null;
  metroCode: string | null;
  timezone: string | null;
  latitude: string | null;
  longitude: string | null;
  source: "cloudflare";
  observedAt: string;
}

export interface AdminUserDevice {
  installationId: string;
  platform: "android" | "ios" | "macos" | "windows" | "web";
  deviceModel: string | null;
  osVersion: string;
  appVersion: string;
  buildNumber: number;
  metadataRevision: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAuthenticatedAt: string | null;
  historyHiddenAt: string | null;
  sessionStatus: "signed_out" | "unknown";
  location: AdminUserDeviceLocation | null;
  versionHistory: Array<{
    appVersion: string;
    buildNumber: number;
    metadataRevision: number;
    observedAt: string;
  }>;
}

export interface AdminUserDevicePage {
  items: AdminUserDevice[];
  nextCursor: string | null;
  asOf: string;
}
