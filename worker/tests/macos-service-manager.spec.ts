import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
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
import { createMacServiceLayout } from "../src/platform/macos/launchd.js";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import {
  inspectMacServiceInstallation,
  installMacModelArtifact,
  installMacServiceFiles,
  rollbackMacServiceFiles,
  uninstallMacServiceFiles,
} from "../src/platform/macos/service-manager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("macOS service installation", () => {
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
    await mkdir(layout.temporaryRoot, { recursive: true });
    const expectedModel = join(
      layout.modelCacheRoot,
      "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
      "Kim_Vocal_2.onnx",
    );
    await writeFile(
      layout.pythonPath,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({
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
    await truncate(source, 1);
    await expect(installMacModelArtifact(layout, source)).rejects.toThrow(
      "model source is unsafe",
    );
  });
});

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
  await writeMacReleaseManifest(root, version);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-macos-service-"));
  roots.push(root);
  return root;
}
