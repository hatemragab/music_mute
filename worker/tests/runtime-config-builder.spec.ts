import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServiceRuntimeConfig } from "../src/enrollment/runtime-config-builder.js";
import { createMacServiceLayout } from "../src/platform/macos/launchd.js";
import { loadRuntimeConfig } from "../src/runtime/runtime-config.js";

const MACHINE_ID = "00000000-0000-4000-8000-000000000010";
const WORKER_ID = "00000000-0000-4000-8000-000000000011";
const CREDENTIAL = "a".repeat(43);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("service runtime config builder", () => {
  it("builds a loadable Mac CoreML config from the service layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-config-"));
    roots.push(root);
    const layout = createMacServiceLayout(root);
    await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
    await writeFile(layout.credentialPath, `${CREDENTIAL}\n`, { mode: 0o600 });
    const document = buildServiceRuntimeConfig({
      platform: "darwin-arm64",
      backendBaseUrl: "https://api.musicmute.test/api",
      machineId: MACHINE_ID,
      workerId: WORKER_ID,
      installRoot: root,
    });
    const configPath = join(root, "runtime-source.json");
    await writeFile(configPath, `${JSON.stringify(document)}\n`, {
      mode: 0o600,
    });

    const loaded = await loadRuntimeConfig(configPath, {
      platform: "darwin",
      arch: "arm64",
    });
    expect(loaded).toMatchObject({
      backendBaseUrl: "https://api.musicmute.test/api/",
      machineId: MACHINE_ID,
      credential: CREDENTIAL,
      engineRoot: layout.engineRoot,
      slots: [
        {
          workerId: WORKER_ID,
          gpuId: "gpu0",
          provider: "coreml",
          slotIndex: 0,
        },
      ],
    });
    expect(loaded.slots[0]?.recipeIds).toHaveLength(4);
  });

  it("builds the fixed Windows DirectML adapter-0 config", () => {
    const document = buildServiceRuntimeConfig({
      platform: "windows-amd64",
      backendBaseUrl: "https://api.musicmute.test/api/",
      machineId: MACHINE_ID,
      workerId: WORKER_ID,
      installRoot: "C:\\ProgramData\\MusicMuteWorker",
      releaseVersion: "0.1.1",
    });

    expect(document).toMatchObject({
      credentialFile:
        "C:\\ProgramData\\MusicMuteWorker\\state\\machine.credential",
      engineRoot: win32.join(
        "C:\\ProgramData\\MusicMuteWorker",
        "releases",
        "0.1.1",
        "app",
        "engine",
      ),
      slots: [
        {
          workerId: WORKER_ID,
          gpuId: "gpu0",
          provider: "directml",
          directmlDeviceId: 0,
          slotIndex: 0,
        },
      ],
    });
    expect(document.slots[0].recipeIds).toHaveLength(4);
  });

  it("fails closed on unsafe URLs and inconsistent platform inputs", () => {
    expect(() =>
      buildServiceRuntimeConfig({
        platform: "darwin-arm64",
        backendBaseUrl: "http://api.musicmute.test/api",
        machineId: MACHINE_ID,
        workerId: WORKER_ID,
      }),
    ).toThrow("Service backend URL is unsafe");
    expect(() =>
      buildServiceRuntimeConfig({
        platform: "windows-amd64",
        backendBaseUrl: "http://127.0.0.1:3000/api",
        machineId: MACHINE_ID,
        workerId: WORKER_ID,
        allowInsecureLoopback: true,
      }),
    ).toThrow("Windows runtime config requires a release version");
    expect(() =>
      buildServiceRuntimeConfig({
        platform: "darwin-arm64",
        backendBaseUrl: "https://api.musicmute.test/api",
        machineId: MACHINE_ID,
        workerId: WORKER_ID,
        releaseVersion: "0.1.1",
      }),
    ).toThrow("Mac runtime config does not accept a release version");
  });
});
