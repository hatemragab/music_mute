import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { PREPARATION_FIXTURE } from "../src/main/prepare/fixture.js";
import type { PersonalAgentConfiguration } from "../src/main/personal/configuration.js";
import type { DirectmlGpuIdentity } from "../../worker/src/enrollment/report-builder.js";
export const personalGpu: DirectmlGpuIdentity = {
  source: "DXGI EnumAdapters1/GetDesc1",
  deviceIndex: 3,
  name: "Fixture GPU",
  vendorId: 4098,
  deviceId: 1,
  subsystemId: 1,
  revision: 1,
  driverVersion: "1.2.3.4",
  luid: "0000000000001234",
  dedicatedVideoMemoryBytes: 8 * 1024 ** 3,
  sharedSystemMemoryLimitBytes: 4 * 1024 ** 3,
};
export const personalPeer = {
  sid: "S-1-5-21-100-200-300-1001",
  sessionId: 1,
  pid: 100,
  creationTime: "10000",
};
export function personalConfiguration(): PersonalAgentConfiguration {
  const root = "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
    release = "a".repeat(64),
    manifest = "b".repeat(64);
  return {
    version: 1,
    kind: "personal",
    installationProfile: "windows-user",
    release,
    releaseRoot: `${root}\\runtime\\releases\\${release}`,
    nativeSha256: "c".repeat(64),
    personalRoot: root,
    sid: personalPeer.sid,
    manifestSha256: manifest,
    bootIdentity: "e".repeat(64),
    modelFingerprint: {
      device: "1",
      fileId: "2",
      bytes: MODEL.bytes,
      writtenAt: "3",
      changedAt: "4",
    },
    controlPeer: personalPeer,
    admissionPeer: { ...personalPeer, pid: 101 },
    eventsPeer: { ...personalPeer, pid: 102 },
    qualification: {
      schemaVersion: 1,
      status: "PASS",
      platform: "windows-amd64",
      provider: "directml",
      gpuId: `dxgi-${personalGpu.luid}`,
      directmlDeviceId: 3,
      serviceIdentity: personalPeer.sid,
      runtimeProfile: "windows-user",
      gpuIdentity: personalGpu,
      gpuOnlyPolicy: "onnxruntime-disable-cpu-fallback-v1",
      resourceObservations: {
        inferenceSlots: 1,
        dedicatedVideoMemoryLimitBytes: personalGpu.dedicatedVideoMemoryBytes,
        sharedSystemMemoryLimitBytes: personalGpu.sharedSystemMemoryLimitBytes,
      },
      releaseManifestDigest: manifest,
      modelDigest: MODEL.sha256,
      fixtureDigest: PREPARATION_FIXTURE.sha256,
      providerDispatch: {
        expectedProvider: "DmlExecutionProvider",
        profileCount: 1,
        acceleratedNodeEvents: 6,
        cpuNodeEvents: 0,
        proven: true,
      },
      recipes: ["kim-vocals-v2", "kim-vocals-v2-trim"].map(
        (recipeId, index) => ({
          recipeId,
          recipeDigest: String(index).repeat(64),
          resultDigest: String(index + 4).repeat(64),
          resultBytes: 10000 + index,
          sourceDurationSeconds: 6,
          outputDurationSeconds: 5.5,
          endToEndSeconds: 2 + index,
        }),
      ),
      uploadCandidate: {
        path: `${root}\\prepare\\output.mp3`,
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
        modelPath: `${root}\\models\\${MODEL.filename}`,
      },
    },
  };
}
