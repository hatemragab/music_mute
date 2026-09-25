import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServiceRuntimeConfig } from "../src/enrollment/runtime-config-builder.js";
import { createMacUserLayout } from "../src/platform/macos/user-paths.js";
import { loadRuntimeConfig } from "../src/runtime/runtime-config.js";

const MACHINE_ID = "00000000-0000-4000-8000-000000000010";
const WORKER_ID = "00000000-0000-4000-8000-000000000011";
const SECOND_WORKER_ID = "00000000-0000-4000-8000-000000000012";
const CREDENTIAL = "a".repeat(43);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("service runtime config builder", () => {
  it("builds a loadable Mac MPS config from the service layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-config-"));
    roots.push(root);
    const layout = createMacUserLayout(root);
    await mkdir(layout.credentialRoot, { recursive: true, mode: 0o700 });
    await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
    await writeFile(layout.credentialPath, `${CREDENTIAL}\n`, { mode: 0o600 });
    const document = buildServiceRuntimeConfig({
      platform: "darwin-arm64",
      backendBaseUrl: "https://api.musicmute.test",
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
      backendBaseUrl: "https://api.musicmute.test/",
      machineId: MACHINE_ID,
      credential: CREDENTIAL,
      validatedMaxWorkersPerGpu: 1,
      engineRoot: layout.engineRoot,
      slots: [
        {
          workerId: WORKER_ID,
          gpuId: "gpu0",
          provider: "mps",
          slotIndex: 0,
        },
      ],
    });
    expect(loaded.slots[0]?.recipeIds).toEqual([
      "kim-vocals-v2",
      "kim-vocals-v2-trim",
    ]);
  });

  it("builds the fixed Windows DirectML adapter-0 config", () => {
    const document = buildServiceRuntimeConfig({
      platform: "windows-amd64",
      backendBaseUrl: "https://api.musicmute.test/",
      machineId: MACHINE_ID,
      workerId: WORKER_ID,
      installRoot: "C:\\ProgramData\\MusicMuteWorker",
      releaseVersion: "0.1.1",
    });

    expect(document).toMatchObject({
      validatedMaxWorkersPerGpu: 1,
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
    expect(document.slots[0].recipeIds).toEqual([
      "kim-vocals-v2",
      "kim-vocals-v2-trim",
    ]);
  });

  it("fails closed on unsafe URLs and inconsistent platform inputs", () => {
    expect(() =>
      buildServiceRuntimeConfig({
        platform: "darwin-arm64",
        backendBaseUrl: "https://api.musicmute.test/old-prefix",
        machineId: MACHINE_ID,
        workerId: WORKER_ID,
      }),
    ).toThrow("API origin");
    expect(() =>
      buildServiceRuntimeConfig({
        platform: "darwin-arm64",
        backendBaseUrl: "http://api.musicmute.test",
        machineId: MACHINE_ID,
        workerId: WORKER_ID,
      }),
    ).toThrow("Service backend URL is unsafe");
    expect(() =>
      buildServiceRuntimeConfig({
        platform: "windows-amd64",
        backendBaseUrl: "http://127.0.0.1:3000",
        machineId: MACHINE_ID,
        workerId: WORKER_ID,
        allowInsecureLoopback: true,
      }),
    ).toThrow("Windows runtime config requires a release version");
    expect(() =>
      buildServiceRuntimeConfig({
        platform: "darwin-arm64",
        backendBaseUrl: "https://api.musicmute.test",
        machineId: MACHINE_ID,
        workerId: WORKER_ID,
        releaseVersion: "0.1.1",
      }),
    ).toThrow("Mac runtime config does not accept a release version");
  });

  it("requires fresh benchmark evidence before allowing two workers per GPU", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-capacity-"));
    roots.push(root);
    const layout = createMacUserLayout(root);
    await mkdir(layout.credentialRoot, { recursive: true, mode: 0o700 });
    await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
    await writeFile(layout.credentialPath, `${CREDENTIAL}\n`, { mode: 0o600 });
    const document = structuredClone(
      buildServiceRuntimeConfig({
        platform: "darwin-arm64",
        backendBaseUrl: "https://api.musicmute.test",
        machineId: MACHINE_ID,
        workerId: WORKER_ID,
        installRoot: root,
      }),
    ) as unknown as {
      validatedMaxWorkersPerGpu: number;
      capacityValidationFile?: string;
      slots: Array<{
        workerId: string;
        gpuId: string;
        slotIndex: number;
        recipeIds: string[];
        provider: string;
      }>;
      [key: string]: unknown;
    };
    document.validatedMaxWorkersPerGpu = 2;
    const firstSlot = document.slots[0]!;
    document.slots.push({
      ...firstSlot,
      workerId: SECOND_WORKER_ID,
      slotIndex: 1,
    });
    const configPath = join(root, "capacity-runtime.json");
    await writeFile(configPath, `${JSON.stringify(document)}\n`, {
      mode: 0o600,
    });
    await expect(
      loadRuntimeConfig(configPath, { platform: "darwin", arch: "arm64" }),
    ).rejects.toThrow("requires benchmark evidence");

    const evidencePath = join(layout.stateRoot, "capacity-validation.json");
    document.capacityValidationFile = evidencePath;
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        schemaVersion: 1,
        status: "PASS",
        machineId: MACHINE_ID,
        validatedMaxWorkersPerGpu: 2,
        baselineSeconds: 10,
        concurrentWallSeconds: 16,
        concurrentWorkerSeconds: [15, 15.5],
        throughputSpeedup: 1.25,
        releaseManifestDigest: "a".repeat(64),
        modelDigest: "b".repeat(64),
        fixtureDigest: "c".repeat(64),
        validatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(configPath, `${JSON.stringify(document)}\n`, {
      mode: 0o600,
    });
    const loaded = await loadRuntimeConfig(configPath, {
      platform: "darwin",
      arch: "arm64",
    });
    expect(loaded.validatedMaxWorkersPerGpu).toBe(2);
    expect(loaded.slots).toHaveLength(2);
  });
});
