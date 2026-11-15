import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import {
  inspectMacUserHealth,
  macUserPythonEnvironment,
} from "../src/platform/macos/user-health.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("macOS user runtime health", () => {
  it("quick doctor reads local state without verifying release or launching the runtime doctor", async () => {
    const layout = await healthyFixture();
    await writeLocalRuntimeStatus(layout.runtimeStatusPath, []);
    const runtimeDoctor = vi.fn(async () => undefined);
    const releaseVerifier = vi.fn(async () => undefined);
    const result = await inspectMacUserHealth(
      layout,
      { status: async () => ({ loaded: true, running: true }) },
      { depth: "quick", runtimeDoctor, releaseVerifier },
    );
    expect(runtimeDoctor).not.toHaveBeenCalled();
    expect(releaseVerifier).not.toHaveBeenCalled();
    expect(result.healthy).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "runtime-snapshot", status: "passed" }),
        expect.objectContaining({ name: "runtime-doctor", status: "not-run" }),
        expect.objectContaining({
          name: "release-manifest",
          status: "not-run",
        }),
      ]),
    );
  });

  it("keeps doctor caches and executable discovery outside the immutable release", () => {
    const layout = createMacUserLayout("/Users/tester");
    expect(macUserPythonEnvironment(layout)).toMatchObject({
      NUMBA_CACHE_DIR: join(layout.cacheRoot, "numba"),
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONUNBUFFERED: "1",
      XDG_CACHE_HOME: layout.cacheRoot,
    });
    expect(macUserPythonEnvironment(layout).PATH).toBe(
      `${dirname(layout.ffmpegPath)}:${dirname(layout.nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    );
  });

  it("requires a running LaunchAgent and a passing private runtime doctor", async () => {
    const layout = await healthyFixture();
    const runtimeDoctor = vi.fn(async () => undefined);
    const healthy = await inspectMacUserHealth(
      layout,
      { status: async () => ({ loaded: true, running: true }) },
      { runtimeDoctor, releaseVerifier: async () => undefined },
    );
    expect(healthy.healthy).toBe(true);
    expect(runtimeDoctor).toHaveBeenCalledOnce();
    expect(healthy.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "config-contract", ok: true }),
        expect.objectContaining({ name: "runtime-doctor", ok: true }),
        expect.objectContaining({ name: "launchctl", ok: true }),
      ]),
    );

    const unhealthy = await inspectMacUserHealth(
      layout,
      { status: async () => ({ loaded: true, running: false }) },
      {
        runtimeDoctor: async () => {
          throw new Error("broken runtime");
        },
        releaseVerifier: async () => undefined,
      },
    );
    expect(unhealthy.healthy).toBe(false);
    expect(unhealthy.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "runtime-doctor", ok: false }),
        expect.objectContaining({ name: "launchctl", ok: false }),
      ]),
    );
  });
});

async function healthyFixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-health-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const layout = createMacUserLayout(home);
  await createMacUserDirectories(layout);
  const release = join(layout.releasesRoot, "0.1.0");
  for (const path of [
    "app/dist/src/cli/main.js",
    "runtime/node/bin/node",
    "runtime/python/bin/python3.13",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
  ]) {
    const absolute = join(release, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(absolute, 0o755);
  }
  await symlink(
    "python3.13",
    join(release, "runtime", "python", "bin", "python3"),
  );
  await mkdir(join(release, "app", "engine"), { recursive: true });
  await symlink("releases/0.1.0", layout.currentLink);
  await writeFile(layout.credentialPath, `${"x".repeat(43)}\n`, {
    mode: 0o600,
  });
  for (const path of [
    layout.lifecyclePath,
    layout.runtimeStatusPath,
    layout.plistPath,
  ]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{}\n", { mode: 0o600 });
  }
  await writeFile(
    layout.configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      backendBaseUrl: "https://api.music-mute.com/api/v1/",
      machineId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
      credentialFile: layout.credentialPath,
      localLifecyclePath: layout.lifecyclePath,
      localRuntimeStatusPath: layout.runtimeStatusPath,
      workRoot: layout.workRoot,
      modelCacheRoot: layout.modelRoot,
      engineRoot: layout.engineRoot,
      pythonPath: layout.pythonPath,
      ffmpegPath: layout.ffmpegPath,
      ffprobePath: layout.ffprobePath,
      allowInsecureLoopback: false,
      slots: [
        {
          workerId: "718bd89b-bd03-43f7-adb7-9cb5ff415918",
          gpuId: "gpu0",
          slotIndex: 0,
          recipeIds: ["kim-vocals-v2"],
          provider: "mps",
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  return layout;
}
