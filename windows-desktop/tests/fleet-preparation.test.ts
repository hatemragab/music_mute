import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WindowsFleetPreparation } from "../src/main/fleet/preparation.js";
import {
  canonicalUpdateMetadata,
  type UpdateMetadata,
} from "../../worker/src/platform/shared/update-metadata.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { record, prepared, fleetSid } from "./fleet-fixtures.js";
import type { HostContext } from "../src/main/host-context.js";
import type { WindowsPreparationOperations } from "../src/main/prepare/operations.js";
import type { WorkerEnrollmentClient } from "../../worker/src/enrollment/enrollment-client.js";
const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  parse: vi.fn(),
  download: vi.fn(),
  hash: vi.fn(),
  write: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("../../worker/src/enrollment/report-builder.js", async (original) => ({
  ...(await original<object>()),
  createEnrollmentReportFromDiagnostics: mocks.report,
  parseQualificationEvidence: mocks.parse,
}));
vi.mock("../../worker/src/enrollment/artifact-download.js", () => ({
  downloadVerifiedArtifact: mocks.download,
}));
vi.mock("../src/main/prepare/private-files.js", () => ({
  hashPrivateFile: mocks.hash,
  writePrivateAtomic: mocks.write,
}));
vi.mock("../../worker/src/enrollment/qualification-upload.js", () => ({
  uploadQualificationResult: mocks.upload,
}));
function fixture() {
  vi.clearAllMocks();
  const r = record("exchanged"),
    p = prepared();
  r.prepared.modelDigest = MODEL.sha256;
  r.prepared.report.runtime.modelDigest = MODEL.sha256;
  const evidence = {
    runtimeProfile: "windows-user",
    directmlDeviceId: p.gpu.deviceIndex,
    serviceIdentity: fleetSid,
    gpuIdentity: p.gpu,
    platform: "windows-amd64",
    provider: "directml",
    gpuId: `dxgi-${p.gpu.luid}`,
    releaseManifestDigest: p.manifestDigest,
    modelDigest: MODEL.sha256,
    fixtureDigest: "f".repeat(64),
    runtimeDiagnostics: {
      platform: "win32",
      architecture: "x64",
      onnxRuntime: "1.24.4",
      provider: "DmlExecutionProvider",
      modelSha256: MODEL.sha256,
    },
    recipeIds: ["kim-vocals-v2"],
    recipeDigests: { "kim-vocals-v2": "a".repeat(64) },
    uploadCandidate: {
      path: p.output.path,
      resultBytes: p.output.bytes,
      resultDigest: p.output.sha256,
      contentType: "audio/mpeg",
    },
  };
  const ready = {
    bootIdentity: p.bootIdentity!,
    release: p.release,
    archiveSha256: p.archiveDigest,
    releaseVersion: "0.1.3",
    releaseRoot: `C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal\\runtime\\releases\\${p.release}`,
    modelRoot: "C:\\Users\\fixture\\models",
    manifestSha256: p.manifestDigest,
    nativeSha256: "e".repeat(64),
    modelSha256: MODEL.sha256,
    modelFingerprint: {
      device: "1",
      fileId: "2",
      bytes: MODEL.bytes,
      writtenAt: "3",
      changedAt: "4",
    },
    qualification: { fixture: "personal" },
    evidence,
  };
  const operations = {
    snapshotReady: vi.fn(async () => ready),
    qualifyApprovedFixture: vi.fn(async () => ({
      bootIdentity: ready.bootIdentity,
      raw: { fixture: "approved" },
      evidence,
    })),
  } as unknown as Pick<
    WindowsPreparationOperations,
    "snapshotReady" | "qualifyApprovedFixture"
  >;
  const native = {
      validatePath: vi.fn(async () => {}),
      bootIdentity: vi.fn(async () => ready.bootIdentity),
    },
    host = {
      identity: { sid: fleetSid },
      personalRoot: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
      native,
      directory: vi.fn(async () => "private"),
    } as unknown as HostContext;
  const signing = generateKeyPairSync("ed25519"),
    publicKeys = {
      fixture: signing.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
    metadata: UpdateMetadata = {
      schemaVersion: 1,
      sequence: 1,
      platform: "windows-amd64",
      installationProfile: "windows-user",
      releaseVersion: "0.1.3",
      publishedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      release: {
        filename: "consumer.zip",
        bytes: 1000,
        sha256: p.archiveDigest,
        contentType: "application/zip",
      },
    };
  const artifacts = {
    schemaVersion: 1,
    platform: "windows-amd64",
    installationProfile: "windows-user",
    release: {
      ...metadata.release,
      version: "0.1.3",
      url: "https://storage.example.invalid/consumer.zip",
      expiresAt: metadata.expiresAt,
      signed: {
        keyId: "fixture",
        metadata,
        signature: sign(
          null,
          Buffer.from(canonicalUpdateMetadata(metadata)),
          signing.privateKey,
        ).toString("base64url"),
      },
    },
    model: {
      filename: MODEL.filename,
      bytes: MODEL.bytes,
      sha256: MODEL.sha256 as string,
      contentType: "application/octet-stream",
      url: MODEL.url,
      sourcePolicy: "direct-owner-source-only",
      allowedHosts: [],
      maxRedirects: 0,
    },
    fixture: {
      filename: "approved.wav",
      bytes: 100,
      sha256: evidence.fixtureDigest,
      contentType: "audio/wav",
      url: "https://storage.example.invalid/approved.wav",
      expiresAt: metadata.expiresAt,
    },
  };
  const client = {
    artifacts: vi.fn(async () => artifacts),
  } as unknown as WorkerEnrollmentClient;
  mocks.parse.mockReturnValue(evidence);
  mocks.report.mockResolvedValue(r.prepared.report);
  mocks.hash.mockImplementation(async (_host: unknown, relative: string) =>
    relative.includes("approved\\") ? evidence.fixtureDigest : p.output.sha256,
  );
  mocks.download.mockResolvedValue({
    path: "fixture",
    bytes: 100,
    sha256: evidence.fixtureDigest,
    reused: false,
  });
  mocks.upload.mockResolvedValue({ confirmed: true });
  return {
    port: new WindowsFleetPreparation(host, operations, { publicKeys }),
    r,
    ready,
    client,
    artifacts,
    operations,
    host,
    evidence,
  };
}
describe("approved Windows enrollment qualification pipeline", () => {
  it("binds signed consumer archive and approved fixture before qualification/report", async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    const result = await f.port.qualify(f.r, f.client, signal);
    expect(f.client.artifacts).toHaveBeenCalledWith(
      f.r.installationId,
      f.r.installationCredential,
      "windows-amd64",
      signal,
      "windows-user",
    );
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: f.artifacts.fixture.url,
        expectedBytes: 100,
        expectedSha256: f.evidence.fixtureDigest,
        expectedContentType: "audio/wav",
      }),
    );
    expect(f.operations.qualifyApprovedFixture).toHaveBeenCalledWith(
      {
        relativePath: `prepare\\approved\\${f.evidence.fixtureDigest}.wav`,
        bytes: 100,
        sha256: f.evidence.fixtureDigest,
      },
      signal,
    );
    expect(mocks.report).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUserSid: fleetSid,
        expectedFixtureDigest: f.evidence.fixtureDigest,
        runtimeProfile: "windows-user",
        qualification: { fixture: "approved" },
      }),
    );
    expect(result.fixtureDigest).toBe(f.evidence.fixtureDigest);
    expect(result.qualificationPath).toMatch(
      /qualification-[a-f0-9]{64}\.json$/,
    );
  });
  it.each(["signature", "archive", "model", "oversized-fixture"])(
    "fails closed for %s before downloading or running",
    async (reason) => {
      const f = fixture();
      if (reason === "signature")
        f.artifacts.release.signed.signature = "A".repeat(86);
      if (reason === "archive") f.r.prepared.archiveDigest = "9".repeat(64);
      if (reason === "model") f.artifacts.model.sha256 = "9".repeat(64);
      if (reason === "oversized-fixture")
        f.artifacts.fixture.bytes = 64 * 1024 ** 2 + 1;
      await expect(
        f.port.qualify(f.r, f.client, new AbortController().signal),
      ).rejects.toThrow();
      expect(mocks.download).not.toHaveBeenCalled();
      expect(f.operations.qualifyApprovedFixture).not.toHaveBeenCalled();
    },
  );
  it("refuses changed physical GPU/driver after approved fixture execution", async () => {
    const f = fixture();
    mocks.parse.mockReturnValue({
      ...f.evidence,
      gpuIdentity: { ...f.evidence.gpuIdentity, driverVersion: "33.0.1.2" },
    });
    await expect(
      f.port.qualify(f.r, f.client, new AbortController().signal),
    ).rejects.toThrow();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("checks private output identity before requesting a backend upload grant", async () => {
    const f = fixture();
    mocks.hash.mockResolvedValue("0".repeat(64));
    await expect(
      f.port.upload(f.r, f.client, new AbortController().signal),
    ).rejects.toThrow("FLEET_QUALIFICATION_REJECTED");
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
