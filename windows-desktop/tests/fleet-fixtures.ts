import { randomUUID } from "node:crypto";
import type {
  FleetEnrollmentRecord,
  LegacyFleetPreparedIdentity,
} from "../src/main/fleet/store.js";
import type { AccountView } from "../src/shared/account-contracts.js";
export const fleetSid = "S-1-5-21-100-200-300-1001";
export const fleetOrigin = "https://workers.example.invalid";
export const fleetNow = Date.parse("2026-10-09T10:00:00.000Z");
export function prepared(): LegacyFleetPreparedIdentity {
  return {
    bootIdentity: "e".repeat(64),
    release: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    archiveDigest: "a".repeat(64),
    modelDigest: "c".repeat(64),
    fixtureDigest: "d".repeat(64),
    gpu: {
      source: "DXGI EnumAdapters1/GetDesc1",
      deviceIndex: 2,
      name: "Fixture GPU",
      vendorId: 4098,
      deviceId: 29631,
      subsystemId: 1,
      revision: 1,
      driverVersion: "32.0.1.2",
      luid: "0000000000001234",
      dedicatedVideoMemoryBytes: 8 * 1024 ** 3,
      sharedSystemMemoryLimitBytes: 4 * 1024 ** 3,
    },
    qualificationPath: null,
    output: {
      path: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal\\prepare\\work\\output.mp3",
      bytes: 100,
      sha256: "e".repeat(64),
    },
    report: {
      label: "MusicMute Windows",
      hardware: {
        os: "Windows",
        osBuild: "10.0.19045",
        architecture: "x86_64",
        cpu: "Fixture CPU",
        memoryBytes: 16 * 1024 ** 3,
        gpus: [
          {
            id: "dxgi-0000000000001234",
            name: "Fixture GPU",
            driverVersion: "32.0.1.2",
            memoryBytes: 8 * 1024 ** 3,
          },
        ],
      },
      runtime: {
        installationProfile: "windows-user",
        workerVersion: "0.1.3",
        protocolVersion: 1,
        manifestDigest: "b".repeat(64),
        modelDigest: "c".repeat(64),
        providerRuntimeVersion: "onnxruntime 1.24.4",
      },
      capabilities: [
        {
          platform: "windows-amd64",
          provider: "directml",
          gpuId: "dxgi-0000000000001234",
          recipeIds: ["kim-vocals-v2"],
          maxSlots: 1,
        },
      ],
      summary: "fixture qualification",
    },
  };
}
export function record(
  phase: FleetEnrollmentRecord["phase"] = "complete",
): FleetEnrollmentRecord & { prepared: LegacyFleetPreparedIdentity } {
  const installed = phase !== "invitation",
    reported = ["reported", "activated", "complete", "revoked"].includes(phase),
    activated = ["activated", "complete", "revoked"].includes(phase),
    p = prepared();
  if (!["invitation", "exchanged"].includes(phase))
    p.qualificationPath =
      "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal\\prepare\\approved\\qualification.json";
  return {
    version: 1,
    sid: fleetSid,
    ownerUid: "fixture-user",
    backendOrigin: fleetOrigin,
    label: p.report.label,
    onboardingRevision: 1,
    phase,
    prepared: p,
    requests: {
      exchange: randomUUID(),
      upload: randomUUID(),
      confirm: randomUUID(),
      report: randomUUID(),
      activate: randomUUID(),
    },
    enrollmentCredential: "e".repeat(43),
    invitationExpiresAt: new Date(fleetNow + 900000).toISOString(),
    installationId: installed ? "6b9c4c74-7e0d-4cbd-9f04-2d5ce37019a7" : null,
    installationCredential: installed ? "i".repeat(43) : null,
    machineCredential: "m".repeat(43),
    workerId: randomUUID(),
    reportRevision: reported ? 1 : null,
    machineId: activated ? "2a956a35-95d1-4417-9157-fc0189ef67c5" : null,
    credentialRevision: activated ? 1 : null,
  };
}
export function accountView(): AccountView {
  return {
    state: "signed-in",
    busy: false,
    online: true,
    googleSignInActive: true,
    user: {
      id: "id",
      displayName: "Fixture",
      email: "fixture@example.invalid",
      emailVerified: true,
      providers: ["google.com"],
      workerRegistrationAllowed: true,
    },
    devices: [],
    nextDeviceCursor: null,
    recovery: null,
    minimumBuild: null,
    access: { allowed: true, reason: null },
    verificationCooldownSeconds: 0,
    resetCooldownSeconds: 0,
    errorCode: null,
    noticeCode: null,
  };
}
export function token(
  authTime = Math.floor(fleetNow / 1000),
  provider = "google.com",
  uid = "fixture-user",
): string {
  return `e30.${Buffer.from(JSON.stringify({ sub: uid, auth_time: authTime, firebase: { sign_in_provider: provider } })).toString("base64url")}.signature`;
}
