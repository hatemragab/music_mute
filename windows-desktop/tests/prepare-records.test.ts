import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalUpdateMetadata } from "../../worker/src/platform/shared/update-metadata.js";
import {
  loadPreparationBundle,
  preparationTargetIdentity,
} from "../src/main/prepare/bundle.js";
import {
  parsePreparationChildConfig,
  runPreparationChild,
} from "../src/agent/prepare.js";
import {
  parseReadyReceipt,
  parseRuntimeProof,
  WindowsPreparationOperations,
} from "../src/main/prepare/operations.js";
import {
  PREPARATION_FIXTURE,
  preparationFixture,
} from "../src/main/prepare/fixture.js";
import { assertApprovedPreparationFixture } from "../src/main/prepare/qualification-runner.js";
import type { HostContext } from "../src/main/host-context.js";
import type { PreparationBundle } from "../src/main/prepare/bundle.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
import { sid, gpu, receipt } from "./fixtures/prepare.js";
const target = { sid, identity: "a".repeat(64) };
it("binds readiness to user, model, runtime, fixture and proven DirectML dispatch", () => {
  const value = receipt();
  expect(
    parseReadyReceipt(value, target).evidence.gpuIdentity?.deviceIndex,
  ).toBe(3);
  for (const invalid of [
    { ...value, sid: "S-1-12-1-1-2-3-4" },
    { ...value, target: "c".repeat(64) },
    { ...value, modelSha256: "d".repeat(64) },
    { ...value, fixtureSha256: "e".repeat(64) },
    { ...value, manifestSha256: "f".repeat(64) },
    { ...value, modelFingerprint: { ...value.modelFingerprint, bytes: 1 } },
    {
      ...value,
      qualification: {
        ...value.qualification,
        providerDispatch: {
          ...value.qualification.providerDispatch,
          cpuNodeEvents: 1,
        },
      },
    },
  ])
    expect(() => parseReadyReceipt(invalid, target)).toThrow();
  expect(() => parseReadyReceipt(value, target, "f".repeat(64))).toThrow(
    "INTEGRITY_INVALID",
  );
  const { bootIdentity: _boot, ...legacy } = value;
  expect(() => parseReadyReceipt({ ...legacy, version: 1 }, target)).toThrow(
    "INTEGRITY_INVALID",
  );
  expect(() =>
    parseReadyReceipt({ ...value, bootIdentity: "old" }, target),
  ).toThrow("INTEGRITY_INVALID");
});
it("retains exact prior installation for offline requalification after reboot without granting old GPU readiness", async () => {
  const prior = receipt(),
    host = {
      identity: { sid },
      native: {
        vaultRead: async (_namespace: string, key: string) =>
          key === "ready_receipt" ? Buffer.from(JSON.stringify(prior)) : null,
        bootIdentity: async () => "f".repeat(64),
      },
    } as unknown as HostContext,
    loader = vi.fn(
      async () =>
        ({
          targetIdentity: target.identity,
          metadata: { sequence: 1 },
          archivePath: "fixture.zip",
          allowNetwork: false,
        }) as unknown as PreparationBundle,
    ),
    operations = new WindowsPreparationOperations(
      host,
      "fixture-resources",
      async () => true,
      loader,
    );
  const signal = new AbortController().signal;
  expect(await operations.target(signal)).toEqual(target);
  expect(loader).toHaveBeenCalledWith(1, prior);
  expect(await operations.cachedReady(target, signal)).toBe(false);
});
it("ties reusable runtime proof to signed archive, SID, sequence and release", () => {
  const expected = {
      sid,
      release: target.identity,
      archiveSha256: "c".repeat(64),
      sequence: 2,
    },
    proof = {
      version: 2,
      dllPolicy: "private-pe-imports-msvc-v3",
      ...expected,
      manifestSha256: "b".repeat(64),
    };
  expect(parseRuntimeProof(proof, expected)).toEqual(proof);
  expect(() => parseRuntimeProof({ ...proof, version: 1 }, expected)).toThrow();
  for (const dllPolicy of [
    "private-pe-imports-msvc-v1",
    "private-pe-imports-msvc-v2",
  ])
    expect(() =>
      parseRuntimeProof({ ...proof, dllPolicy }, expected),
    ).toThrow();
  const { dllPolicy: _policy, ...unbound } = proof;
  expect(() => parseRuntimeProof(unbound, expected)).toThrow();
  expect(() =>
    parseRuntimeProof({ ...proof, dllPolicy: "unknown" }, expected),
  ).toThrow();
  for (const field of ["sid", "release", "archiveSha256", "sequence"] as const)
    expect(() =>
      parseRuntimeProof(
        { ...proof, [field]: field === "sequence" ? 1 : "tampered" },
        expected,
      ),
    ).toThrow();
});
it("signs a consumer artifact with a trusted key and rejects tampering, expiry, rollback and the service profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-prepare-bundle-"));
  roots.push(root);
  await mkdir(join(root, "runtime"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await writeFile(
    join(root, "runtime-public-keys.json"),
    JSON.stringify({
      release: publicKey.export({ type: "spki", format: "pem" }),
    }),
  );
  const metadata = {
    schemaVersion: 1 as const,
    installationProfile: "windows-user" as const,
    sequence: 2,
    platform: "windows-amd64" as const,
    releaseVersion: "0.1.0",
    publishedAt: "2026-10-08T00:00:00Z",
    expiresAt: "2026-11-08T00:00:00Z",
    release: {
      filename: "runtime.zip",
      bytes: 123,
      sha256: "f".repeat(64),
      contentType: "application/zip" as const,
    },
  };
  const write = async (value: unknown) =>
    writeFile(
      join(root, "runtime", "runtime-metadata.json"),
      JSON.stringify(value),
    );
  const envelope = {
    keyId: "release",
    metadata,
    signature: sign(
      null,
      Buffer.from(canonicalUpdateMetadata(metadata)),
      privateKey,
    ).toString("base64url"),
  };
  await write(envelope);
  expect(
    (await loadPreparationBundle(root, 2, new Date("2026-10-09"))).archivePath,
  ).toBe(join(root, "runtime", "runtime.zip"));
  await expect(
    loadPreparationBundle(root, 3, new Date("2026-10-09")),
  ).rejects.toThrow("INTEGRITY_INVALID");
  await expect(
    loadPreparationBundle(root, 2, new Date("2026-12-09")),
  ).rejects.toThrow("INTEGRITY_INVALID");
  const activation = {
    target: preparationTargetIdentity(metadata),
    sequence: metadata.sequence,
    activatedAt: "2026-10-09T00:00:00Z",
  };
  expect(
    (await loadPreparationBundle(root, 2, new Date("2026-12-09"), activation))
      .targetIdentity,
  ).toBe(activation.target);
  for (const invalid of [
    { ...activation, target: "a".repeat(64) },
    { ...activation, sequence: 3 },
    { ...activation, activatedAt: "2026-12-10T00:00:00Z" },
    { ...activation, activatedAt: "2026-11-09T00:00:00Z" },
  ])
    await expect(
      loadPreparationBundle(root, 2, new Date("2026-12-09"), invalid),
    ).rejects.toThrow("INTEGRITY_INVALID");
  await expect(
    loadPreparationBundle(root, 3, new Date("2026-12-09"), activation),
  ).rejects.toThrow("INTEGRITY_INVALID");
  await write({
    ...envelope,
    metadata: { ...metadata, installationProfile: undefined },
  });
  await expect(
    loadPreparationBundle(root, 2, new Date("2026-10-09")),
  ).rejects.toThrow("INTEGRITY_INVALID");
  await expect(
    loadPreparationBundle(root, 2, new Date("2026-12-09"), activation),
  ).rejects.toThrow("INTEGRITY_INVALID");
});
it("produces bounded synthetic PCM independent of account grants and rejects arbitrary approved fixture paths", () => {
  const bytes = preparationFixture();
  expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
  expect(bytes.readUInt32LE(40)).toBe(44100 * 6 * 4);
  expect(bytes.readUInt16LE(22)).toBe(2);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    PREPARATION_FIXTURE.sha256,
  );
  const approved = {
    relativePath: `prepare\\approved\\${"b".repeat(64)}.wav`,
    sha256: "b".repeat(64),
    bytes: 1000,
  };
  assertApprovedPreparationFixture(approved);
  for (const invalid of [
    { ...approved, relativePath: "C:\\secret.wav" },
    { ...approved, relativePath: "prepare\\approved\\..\\other.wav" },
    { ...approved, bytes: 1 },
    { ...approved, bytes: 65 * 1024 ** 2 },
  ])
    expect(() => assertApprovedPreparationFixture(invalid)).toThrow();
});
it("strictly bounds preparation child configuration and rejects standalone/non-Windows execution", async () => {
  const config = {
    version: 1,
    operation: "qualify",
    requestId: "00000000-0000-4000-8000-000000000001",
    release: target.identity,
    sid,
    manifestSha256: "b".repeat(64),
    helperSha256: "c".repeat(64),
    gpu,
  };
  expect(parsePreparationChildConfig(config)).toEqual(config);
  for (const invalid of [
    { ...config, sid: "S-1-5-19" },
    { ...config, operation: "shell" },
    { ...config, release: ".." },
    { ...config, argv: ["whoami"] },
  ])
    expect(() => parsePreparationChildConfig(invalid)).toThrow();
  await expect(runPreparationChild([])).rejects.toThrow(
    "PREPARE_CONTEXT_INVALID",
  );
});
