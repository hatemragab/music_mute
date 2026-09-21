import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import {
  buildMacUserRuntimeConfig,
  installMacUserWorker,
  PRODUCTION_BACKEND_BASE_URL,
  readPendingMacUserEnrollmentCredential,
  recoverMacUserWorker,
} from "../src/platform/macos/user-installer.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";
import { loadRuntimeConfig } from "../src/runtime/runtime-config.js";

const machineId = "32410a14-e85a-4a1d-bb99-61fa54b07eaa";
const workerId = "718bd89b-bd03-43f7-adb7-9cb5ff415918";
const roots: string[] = [];
const compatibleRuntime = {
  node: {
    decision: "reuse" as const,
    requestedVersion: "24.18.0",
    installedVersion: "24.18.0",
    reason: "compatible" as const,
  },
  ffmpeg: {
    decision: "reuse" as const,
    requestedVersion: "8.0.3",
    installedVersion: "8.0.3",
    reason: "compatible" as const,
  },
  ffprobe: {
    decision: "reuse" as const,
    requestedVersion: "8.0.3",
    installedVersion: "8.0.3",
    reason: "compatible" as const,
  },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("macOS one-command user installation", () => {
  it("stages, enrolls, configures, and loads the per-user worker", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const sourceRelease = join(root, "release");
    const modelSource = join(root, "Kim_Vocal_2.onnx");
    const fixtureSource = join(root, "qualification.wav");
    await mkdir(home, { mode: 0o700 });
    await releaseFixture(sourceRelease, "0.1.0");
    const model = Buffer.from("model");
    const fixture = Buffer.from("fixture");
    await writeFile(modelSource, model, { mode: 0o600 });
    await writeFile(fixtureSource, fixture, { mode: 0o600 });
    const layout = createMacUserLayout(home);
    const prepare = vi.fn(
      async (arguments_: string[], _reuse?: { reusableModelPath?: string }) => {
        const output = arguments_[arguments_.indexOf("--output") + 1]!;
        await writeFile(
          join(output, "installation-artifacts.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            installationId: "cb56441d-f2df-4b44-a320-6f37dfa81f7f",
            platform: "darwin-arm64",
            releaseVersion: "0.1.0",
            release: { releaseRoot: sourceRelease },
            model: {
              path: modelSource,
              bytes: model.length,
              sha256: createHash("sha256").update(model).digest("hex"),
            },
            fixture: {
              path: fixtureSource,
              sha256: createHash("sha256").update(fixture).digest("hex"),
            },
          })}\n`,
          { mode: 0o600 },
        );
      },
    );
    const enroll = vi.fn(async (arguments_: string[]) => {
      const output = arguments_[arguments_.indexOf("--output") + 1]!;
      await writeFile(
        join(output, ".enrollment-state.json"),
        `${JSON.stringify({ machineId, workerId })}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        join(output, "machine.credential"),
        `${"m".repeat(43)}\n`,
        {
          mode: 0o600,
        },
      );
    });
    const qualificationPath = join(layout.stateRoot, "qualification.json");
    const qualify = vi.fn(async () => qualificationPath);
    const launchAgent = {
      bootstrap: vi.fn(async () => undefined),
      bootout: vi.fn(async () => undefined),
      status: vi.fn(async () => ({ loaded: true, running: true })),
    };

    await expect(
      installMacUserWorker({
        layout,
        uid: process.getuid!(),
        enrollmentCredential: "x".repeat(43),
        label: "Studio Mac",
        launchAgent,
        prepare,
        enroll,
        qualify,
        inspectRuntime: vi.fn(async () => compatibleRuntime),
        legacyDaemonPath: join(root, "missing-legacy.plist"),
      }),
    ).resolves.toMatchObject({
      machineId,
      releaseVersion: "0.1.0",
      serviceLoaded: true,
    });
    const config = await loadRuntimeConfig(layout.configPath, {
      platform: "darwin",
      arch: "arm64",
    });
    expect(config).toMatchObject({
      backendBaseUrl: `${PRODUCTION_BACKEND_BASE_URL}/`,
      machineId,
      localLifecyclePath: layout.lifecyclePath,
      credential: "m".repeat(43),
    });
    expect(launchAgent.bootstrap).toHaveBeenCalledWith(layout.plistPath);
    expect(prepare).toHaveBeenCalledWith(expect.any(Array), {
      reusableModelPath: join(
        layout.modelRoot,
        "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
        "Kim_Vocal_2.onnx",
      ),
    });
    expect(await readFile(layout.plistPath, "utf8")).toContain(
      "com.musicmute.worker",
    );
    expect(
      JSON.parse(await readFile(layout.installationStatePath, "utf8")),
    ).toMatchObject({
      releaseVersion: "0.1.0",
      runtimePreflight: {
        node: { decision: "reuse", installedVersion: "24.18.0" },
        ffmpeg: { decision: "reuse", installedVersion: "8.0.3" },
        ffprobe: { decision: "reuse", installedVersion: "8.0.3" },
      },
    });
  });

  it("builds only the production HTTPS base URL by default", () => {
    const layout = createMacUserLayout("/Users/tester");
    expect(
      buildMacUserRuntimeConfig(layout, PRODUCTION_BACKEND_BASE_URL, false, {
        machineId,
        workerId,
      }),
    ).toMatchObject({
      backendBaseUrl: "https://api.music-mute.com/api/v1/",
      localLifecyclePath: layout.lifecyclePath,
    });
  });

  it("reactivates a preserved verified release without enrollment", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    await releaseFixture(join(layout.releasesRoot, "0.1.0"), "0.1.0");
    await writeFile(layout.configPath, "{}\n", { mode: 0o600 });
    await writeFile(layout.credentialPath, `${"m".repeat(43)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      layout.installationStatePath,
      `${JSON.stringify({ releaseVersion: "0.1.0" })}\n`,
      { mode: 0o600 },
    );
    const launchAgent = {
      bootstrap: vi.fn(async () => undefined),
      bootout: vi.fn(async () => undefined),
      status: vi.fn(async () => ({ loaded: true, running: true })),
    };

    await expect(
      recoverMacUserWorker({
        layout,
        uid: process.getuid!(),
        launchAgent,
        confirmHealthy: async () => true,
      }),
    ).resolves.toEqual({ releaseVersion: "0.1.0", serviceLoaded: true });
    expect(
      await import("node:fs/promises").then(({ readlink }) =>
        readlink(layout.currentLink),
      ),
    ).toBe("releases/0.1.0");
    expect(launchAgent.bootstrap).toHaveBeenCalledWith(layout.plistPath);
  });

  it("rolls recovery back when the restored runtime is unhealthy", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    await releaseFixture(join(layout.releasesRoot, "0.1.0"), "0.1.0");
    await writeFile(layout.configPath, "{}\n", { mode: 0o600 });
    await writeFile(layout.credentialPath, `${"m".repeat(43)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      layout.installationStatePath,
      `${JSON.stringify({ releaseVersion: "0.1.0" })}\n`,
      { mode: 0o600 },
    );
    const launchAgent = {
      bootstrap: vi.fn(async () => undefined),
      bootout: vi.fn(async () => undefined),
      status: vi.fn(async () => ({ loaded: true, running: true })),
    };

    await expect(
      recoverMacUserWorker({
        layout,
        uid: process.getuid!(),
        launchAgent,
        confirmHealthy: async () => false,
      }),
    ).rejects.toThrow("failed runtime doctor");
    await expect(
      import("node:fs/promises").then(({ lstat }) => lstat(layout.currentLink)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(launchAgent.bootout).toHaveBeenCalledOnce();
  });

  it("reads only a private valid pending enrollment credential", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    await createMacUserDirectories(layout);
    const pending = join(
      layout.transactionRoot,
      "install",
      "enrollment.credential",
    );
    await mkdir(dirname(pending), { recursive: true, mode: 0o700 });
    await writeFile(pending, `${"p".repeat(43)}\n`, { mode: 0o600 });
    await expect(readPendingMacUserEnrollmentCredential(layout)).resolves.toBe(
      "p".repeat(43),
    );
    await chmod(pending, 0o644);
    await expect(
      readPendingMacUserEnrollmentCredential(layout),
    ).rejects.toThrow("unsafe");
  });
});

async function releaseFixture(root: string, version: string): Promise<void> {
  for (const path of [
    "app/dist/src/cli/main.js",
    "runtime/node/bin/node",
    "runtime/python/bin/python3.13",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
  ]) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(absolute, 0o755);
  }
  await symlink(
    "python3.13",
    join(root, "runtime", "python", "bin", "python3"),
  );
  await mkdir(join(root, "app", "engine"), { recursive: true });
  await writeFile(join(root, "app", "engine", "module.py"), "VALUE = 1\n");
  await writeFile(
    join(root, "app", "package.json"),
    '{"name":"@musicmute/worker","version":"0.1.0"}\n',
  );
  for (const [path, value] of [
    ["runtime/licenses/ffmpeg/COPYING.LGPLv2.1", "license\n"],
    ["runtime/licenses/lame/COPYING", "license\n"],
    ["runtime/media-source-manifest.json", '{"schemaVersion":1}\n'],
  ] as const) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, value);
  }
  await writeMacReleaseManifest(root, version);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-installer-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
