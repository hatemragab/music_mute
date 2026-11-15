import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { verifyAdvancedCandidate } from "../src/main/fleet/advanced/candidate.js";
import {
  validateAdvancedBenchmarkReport,
  parseAdvancedBenchmarkConfiguration,
} from "../src/main/fleet/advanced/benchmark-child.js";
import {
  benchmarkConfig,
  consumerRepeatedStored,
  processIdentity,
} from "./fleet-advanced-fixtures.js";
import type { HostContext } from "../src/main/host-context.js";
import type { WindowsReleaseManifest } from "../../worker/src/platform/windows/release-manifest.js";
const mocked = vi.hoisted(() => ({
  manifest: null as WindowsReleaseManifest | null,
}));
vi.mock("../../worker/src/platform/windows/release-manifest.js", () => ({
  verifyWindowsRelease: vi.fn(async () => mocked.manifest),
}));
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.flatMap((x) => x.split("\\"))),
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-approved-candidate-"));
  roots.push(root);
  const release = "a".repeat(64),
    relative = `runtime\\releases\\${release}`,
    path = (value: string) => join(root, ...value.split("\\")),
    contents = [
      {
        path: "app/engine/musicmute_engine/z.py",
        bytes: Buffer.from("z source"),
      },
      {
        path: "app/engine/musicmute_engine/__init__.py",
        bytes: Buffer.from("approved init"),
      },
      {
        path: "app/engine/musicmute_engine/a.py",
        bytes: Buffer.from("a source"),
      },
    ];
  for (const entry of contents) {
    const file = path(`${relative}\\${entry.path.replaceAll("/", "\\")}`);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, entry.bytes);
  }
  const manifest: WindowsReleaseManifest = {
    schemaVersion: 1,
    platform: "win32",
    architecture: "x64",
    releaseVersion: "1.0.0",
    installationProfile: "windows-user",
    entries: contents.map((entry) => ({
      path: entry.path,
      kind: "file",
      bytes: entry.bytes.length,
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    })),
  };
  mocked.manifest = manifest;
  const manifestBytes = Buffer.from(JSON.stringify(manifest)),
    manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  await writeFile(path(`${relative}\\release-manifest.json`), manifestBytes);
  const proof = {
      version: 2,
      dllPolicy: "private-pe-imports-msvc-v3",
      sid: processIdentity.sid,
      release,
      sequence: 2,
      archiveSha256: "b".repeat(64),
      manifestSha256,
    },
    native = {
      ...privateFileNativeFixture(path),
      vaultRead: vi.fn(async () => Buffer.from(JSON.stringify(proof))),
      validatePath: vi.fn(async () => {}),
    };
  const host = {
    personalRoot: root,
    identity: processIdentity,
    native,
  } as unknown as HostContext;
  return { host, root, release, contents, proof, path, relative };
}
it("candidate digest matches sorted Windows Python code_digest path framing and every source pin", async () => {
  const f = await fixture(),
    result = await verifyAdvancedCandidate(
      f.host,
      f.release,
      new AbortController().signal,
    ),
    hash = createHash("sha256");
  for (const entry of [...f.contents].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  ))
    hash
      .update(entry.path.slice("app/engine/".length).replaceAll("/", "\\"))
      .update("\0")
      .update(entry.bytes)
      .update("\0");
  expect(result).toEqual({
    release: f.release,
    manifestSha256: f.proof.manifestSha256,
    engineDigest: hash.digest("hex"),
  });
  expect(f.host.native.validatePath).toHaveBeenCalledWith(
    "personal",
    expect.stringContaining("musicmute_engine\\a.py"),
    "file",
  );
});
it("unapproved/foreign runtime receipt or altered manifest/source cannot supply candidate code", async () => {
  const f = await fixture();
  vi.mocked(f.host.native.vaultRead).mockResolvedValueOnce(null);
  await expect(
    verifyAdvancedCandidate(f.host, f.release, new AbortController().signal),
  ).rejects.toThrow("ADVANCED_CANDIDATE_UNAVAILABLE");
  vi.mocked(f.host.native.vaultRead).mockResolvedValueOnce(
    Buffer.from(JSON.stringify({ ...f.proof, sid: "S-1-5-21-9-8-7-1001" })),
  );
  await expect(
    verifyAdvancedCandidate(f.host, f.release, new AbortController().signal),
  ).rejects.toThrow("ADVANCED_CANDIDATE_INVALID");
  await writeFile(
    f.path(`${f.relative}\\app\\engine\\musicmute_engine\\a.py`),
    "substituted source",
  );
  await expect(
    verifyAdvancedCandidate(f.host, f.release, new AbortController().signal),
  ).rejects.toThrow("ADVANCED_CANDIDATE_INVALID");
});
it("candidate mode/report engine binding, grouped inference and saved audio cannot be silently changed", () => {
  const base = benchmarkConfig(),
    stored = consumerRepeatedStored(),
    candidate = {
      release: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      engineDigest: stored.engineDigest,
    };
  const config = parseAdvancedBenchmarkConfiguration({
    ...base,
    groupSize: 1,
    candidate,
    saveAudio: false,
  });
  expect(
    validateAdvancedBenchmarkReport(
      { ...stored, sourceMode: "candidate-engine" },
      config,
      undefined,
      true,
    ),
  ).toMatchObject({ sourceMode: "candidate-engine" });
  expect(() =>
    validateAdvancedBenchmarkReport(stored, config, undefined, true),
  ).toThrow("ADVANCED_BENCHMARK_INVALID");
  expect(() =>
    validateAdvancedBenchmarkReport(
      {
        ...stored,
        sourceMode: "candidate-engine",
        engineDigest: "c".repeat(64),
      },
      config,
      undefined,
      true,
    ),
  ).toThrow("ADVANCED_BENCHMARK_INVALID");
  expect(() =>
    parseAdvancedBenchmarkConfiguration({ ...base, groupSize: 2 }),
  ).toThrow("ADVANCED_BENCHMARK_CONFIG_INVALID");
  expect(() =>
    validateAdvancedBenchmarkReport(
      stored,
      { ...base, saveAudio: true },
      undefined,
      true,
    ),
  ).toThrow("ADVANCED_BENCHMARK_INVALID");
});
