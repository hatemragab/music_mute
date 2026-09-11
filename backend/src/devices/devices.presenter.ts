import type { DeviceDocument } from './device.schema.js';

export function presentDevice(device: DeviceDocument) {
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
    versionHistory: device.versionHistory.map((entry) => ({
      appVersion: entry.appVersion,
      buildNumber: entry.buildNumber,
      metadataRevision: entry.metadataRevision,
      observedAt: entry.observedAt,
    })),
  };
}
