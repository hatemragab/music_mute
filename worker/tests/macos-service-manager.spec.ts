import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMacServiceLayout,
  renderLaunchDaemonPlist,
} from "../src/platform/macos/launchd.js";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import {
  inspectMacServiceInstallation,
  installMacModelArtifact,
  installMacServiceFiles,
  rollbackMacServiceFiles,
  runMacServiceQualification,
  uninstallMacServiceFiles,
  waitForMacQualificationReport,
  waitForMacServiceDeactivation,
} from "../src/platform/macos/service-manager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("macOS service installation", () => {
  it("waits for launchd to finish asynchronous deactivation", async () => {
    const statuses = [0, 0, 113];
    const waits: number[] = [];
    await expect(
      waitForMacServiceDeactivation(
        async () => ({ code: statuses.shift() ?? 113 }),
        async (milliseconds) => {
          waits.push(milliseconds);
        },
        3,
      ),
    ).resolves.toBeUndefined();
    expect(waits).toEqual([100, 100]);
  });

  it("fails closed when launchd never removes the service", async () => {
    await expect(
      waitForMacServiceDeactivation(
        async () => ({ code: 0 }),
        async () => undefined,
        3,
      ),
    ).rejects.toThrow("LaunchDaemon deactivation failed");
  });

  it("installs an immutable release and preserves private state on uninstall", async () => {
    const sandbox = await temporaryRoot();
    const source = join(sandbox, "source-release");
    await releaseFixture(source, "0.1.0-service.1");
    const layout = createMacServiceLayout(
      join(sandbox, "install"),
      join(sandbox, "LaunchDaemons"),
    );
    const credential = join(sandbox, "credential");
    await writeFile(credential, "a".repeat(43), { mode: 0o600 });
    await chmod(credential, 0o600);
    const config = join(sandbox, "runtime.json");
    await writeFile(config, `${JSON.stringify(runtimeConfig(layout))}\n`);

    const installed = await installMacServiceFiles({
      releaseRoot: source,
      configSource: config,
      credentialSource: credential,
      layout,
      serviceUser: "_musicmute",
      serviceGroup: "_musicmute",
    });
    const inspection = await inspectMacServiceInstallation(
      layout,
      "_musicmute",
      "_musicmute",
    );

    expect(installed.releaseVersion).toBe("0.1.0-service.1");
    expect(inspection).toMatchObject({
      releaseVersion: "0.1.0-service.1",
      serviceLoaded: null,
    });
    expect(await readlink(layout.currentLink)).toBe("releases/0.1.0-service.1");
    expect((await lstat(layout.credentialPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(layout.credentialPath, "utf8")).toBe("a".repeat(43));

    const replacement = join(sandbox, "replacement-release");
    await releaseFixture(replacement, "0.1.0-service.3", "VALUE = 3\n");
    const upgraded = await installMacServiceFiles({
      releaseRoot: replacement,
      configSource: config,
      credentialSource: credential,
      layout,
      serviceUser: "_musicmute",
      serviceGroup: "_musicmute",
    });
    expect(upgraded.previousRelease).toBe("releases/0.1.0-service.1");
    await rollbackMacServiceFiles(layout, upgraded.previousRelease);
    expect(await readlink(layout.currentLink)).toBe("releases/0.1.0-service.1");

    await writeFile(credential, "z".repeat(43), { mode: 0o600 });
    await chmod(credential, 0o600);
    await expect(
      installMacServiceFiles({
        releaseRoot: source,
        configSource: config,
        credentialSource: credential,
        layout,
        serviceUser: "_musicmute",
        serviceGroup: "_musicmute",
      }),
    ).rejects.toThrow("machine credential is immutable during repair");
    expect(await readFile(layout.credentialPath, "utf8")).toBe("a".repeat(43));

    await uninstallMacServiceFiles(layout);
    await expect(lstat(layout.currentLink)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(layout.plistPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(layout.credentialPath)).resolves.toBeDefined();
    await expect(lstat(installed.releaseRoot)).resolves.toBeDefined();
  });

  it("does not replace an installed version with different bytes", async () => {
    const sandbox = await temporaryRoot();
    const source = join(sandbox, "source-release");
    await releaseFixture(source, "0.1.0-service.2");
    const layout = createMacServiceLayout(
      join(sandbox, "install"),
      join(sandbox, "LaunchDaemons"),
    );
    const credential = join(sandbox, "credential");
    await writeFile(credential, "b".repeat(43), { mode: 0o600 });
    await chmod(credential, 0o600);
    const config = join(sandbox, "runtime.json");
    await writeFile(config, `${JSON.stringify(runtimeConfig(layout))}\n`);
    const options = {
      releaseRoot: source,
      configSource: config,
      credentialSource: credential,
      layout,
      serviceUser: "_musicmute",
      serviceGroup: "_musicmute",
    };
    await installMacServiceFiles(options);

    const replacement = join(sandbox, "replacement-release");
    await releaseFixture(replacement, "0.1.0-service.2", "different\n");
    await expect(
      installMacServiceFiles({ ...options, releaseRoot: replacement }),
    ).rejects.toThrow("version is immutable");
  });

  it("qualifies under a one-shot service and restores the active plist", async () => {
    const sandbox = await temporaryRoot();
    const source = join(sandbox, "source-release");
    await releaseFixture(source, "0.1.0");
    const layout = createMacServiceLayout(
      join(sandbox, "install"),
      join(sandbox, "LaunchDaemons"),
    );
    const credential = join(sandbox, "credential");
    await writeFile(credential, "q".repeat(43), { mode: 0o600 });
    await chmod(credential, 0o600);
    const config = join(sandbox, "runtime.json");
    await writeFile(config, `${JSON.stringify(runtimeConfig(layout))}\n`);
    const installation = await installMacServiceFiles({
      releaseRoot: source,
      configSource: config,
      credentialSource: credential,
      layout,
      serviceUser: "_musicmute",
      serviceGroup: "_musicmute",
    });
    const fixtureSource = join(sandbox, "qualification.wav");
    await writeFile(fixtureSource, "RIFF qualification fixture");
    const fixtureSha256 = createHash("sha256")
      .update(await readFile(fixtureSource))
      .digest("hex");
    let activated = 0;
    let deactivated = 0;

    const qualification = await runMacServiceQualification({
      layout,
      releaseRoot: installation.releaseRoot,
      fixtureSource,
      fixtureSha256,
      serviceUser: "_musicmute",
      serviceGroup: "_musicmute",
      lifecycle: {
        activate: async () => {
          activated += 1;
          expect(await readFile(layout.plistPath, "utf8")).toContain(
            "musicmute_engine.qualification",
          );
        },
        deactivate: async () => {
          deactivated += 1;
        },
      },
      waitForReport: async (reportPath, expectedFixtureDigest, owner) => {
        await writeFile(
          reportPath,
          `${JSON.stringify(qualificationReport(expectedFixtureDigest))}\n`,
          { mode: 0o600 },
        );
        await chmod(reportPath, 0o600);
        await waitForMacQualificationReport(
          reportPath,
          expectedFixtureDigest,
          owner,
          async () => undefined,
          1,
        );
      },
    });

    expect(activated).toBe(1);
    expect(deactivated).toBe(1);
    expect((await lstat(qualification.fixturePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(qualification.reportPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(layout.plistPath, "utf8")).toBe(
      renderLaunchDaemonPlist({
        layout,
        serviceUser: "_musicmute",
        serviceGroup: "_musicmute",
      }),
    );
  });

  it("accepts only the exact model identity returned by private Python", async () => {
    const sandbox = await temporaryRoot();
    const layout = createMacServiceLayout(
      join(sandbox, "install"),
      join(sandbox, "LaunchDaemons"),
    );
    await mkdir(join(layout.currentLink, "runtime", "python", "bin"), {
      recursive: true,
    });
    await mkdir(layout.engineRoot, { recursive: true });
    await mkdir(layout.modelCacheRoot, { recursive: true });
    await mkdir(layout.runtimeCacheRoot, { recursive: true });
    await mkdir(layout.temporaryRoot, { recursive: true });
    const expectedModel = join(
      layout.modelCacheRoot,
      "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
      "Kim_Vocal_2.onnx",
    );
    await writeFile(
      layout.pythonPath,
      `#!/bin/sh
source_path=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--source" ]; then
    source_path="$2"
    break
  fi
  shift
done
case "$source_path" in
  ${JSON.stringify(`${layout.stateRoot}/.model-source-`)}*.onnx) ;;
  *) exit 71 ;;
esac
[ "$(stat -f %Lp "$source_path")" = "600" ] || exit 72
printf '%s\\n' '${JSON.stringify({
        status: "ok",
        modelSha256:
          "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
        modelBytes: 66_759_214,
        modelPath: expectedModel,
      })}'\n`,
      { mode: 0o755 },
    );
    await chmod(layout.pythonPath, 0o755);
    const source = join(sandbox, "Kim_Vocal_2.onnx");
    await writeFile(source, "");
    await truncate(source, 66_759_214);

    await expect(
      installMacModelArtifact(layout, source),
    ).resolves.toBeUndefined();
    expect(
      (await readdir(layout.stateRoot)).filter((entry) =>
        entry.startsWith(".model-source-"),
      ),
    ).toEqual([]);
    await truncate(source, 1);
    await expect(installMacModelArtifact(layout, source)).rejects.toThrow(
      "model source is unsafe",
    );
  });
});

function qualificationReport(fixtureDigest: string): object {
  return {
    schemaVersion: 1,
    status: "PASS",
    platform: "darwin-arm64",
    provider: "coreml",
    gpuId: "gpu0",
    directmlDeviceId: 0,
    serviceIdentity: "_musicmute",
    releaseManifestDigest: "a".repeat(64),
    modelDigest: "b".repeat(64),
    fixtureDigest,
    providerDispatch: {
      expectedProvider: "CoreMLExecutionProvider",
      profileCount: 1,
      acceleratedNodeEvents: 4,
      cpuNodeEvents: 0,
      proven: true,
    },
    recipes: [
      "kim-vocals-v1",
      "kim-vocals-trim-v1",
      "kim-vocals-denoise-v1",
      "kim-vocals-denoise-trim-v1",
    ].map((recipeId) => ({
      recipeId,
      recipeDigest: "c".repeat(64),
      resultDigest: "d".repeat(64),
      resultBytes: 1,
      sourceDurationSeconds: 1,
      outputDurationSeconds: 1,
      endToEndSeconds: 1,
    })),
    uploadCandidate: {
      path: "/Library/Application Support/MusicMute/attempts/qualification.mp3",
      resultDigest: "d".repeat(64),
      resultBytes: 1,
      contentType: "audio/mpeg",
    },
    totalSeconds: 4,
  };
}

function runtimeConfig(
  layout: ReturnType<typeof createMacServiceLayout>,
): object {
  return {
    schemaVersion: 1,
    backendBaseUrl: "https://api.example.invalid/api/v1",
    machineId: "00000000-0000-4000-8000-000000000000",
    credentialFile: layout.credentialPath,
    workRoot: layout.workRoot,
    modelCacheRoot: layout.modelCacheRoot,
    engineRoot: layout.engineRoot,
    pythonPath: layout.pythonPath,
    ffmpegPath: layout.ffmpegPath,
    ffprobePath: layout.ffprobePath,
    slots: [
      {
        workerId: "00000000-0000-4000-8000-000000000001",
        gpuId: "gpu-0",
        slotIndex: 0,
        recipeIds: ["kim-vocals-trim-v1"],
        provider: "coreml",
      },
    ],
  };
}

async function releaseFixture(
  root: string,
  version: string,
  engine = "VALUE = 1\n",
): Promise<void> {
  const executablePaths = [
    "app/dist/src/cli/main.js",
    "runtime/node/bin/node",
    "runtime/python/bin/python3.13",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
  ];
  for (const path of executablePaths) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(absolute, 0o755);
  }
  await symlink(
    "python3.13",
    join(root, "runtime", "python", "bin", "python3"),
  );
  await mkdir(join(root, "app", "engine"), { recursive: true });
  await writeFile(join(root, "app", "engine", "module.py"), engine);
  await mkdir(join(root, "runtime", "licenses", "ffmpeg"), { recursive: true });
  await mkdir(join(root, "runtime", "licenses", "lame"), { recursive: true });
  await writeFile(
    join(root, "runtime", "licenses", "ffmpeg", "COPYING.LGPLv2.1"),
    "FFmpeg license\n",
  );
  await writeFile(
    join(root, "runtime", "licenses", "lame", "COPYING"),
    "LAME license\n",
  );
  await writeFile(
    join(root, "runtime", "media-source-manifest.json"),
    '{"schemaVersion":1}\n',
  );
  await writeMacReleaseManifest(root, version);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-macos-service-"));
  roots.push(root);
  return root;
}
