import type { DeviceDocument } from './device.schema.js';

export function presentDevice(
  device: DeviceDocument,
  sessionStatus: 'signed_out' | 'unknown' = 'unknown',
) {
  return {
    installationId: device.installationId,
    platform: device.platform,
    appVersion: device.appVersion,
    buildNumber: device.buildNumber,
    metadataRevision: device.metadataRevision,
    osVersion: device.osVersion,
    deviceModel: device.deviceModel,
    firstSeenAt: device.firstSeenAt,
    lastSeenAt: device.lastSeenAt,
    location: device.location
      ? {
          country: device.location.country,
          continent: device.location.continent,
          region: device.location.region,
          regionCode: device.location.regionCode,
          city: device.location.city,
          postalCode: device.location.postalCode,
          metroCode: device.location.metroCode,
          timezone: device.location.timezone,
          latitude: device.location.latitude,
          longitude: device.location.longitude,
          source: device.location.source,
          observedAt: device.location.observedAt,
        }
      : null,
    sessionStatus,
    versionHistory: device.versionHistory.map((entry) => ({
      appVersion: entry.appVersion,
      buildNumber: entry.buildNumber,
      metadataRevision: entry.metadataRevision,
      observedAt: entry.observedAt,
    })),
  };
}
