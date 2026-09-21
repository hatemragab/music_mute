import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/runtime/runtime-config.js";
import { WorkspaceManager } from "../src/runtime/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("runtime local safety", () => {
  it("loads a strict config while keeping the machine credential in its own file", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-config-"));
    roots.push(root);
    const credentialFile = join(root, "machine.credential");
    const configFile = join(root, "runtime.json");
    const localLifecyclePath = join(root, "state", "lifecycle.json");
    await writeFile(credentialFile, `${"x".repeat(43)}\n`, { mode: 0o600 });
    await writeFile(
      configFile,
      JSON.stringify({
        schemaVersion: 1,
        backendBaseUrl: "https://api.example.invalid/api/v1",
        machineId: "cb56441d-f2df-4b44-a320-6f37dfa81f7f",
        credentialFile,
        localLifecyclePath,
        workRoot: join(root, "work"),
        modelCacheRoot: join(root, "models"),
        engineRoot: join(root, "engine"),
        pythonPath: join(root, "python"),
        ffmpegPath: join(root, "ffmpeg"),
        ffprobePath: join(root, "ffprobe"),
        slots: [
          {
            workerId: "a69d3899-2214-4427-98cf-b9a4449aeae1",
            gpuId: "gpu-0",
            slotIndex: 0,
            recipeIds: ["kim-vocals-trim-v1"],
            provider: "coreml",
          },
        ],
      }),
      { mode: 0o600 },
    );

    const config = await loadRuntimeConfig(configFile, {
      platform: "darwin",
      arch: "arm64",
    });
    expect(config.credential).toBe("x".repeat(43));
    expect(config.localLifecyclePath).toBe(localLifecyclePath);
    expect(config.slots[0]).toMatchObject({ provider: "coreml", slotIndex: 0 });
  });

  it("removes only stale UUID attempt directories on startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-workspace-"));
    roots.push(root);
    const attempts = join(root, "attempts");
    const stale = join(attempts, "99f8016b-67f3-4f4b-beb4-205a7b87147e");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "partial"), "stale");
    await writeFile(join(attempts, "owner-note.txt"), "preserve");
    const workspace = new WorkspaceManager(attempts);

    await workspace.initialize();

    expect(await readdir(attempts)).toEqual(["owner-note.txt"]);
    const created = await workspace.create(
      "9bb25abc-2b00-4a85-887c-a458dbbcc018",
      "application/x-untrusted-playlist",
    );
    expect(created.input).toBe(join(created.root, "input.bin"));
    expect(created.output).toBe(join(created.root, "output", "vocals.mp3"));
    await workspace.cleanup(created);
  });

  it("requires the exact provider and device boundary of the host adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-adapter-config-"));
    roots.push(root);
    const credentialFile = join(root, "machine.credential");
    const configFile = join(root, "runtime.json");
    await writeFile(credentialFile, `${"x".repeat(43)}\n`, { mode: 0o600 });
    const config = {
      schemaVersion: 1,
      backendBaseUrl: "https://api.example.invalid/api/v1",
      machineId: "cb56441d-f2df-4b44-a320-6f37dfa81f7f",
      credentialFile,
      workRoot: join(root, "work"),
      modelCacheRoot: join(root, "models"),
      engineRoot: join(root, "engine"),
      pythonPath: join(root, "python.exe"),
      ffmpegPath: join(root, "ffmpeg.exe"),
      ffprobePath: join(root, "ffprobe.exe"),
      slots: [
        {
          workerId: "a69d3899-2214-4427-98cf-b9a4449aeae1",
          gpuId: "gpu-0",
          slotIndex: 0,
          recipeIds: ["kim-vocals-trim-v1"],
          provider: "directml",
        },
      ],
    };
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });

    await expect(
      loadRuntimeConfig(configFile, { platform: "win32", arch: "x64" }),
    ).rejects.toThrow("directmlDeviceId is invalid");

    config.slots[0] = { ...config.slots[0], directmlDeviceId: 0 } as never;
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    await expect(
      loadRuntimeConfig(configFile, { platform: "win32", arch: "x64" }),
    ).resolves.toMatchObject({
      slots: [{ provider: "directml", directmlDeviceId: 0 }],
    });

    await expect(
      loadRuntimeConfig(configFile, { platform: "linux", arch: "x64" }),
    ).rejects.toThrow("no qualified runtime adapter");
  });
});
