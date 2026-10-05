import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const run = promisify(execFile);

type RuntimeFile = {
  path: string;
  type: "file" | "symlink";
  bytes?: number;
  sha256?: string;
  executable?: boolean;
  code_signed?: boolean;
  link_target?: string;
};

type RuntimeArtifactModule = {
  assertRuntimeArchiveListing(listing: string, files: RuntimeFile[]): void;
  macosSteadyStateBytes(options: {
    appBytes: number;
    runtimeInstalledBytes: number;
  }): {
    scope: string;
    app: number;
    runtime: number;
    model: number;
    total: number;
    runtime_releases: number;
  };
  macosSetupMetadata(model: {
    filename: string;
    bytes: number;
    sha256: string;
  }): {
    schema_version: number;
    model: { filename: string; bytes: number; sha256: string };
  };
  collectRuntimeInventory(
    releaseRoot: string,
  ): Promise<{ files: RuntimeFile[]; installedBytes: number }>;
  createMacRuntimeArtifact(options: {
    releaseRoot: string;
    outputDirectory: string;
    downloadBaseURL: string;
    redirectHosts?: string;
    sourceVersion: string;
    signing: {
      release: boolean;
      identity: string;
      signing: string;
      teamIdentifier?: string;
    };
    signatureVerifier?: (
      path: string,
      signing: { mode: string; team_id?: string },
    ) => Promise<void>;
  }): Promise<{
    id: string;
    api_version: number;
    source_version: string;
    archive: string;
    archive_bytes: number;
    archive_sha256: string;
    installed_bytes: number;
    manifest: string;
    manifest_sha256: string;
    url: string;
    files: number;
    native_binaries: number;
    reused: boolean;
    signing: { mode: string; team_id?: string };
  }>;
  reuseMacRuntimeArtifact(options: {
    packageResultPath: string;
    outputDirectory: string;
    sourceVersion: string;
    signing: {
      release: boolean;
      identity: string;
      signing: string;
      teamIdentifier?: string;
    };
    downloadConfiguration?: {
      baseURL?: URL;
      downloadHosts?: string[];
      redirectHosts?: string;
    };
    signatureVerifier?: (
      path: string,
      signing: { mode: string; team_id?: string },
    ) => Promise<void>;
  }): Promise<{
    id: string;
    api_version: number;
    source_version: string;
    archive: string;
    archive_bytes: number;
    archive_sha256: string;
    installed_bytes: number;
    manifest: string;
    manifest_sha256: string;
    url: string;
    files: number;
    native_binaries: number;
    reused: boolean;
    reuse_source: {
      package_result: string;
      build_id: string;
      version: string;
      build: string;
    };
    signing: { mode: string; team_id?: string };
  }>;
  runtimeDownloadConfiguration(options: {
    baseURL?: string;
    redirectHosts?: string;
  }): { baseURL: URL; downloadHosts: string[] };
  runtimeSigningManifest(signing: {
    release: boolean;
    identity: string;
    signing: string;
    teamIdentifier?: string;
  }): { mode: string; team_id?: string };
  verifyRuntimeCodeSignature(
    path: string,
    signing: { mode: string; team_id?: string },
    options: {
      exec: (
        file: string,
        args: string[],
        options: Record<string, unknown>,
      ) => Promise<{ stdout: string; stderr: string }>;
    },
  ): Promise<void>;
};

const moduleURL = new URL(
  "../scripts/macos-runtime-artifact.mjs",
  import.meta.url,
).href;
const runtimeArtifact = (await import(moduleURL)) as RuntimeArtifactModule;
const roots: string[] = [];
const sourceVersion = "0.1.0";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ root: string; release: string }> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "musicmute-runtime-artifact-")),
  );
  roots.push(root);
  const release = join(root, "release");
  await mkdir(release, { mode: 0o700 });
  const paths = [
    "runtime/runtime/node/bin/node",
    "runtime/runtime/python/bin/python3",
    "runtime/runtime/bin/ffmpeg",
    "runtime/runtime/bin/ffprobe",
    "runtime/tools/youtube/bin/deno",
  ];
  const header = Buffer.from("cffaedfe", "hex");
  for (const path of paths) {
    const destination = join(release, path);
    await mkdir(join(destination, ".."), { recursive: true, mode: 0o755 });
    await writeFile(destination, Buffer.concat([header, Buffer.from(path)]), {
      mode: 0o755,
    });
  }
  const library = join(release, "runtime/runtime/python/libexample.dylib");
  const byteSwappedFat64Header = Buffer.from("bfbafeca", "hex");
  await writeFile(
    library,
    Buffer.concat([byteSwappedFat64Header, Buffer.from("library")]),
    {
      mode: 0o644,
    },
  );
  await writeFile(join(release, "runtime/NOTICE.txt"), "notice\n", {
    mode: 0o644,
  });
  await writeFile(join(release, "runtime/.runtime-policy"), "hidden policy\n", {
    mode: 0o644,
  });
  await mkdir(join(release, "runtime/unused/empty"), {
    recursive: true,
    mode: 0o755,
  });
  await symlink("node", join(release, "runtime/runtime/node/bin/node-link"));
  await symlink("bin", join(release, "runtime/runtime/node/bin-current"));
  await symlink(
    "bin-current",
    join(release, "runtime/runtime/node/bin-active"),
  );
  return { root, release };
}

async function priorPackageFixture(
  options: { release?: boolean; teamIdentifier?: string } = {},
): Promise<{
  root: string;
  packageRoot: string;
  packageResultPath: string;
  packageDocument: Record<string, unknown> & {
    runtime: Record<string, unknown>;
  };
  artifact: Awaited<
    ReturnType<RuntimeArtifactModule["createMacRuntimeArtifact"]>
  >;
}> {
  const { root, release } = await fixture();
  const releaseSigning = options.release === true;
  const teamIdentifier = options.teamIdentifier ?? "K5UP26B3W8";
  const signing = releaseSigning
    ? {
        release: true,
        identity: "a".repeat(40),
        signing: "DEVELOPER_ID_DISTRIBUTION",
        teamIdentifier,
      }
    : {
        release: false,
        identity: "-",
        signing: "AD_HOC_LOCAL",
      };
  const buildId = "11111111-1111-4111-8111-111111111111";
  const packageRoot = join(root, `build-${buildId}.noindex`);
  await mkdir(packageRoot, { mode: 0o700 });
  const artifact = await runtimeArtifact.createMacRuntimeArtifact({
    releaseRoot: release,
    outputDirectory: join(packageRoot, "runtime-release.noindex"),
    downloadBaseURL: "https://downloads.example.test/musicmute/runtime/",
    redirectHosts: "release-assets.example.test",
    sourceVersion,
    signing,
    signatureVerifier: async () => {},
  });
  const app = join(packageRoot, "MusicMute Local.app");
  const resources = join(app, "Contents/Resources");
  await mkdir(resources, { recursive: true, mode: 0o755 });
  await copyFile(artifact.manifest, join(resources, "runtime-bootstrap.json"));
  const packageDocument: Record<string, unknown> & {
    runtime: Record<string, unknown>;
  } = {
    schema_version: 1,
    build_id: buildId,
    app,
    build_root: packageRoot,
    signing: signing.signing,
    architecture: "arm64",
    release_mode: releaseSigning,
    ...(releaseSigning ? { team_identifier: teamIdentifier } : {}),
    version: "1.2.3.4",
    build: "1",
    runtime: {
      delivery: "EXTERNAL_PREPARE",
      id: artifact.id,
      api_version: artifact.api_version,
      source_version: artifact.source_version,
      reused: false,
      archive: artifact.archive,
      archive_bytes: artifact.archive_bytes,
      archive_sha256: artifact.archive_sha256,
      installed_bytes: artifact.installed_bytes,
      manifest: artifact.manifest,
      manifest_sha256: artifact.manifest_sha256,
      url: artifact.url,
      files: artifact.files,
      native_binaries: artifact.native_binaries,
      ...(releaseSigning
        ? { native_binaries_verified: artifact.native_binaries }
        : {}),
      signing: artifact.signing,
      notarized: false,
      public_ready: false,
    },
  };
  const packageResultPath = join(packageRoot, "package-result.json");
  await writeFile(
    packageResultPath,
    `${JSON.stringify(packageDocument, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    packageRoot,
    packageResultPath,
    packageDocument,
    artifact,
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("macOS external runtime artifact", () => {
  it("records the exact one-app, one-runtime, one-model base footprint", () => {
    expect(
      runtimeArtifact.macosSteadyStateBytes({
        appBytes: 40_000_000,
        runtimeInstalledBytes: 1_300_000_000,
      }),
    ).toEqual({
      scope: "BASE_PROCESSING_ONE_APP_ONE_RUNTIME_ONE_MODEL",
      app: 40_000_000,
      runtime: 1_300_000_000,
      model: 66_759_214,
      total: 1_406_759_214,
      runtime_releases: 1,
    });
    expect(() =>
      runtimeArtifact.macosSteadyStateBytes({
        appBytes: 0,
        runtimeInstalledBytes: 1,
      }),
    ).toThrow("MACOS_STEADY_STATE_BYTES_INVALID");
  });

  it("generates bounded signed-app setup metadata from the packaged model identity", () => {
    const model = {
      filename: "Kim_Vocal_2.onnx",
      bytes: 66_759_214,
      sha256:
        "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
    };
    expect(runtimeArtifact.macosSetupMetadata(model)).toEqual({
      schema_version: 1,
      model,
    });
    expect(() =>
      runtimeArtifact.macosSetupMetadata({ ...model, bytes: model.bytes + 1 }),
    ).toThrow("MACOS_SETUP_MODEL_INVALID");
    expect(() =>
      runtimeArtifact.macosSetupMetadata({
        ...model,
        filename: "../model.onnx",
      }),
    ).toThrow("MACOS_SETUP_MODEL_INVALID");
  });

  it("accepts only credential-free immutable HTTPS download locations", () => {
    expect(
      runtimeArtifact.runtimeDownloadConfiguration({
        baseURL: "https://downloads.example.test/musicmute/runtime",
        redirectHosts: "release-assets.example.test",
      }),
    ).toMatchObject({
      downloadHosts: ["downloads.example.test", "release-assets.example.test"],
    });
    expect(() =>
      runtimeArtifact.runtimeDownloadConfiguration({
        baseURL: "http://downloads.example.test/runtime/",
      }),
    ).toThrow("RUNTIME_DOWNLOAD_BASE_URL_INVALID");
    expect(() =>
      runtimeArtifact.runtimeDownloadConfiguration({
        baseURL: "https://secret@downloads.example.test/runtime/",
      }),
    ).toThrow("RUNTIME_DOWNLOAD_BASE_URL_INVALID");
    expect(() =>
      runtimeArtifact.runtimeDownloadConfiguration({
        baseURL: "https://downloads.example.test/runtime/",
        redirectHosts: "downloads.example.test",
      }),
    ).toThrow("RUNTIME_DOWNLOAD_HOSTS_INVALID");
  });

  it("keeps ad-hoc local and Developer ID release trust modes distinct", () => {
    expect(
      runtimeArtifact.runtimeSigningManifest({
        release: false,
        identity: "-",
        signing: "AD_HOC_LOCAL",
      }),
    ).toEqual({ mode: "ad_hoc" });
    expect(
      runtimeArtifact.runtimeSigningManifest({
        release: true,
        identity: "a".repeat(40),
        signing: "DEVELOPER_ID_DISTRIBUTION",
        teamIdentifier: "K5UP26B3W8",
      }),
    ).toEqual({ mode: "developer_id", team_id: "K5UP26B3W8" });
    expect(() =>
      runtimeArtifact.runtimeSigningManifest({
        release: false,
        identity: "custom",
        signing: "DEVELOPER_ID_LOCAL_NO_NOTARIZATION",
      }),
    ).toThrow("RUNTIME_SIGNING_MODE_UNSUPPORTED");
  });

  it("requires verified hardened signatures in both trust modes", async () => {
    const adHocExec = vi.fn(async (_file: string, args: string[]) => ({
      stdout: "",
      stderr: args.includes("-d")
        ? "Signature=adhoc\nTeamIdentifier=not set\nflags=0x10000(runtime)\n"
        : "",
    }));
    await expect(
      runtimeArtifact.verifyRuntimeCodeSignature(
        "/fixture/node",
        { mode: "ad_hoc" },
        { exec: adHocExec },
      ),
    ).resolves.toBeUndefined();
    expect(adHocExec.mock.calls[0]?.[1]).not.toContain("--test-requirement");
    await expect(
      runtimeArtifact.verifyRuntimeCodeSignature(
        "/fixture/node",
        { mode: "ad_hoc" },
        {
          exec: async () => ({
            stdout: "",
            stderr: "Signature=adhoc\nTeamIdentifier=not set\n",
          }),
        },
      ),
    ).rejects.toThrow("RUNTIME_SIGNATURE_INVALID");

    const developerExec = vi.fn(async (_file: string, _args: string[]) => ({
      stdout: "",
      stderr:
        "Authority=Developer ID Application: MusicMute (K5UP26B3W8)\n" +
        "TeamIdentifier=K5UP26B3W8\nflags=0x10000(runtime)\n",
    }));
    await expect(
      runtimeArtifact.verifyRuntimeCodeSignature(
        "/fixture/node",
        { mode: "developer_id", team_id: "K5UP26B3W8" },
        { exec: developerExec },
      ),
    ).resolves.toBeUndefined();
    expect(developerExec.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "--all-architectures",
        "--test-requirement",
        expect.stringContaining("anchor apple generic"),
      ]),
    );
  });

  it("records signed libraries independently from their executable bit", async () => {
    const { release } = await fixture();
    const inventory = await runtimeArtifact.collectRuntimeInventory(release);
    expect(
      inventory.files.find((entry) => entry.path.endsWith("libexample.dylib")),
    ).toMatchObject({ code_signed: true, executable: false });
    expect(inventory.installedBytes).toBeGreaterThan(0);
  });

  it("keeps directory-link terminals owner-controlled and non-writable", async () => {
    const { release } = await fixture();
    await chmod(join(release, "runtime/runtime/node/bin"), 0o777);
    await expect(
      runtimeArtifact.collectRuntimeInventory(release),
    ).rejects.toThrow("RUNTIME_DIRECTORY_UNSAFE");
  });

  it("keeps the temporary ZIP outside the inventoried runtime tree", async () => {
    const { release } = await fixture();
    await expect(
      runtimeArtifact.createMacRuntimeArtifact({
        releaseRoot: release,
        outputDirectory: join(release, "artifact"),
        downloadBaseURL: "https://downloads.example.test/musicmute/runtime/",
        sourceVersion,
        signing: {
          release: false,
          identity: "-",
          signing: "AD_HOC_LOCAL",
        },
        signatureVerifier: async () => {},
      }),
    ).rejects.toThrow("RUNTIME_OUTPUT_UNSAFE");
  });

  it("creates a content-addressed ZIP and an exact pinned bootstrap manifest", async () => {
    const { root, release } = await fixture();
    const signatureVerifier = vi.fn(async () => {});
    const result = await runtimeArtifact.createMacRuntimeArtifact({
      releaseRoot: release,
      outputDirectory: join(root, "artifact"),
      downloadBaseURL: "https://downloads.example.test/musicmute/runtime/",
      redirectHosts: "release-assets.example.test",
      sourceVersion,
      signing: {
        release: false,
        identity: "-",
        signing: "AD_HOC_LOCAL",
      },
      signatureVerifier,
    });
    expect(result.archive_bytes).toBeGreaterThan(0);
    expect(result.archive_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.url).toContain(result.id);
    expect(result.url).toMatch(/^https:\/\/downloads\.example\.test\//);
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    expect(manifest).toMatchObject({
      schema_version: 1,
      runtime: {
        id: result.id,
        api_version: 1,
        source_version: sourceVersion,
        archive_sha256: result.archive_sha256,
        archive_bytes: result.archive_bytes,
        signing: { mode: "ad_hoc" },
        download_hosts: [
          "downloads.example.test",
          "release-assets.example.test",
        ],
      },
    });
    expect(result.files).toBe(manifest.runtime.files.length);
    expect(signatureVerifier).toHaveBeenCalledTimes(6);
    const { stdout: archiveListing } = await run("/usr/bin/unzip", [
      "-Z1",
      result.archive,
    ]);
    expect(archiveListing.split(/\r?\n/).filter(Boolean)).not.toContain(
      "runtime/unused/empty/",
    );
    expect(
      archiveListing
        .split(/\r?\n/)
        .filter(Boolean)
        .some((path) => path.endsWith("/")),
    ).toBe(false);

    const extracted = join(root, "extracted");
    await mkdir(extracted, { mode: 0o700 });
    await run("/usr/bin/ditto", [
      "-x",
      "-k",
      "--noextattr",
      "--noqtn",
      "--noacl",
      result.archive,
      extracted,
    ]);
    const roundTrip = await runtimeArtifact.collectRuntimeInventory(extracted);
    expect(roundTrip.files).toEqual(manifest.runtime.files);
    expect(roundTrip.installedBytes).toBe(manifest.runtime.installed_bytes);
    const library = roundTrip.files.find((entry) =>
      entry.path.endsWith("libexample.dylib"),
    );
    expect(library).toMatchObject({ executable: false, code_signed: true });
    expect((await lstat(join(extracted, library!.path))).mode & 0o111).toBe(0);
    expect(
      (await lstat(join(extracted, "runtime/runtime/node/bin/node"))).mode &
        0o111,
    ).not.toBe(0);
    expect(
      await readFile(join(extracted, "runtime/.runtime-policy"), "utf8"),
    ).toBe("hidden policy\n");
    expect(
      await readlink(join(extracted, "runtime/runtime/node/bin/node-link")),
    ).toBe("node");
    expect(
      await readlink(join(extracted, "runtime/runtime/node/bin-current")),
    ).toBe("bin");
    expect(
      await readlink(join(extracted, "runtime/runtime/node/bin-active")),
    ).toBe("bin-current");
    expect(
      await realpath(join(extracted, "runtime/runtime/node/bin-active")),
    ).toBe(join(extracted, "runtime/runtime/node/bin"));
    await expect(
      lstat(join(extracted, "runtime/unused/empty")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses an exact prior artifact inside the new build root", async () => {
    const prior = await priorPackageFixture();
    const nextBuildId = "22222222-2222-4222-8222-222222222222";
    const nextBuildRoot = join(prior.root, `build-${nextBuildId}.noindex`);
    await mkdir(nextBuildRoot, { mode: 0o700 });
    const signatureVerifier = vi.fn(async () => {});
    const reused = await runtimeArtifact.reuseMacRuntimeArtifact({
      packageResultPath: prior.packageResultPath,
      outputDirectory: join(nextBuildRoot, "runtime-release.noindex"),
      sourceVersion,
      signing: {
        release: false,
        identity: "-",
        signing: "AD_HOC_LOCAL",
      },
      downloadConfiguration: {
        redirectHosts: "release-assets.example.test",
      },
      signatureVerifier,
    });

    expect(reused).toMatchObject({
      id: prior.artifact.id,
      api_version: 1,
      source_version: sourceVersion,
      archive_bytes: prior.artifact.archive_bytes,
      archive_sha256: prior.artifact.archive_sha256,
      installed_bytes: prior.artifact.installed_bytes,
      manifest_sha256: prior.artifact.manifest_sha256,
      url: prior.artifact.url,
      files: prior.artifact.files,
      native_binaries: prior.artifact.native_binaries,
      reused: true,
      reuse_source: {
        package_result: prior.packageResultPath,
        build_id: "11111111-1111-4111-8111-111111111111",
        version: "1.2.3.4",
        build: "1",
      },
      signing: { mode: "ad_hoc" },
    });
    expect(await readFile(reused.archive)).toEqual(
      await readFile(prior.artifact.archive),
    );
    expect(await readFile(reused.manifest)).toEqual(
      await readFile(prior.artifact.manifest),
    );
    expect(signatureVerifier).toHaveBeenCalledTimes(
      prior.artifact.native_binaries,
    );
  });

  it("requires the same Developer ID team for release artifact reuse", async () => {
    const prior = await priorPackageFixture({ release: true });
    const nextRoot = join(
      prior.root,
      "build-29292929-2929-4929-8929-292929292929.noindex",
    );
    await mkdir(nextRoot, { mode: 0o700 });
    const signatureVerifier = vi.fn(async () => {});
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        packageResultPath: prior.packageResultPath,
        outputDirectory: join(nextRoot, "runtime-release.noindex"),
        sourceVersion,
        signing: {
          release: true,
          identity: "a".repeat(40),
          signing: "DEVELOPER_ID_DISTRIBUTION",
          teamIdentifier: "K5UP26B3W8",
        },
        signatureVerifier,
      }),
    ).resolves.toMatchObject({
      reused: true,
      signing: { mode: "developer_id", team_id: "K5UP26B3W8" },
      native_binaries: prior.artifact.native_binaries,
    });
    expect(signatureVerifier).toHaveBeenCalledTimes(
      prior.artifact.native_binaries,
    );

    const mismatchRoot = join(
      prior.root,
      "build-30303030-3030-4030-8030-303030303030.noindex",
    );
    await mkdir(mismatchRoot, { mode: 0o700 });
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        packageResultPath: prior.packageResultPath,
        outputDirectory: join(mismatchRoot, "runtime-release.noindex"),
        sourceVersion,
        signing: {
          release: true,
          identity: "b".repeat(40),
          signing: "DEVELOPER_ID_DISTRIBUTION",
          teamIdentifier: "ABCDEFGHIJ",
        },
        signatureVerifier: async () => {},
      }),
    ).rejects.toThrow("RUNTIME_REUSE_PACKAGE_MISMATCH");
  });

  it("fails closed on source, API, signing, or download-policy mismatch", async () => {
    const prior = await priorPackageFixture();
    const createOutput = async (id: string) => {
      const buildRoot = join(prior.root, `build-${id}.noindex`);
      await mkdir(buildRoot, { mode: 0o700 });
      return join(buildRoot, "runtime-release.noindex");
    };
    const baseOptions = {
      packageResultPath: prior.packageResultPath,
      sourceVersion,
      signing: {
        release: false,
        identity: "-",
        signing: "AD_HOC_LOCAL",
      },
      signatureVerifier: async () => {},
    };
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        ...baseOptions,
        sourceVersion: "0.2.0",
        outputDirectory: await createOutput(
          "33333333-3333-4333-8333-333333333333",
        ),
      }),
    ).rejects.toThrow("RUNTIME_REUSE_PACKAGE_MISMATCH");
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        ...baseOptions,
        signing: {
          release: true,
          identity: "a".repeat(40),
          signing: "DEVELOPER_ID_DISTRIBUTION",
          teamIdentifier: "K5UP26B3W8",
        },
        outputDirectory: await createOutput(
          "44444444-4444-4444-8444-444444444444",
        ),
      }),
    ).rejects.toThrow("RUNTIME_REUSE_PACKAGE_MISMATCH");
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        ...baseOptions,
        downloadConfiguration: runtimeArtifact.runtimeDownloadConfiguration({
          baseURL: "https://other.example.test/musicmute/runtime/",
        }),
        outputDirectory: await createOutput(
          "55555555-5555-4555-8555-555555555555",
        ),
      }),
    ).rejects.toThrow("RUNTIME_REUSE_DOWNLOAD_MISMATCH");
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        ...baseOptions,
        downloadConfiguration: { redirectHosts: "other.example.test" },
        outputDirectory: await createOutput(
          "54545454-5454-4454-8454-545454545454",
        ),
      }),
    ).rejects.toThrow("RUNTIME_REUSE_DOWNLOAD_MISMATCH");

    prior.packageDocument.version = "1.2.3-beta";
    await writeFile(
      prior.packageResultPath,
      `${JSON.stringify(prior.packageDocument, null, 2)}\n`,
    );
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        ...baseOptions,
        outputDirectory: await createOutput(
          "56565656-5656-4656-8656-565656565656",
        ),
      }),
    ).rejects.toThrow("RUNTIME_REUSE_PACKAGE_MISMATCH");

    prior.packageDocument.version = "1.2.3.4";
    prior.packageDocument.runtime.api_version = 2;
    await writeFile(
      prior.packageResultPath,
      `${JSON.stringify(prior.packageDocument, null, 2)}\n`,
    );
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        ...baseOptions,
        outputDirectory: await createOutput(
          "66666666-6666-4666-8666-666666666666",
        ),
      }),
    ).rejects.toThrow("RUNTIME_REUSE_PACKAGE_MISMATCH");
  });

  it("rejects a changed manifest inventory even when its new hash is recorded", async () => {
    const prior = await priorPackageFixture();
    const manifest = JSON.parse(
      await readFile(prior.artifact.manifest, "utf8"),
    ) as {
      runtime: { files: RuntimeFile[] };
    };
    const file = manifest.runtime.files.find((entry) => entry.type === "file");
    expect(file).toBeDefined();
    file!.sha256 = "f".repeat(64);
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(prior.artifact.manifest, manifestBytes);
    await writeFile(
      join(
        prior.packageRoot,
        "MusicMute Local.app/Contents/Resources/runtime-bootstrap.json",
      ),
      manifestBytes,
    );
    prior.packageDocument.runtime.manifest_sha256 = sha256(manifestBytes);
    await writeFile(
      prior.packageResultPath,
      `${JSON.stringify(prior.packageDocument, null, 2)}\n`,
    );
    const nextRoot = join(
      prior.root,
      "build-77777777-7777-4777-8777-777777777777.noindex",
    );
    await mkdir(nextRoot, { mode: 0o700 });
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        packageResultPath: prior.packageResultPath,
        outputDirectory: join(nextRoot, "runtime-release.noindex"),
        sourceVersion,
        signing: {
          release: false,
          identity: "-",
          signing: "AD_HOC_LOCAL",
        },
        signatureVerifier: async () => {},
      }),
    ).rejects.toThrow("RUNTIME_REUSE_PACKAGE_MISMATCH");
  });

  it("rejects changed archive bytes before copying them", async () => {
    const prior = await priorPackageFixture();
    await writeFile(prior.artifact.archive, "changed archive bytes\n");
    const nextRoot = join(
      prior.root,
      "build-78787878-7878-4878-8878-787878787878.noindex",
    );
    await mkdir(nextRoot, { mode: 0o700 });
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        packageResultPath: prior.packageResultPath,
        outputDirectory: join(nextRoot, "runtime-release.noindex"),
        sourceVersion,
        signing: {
          release: false,
          identity: "-",
          signing: "AD_HOC_LOCAL",
        },
        signatureVerifier: async () => {},
      }),
    ).rejects.toThrow("RUNTIME_REUSE_ARTIFACT_DIGEST_MISMATCH");
  });

  it("rejects unsafe prior-package ownership and artifact paths", async () => {
    const prior = await priorPackageFixture();
    await chmod(prior.packageResultPath, 0o666);
    const nextRoot = join(
      prior.root,
      "build-88888888-8888-4888-8888-888888888888.noindex",
    );
    await mkdir(nextRoot, { mode: 0o700 });
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        packageResultPath: prior.packageResultPath,
        outputDirectory: join(nextRoot, "runtime-release.noindex"),
        sourceVersion,
        signing: {
          release: false,
          identity: "-",
          signing: "AD_HOC_LOCAL",
        },
        signatureVerifier: async () => {},
      }),
    ).rejects.toThrow("RUNTIME_REUSE_PACKAGE_RESULT_UNSAFE");

    const escaped = await priorPackageFixture();
    const outsideArchive = join(escaped.root, "outside-runtime.zip");
    await copyFile(escaped.artifact.archive, outsideArchive);
    escaped.packageDocument.runtime.archive = outsideArchive;
    await writeFile(
      escaped.packageResultPath,
      `${JSON.stringify(escaped.packageDocument, null, 2)}\n`,
    );
    const escapedNextRoot = join(
      escaped.root,
      "build-89898989-8989-4989-8989-898989898989.noindex",
    );
    await mkdir(escapedNextRoot, { mode: 0o700 });
    await expect(
      runtimeArtifact.reuseMacRuntimeArtifact({
        packageResultPath: escaped.packageResultPath,
        outputDirectory: join(escapedNextRoot, "runtime-release.noindex"),
        sourceVersion,
        signing: {
          release: false,
          identity: "-",
          signing: "AD_HOC_LOCAL",
        },
        signatureVerifier: async () => {},
      }),
    ).rejects.toThrow("RUNTIME_REUSE_ARTIFACT_PATH_UNSAFE");
  });

  it("rejects escaping, root-targeting, dangling, and cyclic links", async () => {
    const { release } = await fixture();
    const link = join(release, "runtime/unsafe-link");
    await symlink("../../../../outside", link);
    await expect(
      runtimeArtifact.collectRuntimeInventory(release),
    ).rejects.toThrow("RUNTIME_LINK_UNSAFE");
    await rm(link);

    await symlink("..", link);
    await expect(
      runtimeArtifact.collectRuntimeInventory(release),
    ).rejects.toThrow("RUNTIME_LINK_UNSAFE");
    await rm(link);

    await symlink("missing", link);
    await expect(
      runtimeArtifact.collectRuntimeInventory(release),
    ).rejects.toThrow("RUNTIME_LINK_UNSAFE");
    await rm(link);

    await symlink("unused/empty", link);
    await expect(
      runtimeArtifact.collectRuntimeInventory(release),
    ).rejects.toThrow("RUNTIME_LINK_UNSAFE");
    await rm(link);

    const ancestorLink = join(release, "runtime/runtime/node/ancestor-link");
    await symlink(".", ancestorLink);
    await expect(
      runtimeArtifact.collectRuntimeInventory(release),
    ).rejects.toThrow("RUNTIME_LINK_UNSAFE");
    await rm(ancestorLink);

    await symlink("cycle-b", link);
    await symlink("unsafe-link", join(release, "runtime/cycle-b"));
    await expect(
      runtimeArtifact.collectRuntimeInventory(release),
    ).rejects.toThrow("RUNTIME_LINK_UNSAFE");
  });

  it("rejects POSIX link targets whose lexical and physical paths differ", async () => {
    const missing = await fixture();
    await symlink(
      "missing/../NOTICE.txt",
      join(missing.release, "runtime/missing-parent-link"),
    );
    await expect(
      runtimeArtifact.collectRuntimeInventory(missing.release),
    ).rejects.toThrow("RUNTIME_LINK_UNSAFE");

    const redirected = await fixture();
    const redirectedRoot = join(redirected.release, "runtime/redirected");
    await mkdir(join(redirectedRoot, "bad/sub"), { recursive: true });
    await writeFile(join(redirectedRoot, "good"), "signed-good\n");
    await writeFile(join(redirectedRoot, "bad/good"), "physical-bad\n");
    await writeFile(join(redirectedRoot, "bad/sub/marker"), "marker\n");
    await symlink("bad/sub", join(redirectedRoot, "alias"));
    const redirectedLink = join(redirectedRoot, "launcher");
    await symlink("alias/../good", redirectedLink);
    expect(await realpath(redirectedLink)).toBe(
      join(redirectedRoot, "bad/good"),
    );
    await expect(
      runtimeArtifact.collectRuntimeInventory(redirected.release),
    ).rejects.toThrow("RUNTIME_LINK_UNSAFE");

    const escaped = await fixture();
    const outside = join(escaped.release, "outside-dir");
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "outside\n");
    await mkdir(join(escaped.release, "runtime/safe"));
    await writeFile(join(escaped.release, "runtime/safe/marker"), "safe\n");
    const composedRoot = join(escaped.release, "runtime/a/b/c");
    await mkdir(composedRoot, { recursive: true });
    await mkdir(join(escaped.release, "runtime/a/outside-dir"));
    await writeFile(
      join(escaped.release, "runtime/a/outside-dir/decoy"),
      "inside\n",
    );
    await symlink("../../../safe", join(composedRoot, "alias"));
    const escapedLink = join(composedRoot, "launcher");
    await symlink("alias/../../outside-dir", escapedLink);
    expect(await realpath(escapedLink)).toBe(outside);
    await expect(
      runtimeArtifact.collectRuntimeInventory(escaped.release),
    ).rejects.toThrow("RUNTIME_LINK_UNSAFE");
  });

  it("fails closed when a Mach-O signature cannot be verified", async () => {
    const { root, release } = await fixture();
    await expect(
      runtimeArtifact.createMacRuntimeArtifact({
        releaseRoot: release,
        outputDirectory: join(root, "artifact"),
        downloadBaseURL: "https://downloads.example.test/runtime/",
        sourceVersion,
        signing: {
          release: false,
          identity: "-",
          signing: "AD_HOC_LOCAL",
        },
        signatureVerifier: async () => {
          throw new Error("raw tool detail must not escape");
        },
      }),
    ).rejects.toThrow("RUNTIME_SIGNATURE_INVALID");
  });

  it("rejects unexpected archive entries and oversized listings", () => {
    expect(() =>
      runtimeArtifact.assertRuntimeArchiveListing("runtime/node\nforeign\n", [
        { path: "runtime/node", type: "file" },
      ]),
    ).toThrow("RUNTIME_ARCHIVE_LISTING_INVALID");
    expect(() =>
      runtimeArtifact.assertRuntimeArchiveListing(
        "runtime/\nruntime/unmanifested-empty/\nruntime/node\n",
        [{ path: "runtime/node", type: "file" }],
      ),
    ).toThrow("RUNTIME_ARCHIVE_LISTING_INVALID");
    expect(() =>
      runtimeArtifact.assertRuntimeArchiveListing(
        "x".repeat(16 * 1024 * 1024 + 1),
        [],
      ),
    ).toThrow("RUNTIME_ARCHIVE_LISTING_INVALID");
  });
});
