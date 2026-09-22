import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallationReleaseArchive } from "../src/enrollment/release-archive.js";
import { initializeLocalLifecycle } from "../src/runtime/local-lifecycle.js";
import { writeLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import { buildMacUserRuntimeConfig } from "../src/platform/macos/user-installer.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";
import { installMacUserRelease } from "../src/platform/macos/user-release.js";
import {
  BUILT_IN_MAC_UPDATE_TRUST,
  checkMacUserUpdate,
  compareWorkerReleaseVersions,
  loadMacUpdateTrust,
  updateMacUserWorker,
} from "../src/platform/macos/user-updater.js";
import {
  canonicalMacUpdateMetadata,
  type MacUpdateCandidate,
  type MacUpdateMetadata,
} from "../src/platform/macos/update-metadata.js";

const roots: string[] = [];
const machineId = "32410a14-e85a-4a1d-bb99-61fa54b07eaa";
const workerId = "718bd89b-bd03-43f7-adb7-9cb5ff415918";

vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("macOS transactional updater", () => {
  it.each([
    ["0.1.0-mvp.11", "0.1.0-mvp.2", 1],
    ["0.1.0-mvp.2", "0.1.0-mvp.11", -1],
    ["0.2.0", "0.1.99", 1],
    ["1.0.0", "1.0.0-rc.9", 1],
    ["1.0.0+build.2", "1.0.0+build.1", 0],
  ] as const)("orders release %s against %s", (left, right, expected) => {
    expect(Math.sign(compareWorkerReleaseVersions(left, right))).toBe(expected);
  });

  it("uses the built-in production key when the optional trust file is absent", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);

    const trust = await loadMacUpdateTrust(layout.updateTrustPath);

    expect(trust).toEqual(BUILT_IN_MAC_UPDATE_TRUST);
    expect(
      createPublicKey(trust["worker-release-2026-09"]!).asymmetricKeyType,
    ).toBe("ed25519");
    await expect(lstat(layout.updateTrustPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("merges optional rotation keys without allowing built-in replacement", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    const additional = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    await writeFile(
      layout.updateTrustPath,
      `${JSON.stringify({ "release-next": additional })}\n`,
      { mode: 0o600 },
    );

    await expect(loadMacUpdateTrust(layout.updateTrustPath)).resolves.toEqual({
      "release-next": additional,
      ...BUILT_IN_MAC_UPDATE_TRUST,
    });
    await writeFile(
      layout.updateTrustPath,
      `${JSON.stringify({ "worker-release-2026-09": additional })}\n`,
      { mode: 0o600 },
    );
    await expect(loadMacUpdateTrust(layout.updateTrustPath)).rejects.toThrow(
      "cannot replace a built-in key",
    );
  });

  it("checks signed metadata without downloading or changing the active release", async () => {
    const fixture = await updateFixture();
    const before = await readlink(fixture.layout.currentLink);
    const checked = await checkMacUserUpdate(fixture.layout, {
      candidate: async () => fixture.candidate,
      now: fixture.now,
    });
    expect(checked).toMatchObject({
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      sequence: 2,
      updateAvailable: true,
    });
    expect(await readlink(fixture.layout.currentLink)).toBe(before);
  });

  it("downloads, qualifies, atomically activates, and records a healthy update", async () => {
    const fixture = await updateFixture();
    const qualify = vi.fn(async () =>
      join(fixture.layout.stateRoot, "report.json"),
    );
    const result = await updateMacUserWorker({
      layout: fixture.layout,
      uid: process.getuid!(),
      candidate: async () => fixture.candidate,
      now: fixture.now,
      fetch: fixture.fetch,
      qualify,
      launchAgent: fixture.launchAgent,
      confirmStarted: async () => true,
      health: async () => true,
    });

    expect(result).toEqual({
      status: "updated",
      releaseVersion: "0.2.0",
      sequence: 2,
    });
    expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.2.0");
    expect(qualify).toHaveBeenCalledOnce();
    expect(
      JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
    ).toMatchObject({
      highestSequence: 2,
      status: "healthy",
      knownGoodVersion: "0.2.0",
    });
    expect(
      JSON.parse(await readFile(fixture.layout.installationStatePath, "utf8")),
    ).toMatchObject({ releaseVersion: "0.2.0" });
    expect(
      JSON.parse(await readFile(fixture.layout.configPath, "utf8")),
    ).toMatchObject({ slots: [{ provider: "mps" }] });
  });

  it("restores the known-good release and quarantines a failed candidate", async () => {
    const fixture = await updateFixture();
    await expect(
      updateMacUserWorker({
        layout: fixture.layout,
        uid: process.getuid!(),
        candidate: async () => fixture.candidate,
        now: fixture.now,
        fetch: fixture.fetch,
        qualify: async () => join(fixture.layout.stateRoot, "report.json"),
        launchAgent: fixture.launchAgent,
        confirmStarted: async () => false,
      }),
    ).rejects.toThrow("failed to start");
    expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
    expect(
      JSON.parse(await readFile(fixture.layout.configPath, "utf8")),
    ).toMatchObject({ slots: [{ provider: "mps" }] });
    expect(
      JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
    ).toMatchObject({
      status: "rolled-back",
      candidateVersion: "0.2.0",
      quarantinedVersions: ["0.2.0"],
    });
  });

  it("rolls back and quarantines a candidate that fails the runtime doctor", async () => {
    const fixture = await updateFixture();
    await expect(
      updateMacUserWorker({
        layout: fixture.layout,
        uid: process.getuid!(),
        candidate: async () => fixture.candidate,
        now: fixture.now,
        fetch: fixture.fetch,
        qualify: async () => join(fixture.layout.stateRoot, "report.json"),
        launchAgent: fixture.launchAgent,
        confirmStarted: async () => true,
        health: async () => false,
      }),
    ).rejects.toThrow("failed runtime doctor");
    expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
    expect(
      JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
    ).toMatchObject({
      status: "rolled-back",
      candidateVersion: "0.2.0",
      quarantinedVersions: ["0.2.0"],
      failure: "Updated worker failed runtime doctor",
    });
  });

  it("rejects insufficient disk before download without changing the active release", async () => {
    const fixture = await updateFixture();
    const fetch = vi.fn(fixture.fetch);
    await expect(
      updateMacUserWorker({
        layout: fixture.layout,
        uid: process.getuid!(),
        candidate: async () => fixture.candidate,
        now: fixture.now,
        fetch,
        availableDiskBytes: async () => 1,
        launchAgent: fixture.launchAgent,
      }),
    ).rejects.toThrow("Insufficient disk space");
    expect(fetch).not.toHaveBeenCalled();
    expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
  });

  it("preserves the active release when an offline download is interrupted", async () => {
    const fixture = await updateFixture();
    await expect(
      updateMacUserWorker({
        layout: fixture.layout,
        uid: process.getuid!(),
        candidate: async () => fixture.candidate,
        now: fixture.now,
        fetch: async () => {
          throw new TypeError("network offline");
        },
        availableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
        launchAgent: fixture.launchAgent,
      }),
    ).rejects.toThrow("network offline");
    expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
    await expect(
      readFile(fixture.layout.updateStatePath, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines a candidate when MPS qualification fails", async () => {
    const fixture = await updateFixture();
    await expect(
      updateMacUserWorker({
        layout: fixture.layout,
        uid: process.getuid!(),
        candidate: async () => fixture.candidate,
        now: fixture.now,
        fetch: fixture.fetch,
        qualify: async () => {
          throw new Error("MPS qualification failed");
        },
        launchAgent: fixture.launchAgent,
      }),
    ).rejects.toThrow("MPS qualification failed");
    expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
    expect(
      JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
    ).toMatchObject({
      status: "rolled-back",
      candidateVersion: "0.2.0",
      quarantinedVersions: ["0.2.0"],
    });
  });
});

async function updateFixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-update-"));
  roots.push(root);
  await chmod(root, 0o700);
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const layout = createMacUserLayout(home);
  await createMacUserDirectories(layout);
  const currentSource = join(root, "release-0.1.0");
  const candidateSource = join(root, "release-0.2.0");
  await releaseFixture(currentSource, "0.1.0");
  await releaseFixture(candidateSource, "0.2.0");
  await installMacUserRelease(layout, currentSource);
  await writeFile(layout.credentialPath, `${"m".repeat(43)}\n`, {
    mode: 0o600,
  });
  const generatedRuntimeConfig = buildMacUserRuntimeConfig(
    layout,
    "https://api.music-mute.com/api/v1",
    false,
    {
      machineId,
      workerId,
    },
  );
  await writeFile(
    layout.configPath,
    `${JSON.stringify(generatedRuntimeConfig)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    layout.installationStatePath,
    `${JSON.stringify({ schemaVersion: 1, releaseVersion: "0.1.0" })}\n`,
    { mode: 0o600 },
  );
  await initializeLocalLifecycle(layout.lifecyclePath);
  await writeLocalRuntimeStatus(layout.runtimeStatusPath, []);
  await writeFile(join(layout.stateRoot, "qualification.wav"), "fixture", {
    mode: 0o600,
  });
  const archivePath = join(root, "candidate.tar.gz");
  const archive = await createInstallationReleaseArchive({
    releaseRoot: candidateSource,
    outputPath: archivePath,
    platform: "darwin-arm64",
  });
  const bytes = await readFile(archivePath);
  const now = new Date("2026-09-22T00:00:00.000Z");
  const metadata: MacUpdateMetadata = {
    schemaVersion: 1,
    sequence: 2,
    platform: "darwin-arm64",
    releaseVersion: "0.2.0",
    publishedAt: "2026-09-21T00:00:00.000Z",
    expiresAt: "2026-09-23T00:00:00.000Z",
    release: {
      filename: "musicmute-worker-darwin-arm64.tar.gz",
      bytes: archive.bytes,
      sha256: archive.sha256,
      contentType: "application/gzip",
    },
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const candidate: MacUpdateCandidate = {
    signed: {
      keyId: "release-test",
      metadata,
      signature: sign(
        null,
        Buffer.from(canonicalMacUpdateMetadata(metadata), "utf8"),
        privateKey,
      ).toString("base64url"),
    },
    grant: {
      url: "https://storage.example.invalid/candidate.tar.gz",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  await writeFile(
    layout.updateTrustPath,
    `${JSON.stringify({
      "release-test": publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    })}\n`,
    { mode: 0o600 },
  );
  let loaded = true;
  const launchAgent = {
    status: vi.fn(async () => ({ loaded, running: loaded })),
    bootout: vi.fn(async () => {
      loaded = false;
    }),
    bootstrap: vi.fn(async () => {
      loaded = true;
    }),
  };
  return {
    layout,
    candidate,
    now,
    launchAgent,
    fetch: vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/gzip",
            "content-length": String(bytes.length),
          },
        }),
    ) as typeof fetch,
  };
}

async function releaseFixture(root: string, version: string): Promise<void> {
  const executables = [
    ["runtime/node/bin/node", "#!/bin/sh\nprintf 'v24.18.0\\n'\n"],
    ["runtime/python/bin/python3", "#!/bin/sh\nexit 0\n"],
    [
      "runtime/bin/ffmpeg",
      "#!/bin/sh\nprintf 'ffmpeg version 8.0.3 Copyright\\n'\n",
    ],
    [
      "runtime/bin/ffprobe",
      "#!/bin/sh\nprintf 'ffprobe version 8.0.3 Copyright\\n'\n",
    ],
    ["app/dist/src/cli/main.js", "#!/bin/sh\nexit 0\n"],
  ] as const;
  for (const [path, source] of executables) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o755 });
    await writeFile(absolute, source, { mode: 0o755 });
  }
  await mkdir(join(root, "app", "engine"), { recursive: true, mode: 0o755 });
  for (const [path, value] of [
    ["runtime/licenses/ffmpeg/COPYING.LGPLv2.1", "license\n"],
    ["runtime/licenses/lame/COPYING", "license\n"],
    ["runtime/media-source-manifest.json", '{"schemaVersion":1}\n'],
  ] as const) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o755 });
    await writeFile(absolute, value, { mode: 0o644 });
  }
  await writeMacReleaseManifest(root, version);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-update-trust-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
