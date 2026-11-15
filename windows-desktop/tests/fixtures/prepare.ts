import { MODEL } from "../../../chrome-extension/src/shared/local-model.js";
import { PREPARATION_FIXTURE } from "../../src/main/prepare/fixture.js";
export const sid = "S-1-5-21-1-2-3-1001",
  target = { sid, identity: "a".repeat(64) };
export const bootIdentity = "e".repeat(64);
export const gpu = {
  source: "DXGI EnumAdapters1/GetDesc1" as const,
  deviceIndex: 3,
  name: "Intel Iris Xe",
  vendorId: 32902,
  deviceId: 1234,
  subsystemId: 5678,
  revision: 1,
  driverVersion: "32.0.1.1",
  luid: "0000000000000042",
  dedicatedVideoMemoryBytes: 0,
  sharedSystemMemoryLimitBytes: 8000000000,
};
export function receipt() {
  const qualification = {
    schemaVersion: 1,
    status: "PASS",
    platform: "windows-amd64",
    provider: "directml",
    runtimeProfile: "windows-user",
    serviceIdentity: sid,
    gpuId: `dxgi-${gpu.luid}`,
    directmlDeviceId: gpu.deviceIndex,
    gpuIdentity: gpu,
    gpuOnlyPolicy: "onnxruntime-disable-cpu-fallback-v1",
    resourceObservations: {
      inferenceSlots: 1,
      dedicatedVideoMemoryLimitBytes: 0,
      sharedSystemMemoryLimitBytes: 8000000000,
    },
    releaseManifestDigest: "b".repeat(64),
    modelDigest: MODEL.sha256,
    fixtureDigest: PREPARATION_FIXTURE.sha256,
    providerDispatch: {
      expectedProvider: "DmlExecutionProvider",
      profileCount: 1,
      acceleratedNodeEvents: 6,
      cpuNodeEvents: 0,
      proven: true,
    },
    recipes: ["kim-vocals-v2", "kim-vocals-v2-trim"].map((recipeId, index) => ({
      recipeId,
      recipeDigest: String(index).repeat(64),
      resultDigest: String(index + 4).repeat(64),
      resultBytes: 10000 + index,
      sourceDurationSeconds: 6,
      outputDurationSeconds: 5.5,
      endToEndSeconds: 2 + index,
    })),
    uploadCandidate: {
      path: "C:\\Users\\Fixture\\AppData\\Local\\MusicMuteLocal\\prepare\\work\\qualification.mp3",
      resultDigest: "4".repeat(64),
      resultBytes: 10000,
      contentType: "audio/mpeg",
    },
    totalSeconds: 20,
    runtimeDiagnostics: {
      status: "ok",
      platform: "win32",
      architecture: "x64",
      python: "3.12.10",
      onnxRuntime: "1.24.4",
      audioSeparator: "0.47.0",
      provider: "DmlExecutionProvider",
      modelSha256: MODEL.sha256,
      modelBytes: MODEL.bytes,
      ffmpeg: "ffmpeg version 8.0.3 MusicMute",
      ffprobe: "ffprobe version 8.0.3 MusicMute",
      modelPath:
        "C:\\Users\\Fixture\\AppData\\Local\\MusicMuteLocal\\models\\Kim_Vocal_2.onnx",
    },
  };
  return {
    version: 2,
    bootIdentity,
    sid,
    target: target.identity,
    release: target.identity,
    sequence: 1,
    manifestSha256: "b".repeat(64),
    modelSha256: MODEL.sha256,
    fixtureSha256: PREPARATION_FIXTURE.sha256,
    modelFingerprint: {
      device: "1",
      fileId: "42",
      bytes: MODEL.bytes,
      writtenAt: "1234",
      changedAt: "1234",
    },
    qualification,
    activatedAt: "2026-10-09T00:00:00.000Z",
  };
}
