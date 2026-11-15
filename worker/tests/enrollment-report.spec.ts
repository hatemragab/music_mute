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
import { WORKER_RECIPE_IDS } from "../protocol/v1/protocol.js";
import {
  createEnrollmentReport,
  createWindowsUserReportFromRuntimeObservations,
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
  type DirectmlGpuIdentity,
} from "../src/enrollment/report-builder.js";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import { writeWindowsReleaseManifest } from "../src/platform/windows/release-manifest.js";

const roots: string[] = [];
const modelDigest =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("qualified enrollment report", () => {
  it("builds Windows user report data from reobserved runtime fields without a ZIP or injected command", () => {
    const raw = userQualification("c".repeat(64)),
      report = createWindowsUserReportFromRuntimeObservations(
        runtimeObservations(raw),
      );
    expect(report.runtime).toMatchObject({
      installationProfile: "windows-user",
      workerVersion: "0.1.3",
      manifestDigest: "c".repeat(64),
      modelDigest,
      providerRuntimeVersion: "onnxruntime 1.24.4",
    });
    expect(report.hardware).toMatchObject({
      os: "Windows",
      architecture: "x86_64",
      osBuild: "10.0.19045",
    });
    expect(report.capabilities).toEqual([
      {
        platform: "windows-amd64",
        provider: "directml",
        gpuId: raw.gpuId,
        recipeIds: WORKER_RECIPE_IDS,
        maxSlots: 1,
      },
    ]);
    expect(report.runtime).not.toHaveProperty("archiveDigest");
    expect(report.runtime).not.toHaveProperty("inventorySha256");
  });
  it("rejects stale full GPU identity, recipe catalog, manifest, model or user context in observed report data", () => {
    const valid = runtimeObservations(userQualification("c".repeat(64)));
    for (const changed of [
      {
        ...valid,
        currentGpus: [{ ...gpuIdentity, driverVersion: "32.0.1.2" }],
      },
      { ...valid, currentGpus: [{ ...gpuIdentity, luid: "0000000000000002" }] },
      { ...valid, currentGpus: [gpuIdentity, gpuIdentity] },
      { ...valid, currentGpus: [] },
      {
        ...valid,
        recipeDigests: Object.fromEntries(
          WORKER_RECIPE_IDS.map((recipe) => [recipe, "e".repeat(64)]),
        ) as typeof valid.recipeDigests,
      },
      { ...valid, manifestDigest: "e".repeat(64) },
      { ...valid, modelDigest: "e".repeat(64) },
      { ...valid, expectedUserSid: "S-1-5-21-111-222-333-1002" },
      { ...valid, expectedFixtureDigest: "e".repeat(64) },
      { ...valid, host: { ...valid.host, arch: "arm64" } },
      { ...valid, host: { ...valid.host, release: "10.0.19044" } },
      { ...valid, diagnostics: { ...doctor("win32"), onnxRuntime: "1.25.0" } },
    ])
      expect(() =>
        createWindowsUserReportFromRuntimeObservations(changed),
      ).toThrow();
  });
  it("does not accept CPU fallback or a legacy service qualification as Windows user report evidence", () => {
    const raw = userQualification("c".repeat(64));
    for (const changed of [
      { ...raw, runtimeProfile: "legacy-service", serviceIdentity: "S-1-5-19" },
      {
        ...raw,
        providerDispatch: { ...raw.providerDispatch, cpuNodeEvents: 1 },
      },
      { ...raw, gpuOnlyPolicy: "caller-approved" },
    ])
      expect(() =>
        createWindowsUserReportFromRuntimeObservations(
          runtimeObservations(changed),
        ),
      ).toThrow();
  });
  it("accepts consumer qualification only with the exact expected Windows user and GPU-only receipt", () => {
    const evidence = userQualification("c".repeat(64));
    const context = {
      runtimeProfile: "windows-user" as const,
      expectedUserSid: userSid,
      expectedFixtureDigest: "a".repeat(64),
    };
    expect(parseQualificationEvidence(evidence, context)).toMatchObject({
      runtimeProfile: "windows-user",
      directmlDeviceId: 3,
      serviceIdentity: userSid,
      gpuIdentity,
    });
    expect(() => parseQualificationEvidence(evidence)).toThrow(
      "explicit user context",
    );
    expect(() =>
      parseQualificationEvidence(evidence, {
        ...context,
        expectedUserSid: "S-1-5-21-111-222-333-1002",
      }),
    ).toThrow("service identity");
    for (const invalid of [
      { ...evidence, gpuOnlyPolicy: "allow-cpu" },
      { ...evidence, directmlDeviceId: 0 },
      { ...evidence, gpuId: "gpu0" },
      { ...evidence, gpuIdentity: { ...gpuIdentity, vendorId: 0 } },
      { ...evidence, serviceIdentity: "S-1-5-19" },
      {
        ...evidence,
        providerDispatch: { ...evidence.providerDispatch, cpuNodeEvents: 1 },
      },
    ])
      expect(() => parseQualificationEvidence(invalid, context)).toThrow();
  });

  it("resolves physical qualification across ordinal reorder and rejects driver or hardware changes", () => {
    const moved = { ...gpuIdentity, deviceIndex: 1 };
    expect(resolveQualifiedGpuIdentity(gpuIdentity, [moved])).toEqual(moved);
    for (const value of [
      { ...moved, driverVersion: "32.0.1.2" },
      { ...moved, luid: "0000000000000043" },
    ])
      expect(() => resolveQualifiedGpuIdentity(gpuIdentity, [value])).toThrow(
        "qualification is required",
      );
    expect(() =>
      resolveQualifiedGpuIdentity(gpuIdentity, [
        moved,
        { ...moved, deviceIndex: 2 },
      ]),
    ).toThrow("enumeration is invalid");
  });

  it("reports the actually selected consumer GPU and retains legacy service report boundaries", async () => {
    const root = await temporaryRoot();
    const release = join(root, "release");
    await windowsRelease(release);
    await rm(join(release, "runtime", "service"), { recursive: true });
    await rm(join(release, "installer"), { recursive: true });
    for (const path of [
      "runtime/native/musicmute-native.exe",
      "agent/session-agent.cjs",
      "agent/login-worker.cjs",
      "agent/fleet.cjs",
      "agent/personal.cjs",
      "agent/prepare.cjs",
      "app/engine/musicmute_engine/windows_gpu.py",
      "app/engine/musicmute_engine/provider_adapter.py",
      "app/engine/musicmute_engine/qualification.py",
      "app/engine/musicmute_engine/consumer_personal.py",
    ]) {
      const destination = join(release, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, path);
    }
    await writeWindowsReleaseManifest(release, "0.1.0-user.1", "windows-user");
    const diagnostics = join(root, "diagnostics.json");
    await writeFile(diagnostics, JSON.stringify(doctor("win32")));
    const qualificationPath = join(root, "qualification.json");
    await writeFile(
      qualificationPath,
      JSON.stringify(userQualification(await releaseDigest(release))),
    );
    const command = vi.fn(
      async (_executable: string, _arguments: readonly string[]) =>
        JSON.stringify({
          sid: userSid,
          gpus: [{ ...gpuIdentity, deviceIndex: 1 }],
          recipes: Object.fromEntries(
            userQualification("c".repeat(64)).recipes.map((recipe) => [
              recipe.recipeId,
              recipe.recipeDigest,
            ]),
          ),
        }),
    );
    const report = await createEnrollmentReport({
      releaseRoot: release,
      diagnosticsPath: diagnostics,
      qualificationPath,
      label: "Windows user",
      runtimeProfile: "windows-user",
      expectedUserSid: userSid,
      expectedFixtureDigest: "a".repeat(64),
      host: {
        platform: "win32",
        arch: "x64",
        release: "10.0.19045",
        cpu: "Intel x64",
        memoryBytes: 16_000_000_000,
      },
      command,
    });
    expect(report.runtime.installationProfile).toBe("windows-user");
    expect(report.hardware.gpus).toEqual([
      {
        id: "dxgi-0000000000000042",
        name: "Intel Iris Xe",
        driverVersion: "32.0.1.1",
      },
    ]);
    expect(report.capabilities[0]).toMatchObject({
      gpuId: "dxgi-0000000000000042",
      maxSlots: 1,
    });
    expect(command.mock.calls[0]?.[0]).toBe(
      join(release, "runtime", "python", "python.exe"),
    );
  });
  it("accepts a non-root macOS LaunchAgent user identity", () => {
    const evidence = qualification("darwin-arm64", "c".repeat(64));
    evidence.serviceIdentity = "hatem";
    expect(() => parseQualificationEvidence(evidence)).not.toThrow();
    evidence.serviceIdentity = "root";
    expect(() => parseQualificationEvidence(evidence)).toThrow(
      "service identity is invalid",
    );
  });

  it("accepts the engine's qualified 160 kbps output evidence", () => {
    const evidence = qualification("darwin-arm64", "c".repeat(64));
    const measured = {
      ...evidence,
      recipes: evidence.recipes.map((recipe) => ({
        ...recipe,
        outputBitrateKbps: 160,
      })),
    };
    expect(() => parseQualificationEvidence(measured)).not.toThrow();
    measured.recipes[0]!.outputBitrateKbps = 320;
    expect(() => parseQualificationEvidence(measured)).toThrow(
      "qualification output bitrate",
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "derives the Mac report from a verified release, doctor and host GPU",
    async () => {
      const root = await temporaryRoot();
      const release = join(root, "release");
      await macRelease(release);
      await writeMacReleaseManifest(release, "0.1.0");
      const diagnostics = join(root, "diagnostics.json");
      await writeFile(diagnostics, JSON.stringify(doctor("darwin")));
      const qualificationPath = join(root, "qualification.json");
      await writeFile(
        qualificationPath,
        JSON.stringify(
          qualification("darwin-arm64", await releaseDigest(release)),
        ),
      );
      const command = vi.fn(
        async (_executable: string, _arguments: readonly string[]) =>
          JSON.stringify({
            SPDisplaysDataType: [
              {
                sppci_model: "Apple M4 Pro",
                sppci_cores: "16",
                spdisplays_ndrvs: [{ _name: "External display" }],
              },
            ],
          }),
      );

      const report = await createEnrollmentReport({
        releaseRoot: release,
        diagnosticsPath: diagnostics,
        qualificationPath,
        label: "Mac mini worker",
        host: {
          platform: "darwin",
          arch: "arm64",
          release: "25.6.0",
          cpu: "Apple M4 Pro",
          memoryBytes: 25_769_803_776,
        },
        command,
      });

      expect(command).toHaveBeenCalledWith("/usr/sbin/system_profiler", [
        "SPDisplaysDataType",
        "-json",
      ]);
      expect(report).toMatchObject({
        label: "Mac mini worker",
        hardware: {
          os: "Darwin",
          architecture: "arm64",
          gpus: [
            {
              id: "gpu0",
              name: "Apple M4 Pro",
              driverVersion: "25.6.0",
            },
          ],
        },
        runtime: {
          workerVersion: "0.1.0",
          protocolVersion: 1,
          modelDigest,
          providerRuntimeVersion: "torch 2.14.0",
        },
        capabilities: [
          {
            platform: "darwin-arm64",
            provider: "mps",
            gpuId: "gpu0",
            maxSlots: 1,
          },
        ],
      });
      expect(report.capabilities[0]?.recipeIds).toEqual([
        "kim-vocals-v2",
        "kim-vocals-v2-trim",
      ]);
      expect(report.runtime.manifestDigest).toBe(
        createHash("sha256")
          .update(await readFile(join(release, "release-manifest.json")))
          .digest("hex"),
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "uses the service-qualified runtime diagnostics without a second input file",
    async () => {
      const root = await temporaryRoot();
      const release = join(root, "release");
      await macRelease(release);
      await writeMacReleaseManifest(release, "0.1.0");
      const qualificationPath = join(root, "qualification.json");
      await writeFile(
        qualificationPath,
        JSON.stringify({
          ...qualification("darwin-arm64", await releaseDigest(release)),
          runtimeDiagnostics: doctor("darwin"),
        }),
      );

      const report = await createEnrollmentReport({
        releaseRoot: release,
        qualificationPath,
        label: "Mac mini worker",
        host: {
          platform: "darwin",
          arch: "arm64",
          release: "25.6.0",
          cpu: "Apple M4 Pro",
          memoryBytes: 25_769_803_776,
        },
        command: async () =>
          JSON.stringify({
            SPDisplaysDataType: [{ sppci_model: "Apple M4 Pro" }],
          }),
      });

      expect(report.runtime.providerRuntimeVersion).toBe("torch 2.14.0");
      expect(report.capabilities[0]).toMatchObject({
        platform: "darwin-arm64",
        provider: "mps",
        maxSlots: 1,
      });
    },
  );

  it("selects only the verified Windows RX 580 capability", async () => {
    const root = await temporaryRoot();
    const release = join(root, "release");
    await windowsRelease(release);
    await writeWindowsReleaseManifest(release, "0.1.0");
    const diagnostics = join(root, "diagnostics.json");
    await writeFile(diagnostics, JSON.stringify(doctor("win32")));
    const qualificationPath = join(root, "qualification.json");
    await writeFile(
      qualificationPath,
      JSON.stringify(
        qualification("windows-amd64", await releaseDigest(release)),
      ),
    );
    const command = vi.fn(
      async (_executable: string, _arguments: readonly string[]) =>
        JSON.stringify([
          { Name: "Microsoft Basic Display Adapter", DriverVersion: "1.0" },
          { Name: "Radeon RX 580 Series", DriverVersion: "31.0.21925.1001" },
        ]),
    );

    const report = await createEnrollmentReport({
      releaseRoot: release,
      diagnosticsPath: diagnostics,
      qualificationPath,
      label: "Z440 worker",
      host: {
        platform: "win32",
        arch: "x64",
        release: "10.0.26200",
        cpu: "Intel Xeon E5-1660 v3",
        memoryBytes: 24_000_000_000,
      },
      command,
    });

    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[1]).toContain("-NonInteractive");
    expect(report).toMatchObject({
      hardware: {
        os: "Windows",
        architecture: "x86_64",
        gpus: [
          {
            id: "gpu0",
            name: "Radeon RX 580 Series",
            driverVersion: "31.0.21925.1001",
          },
        ],
      },
      runtime: {
        workerVersion: "0.1.0",
        modelDigest,
        providerRuntimeVersion: "onnxruntime 1.24.4",
      },
      capabilities: [
        {
          platform: "windows-amd64",
          provider: "directml",
          maxSlots: 1,
        },
      ],
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "rejects doctor-only or CPU-fallback qualification evidence",
    async () => {
      const root = await temporaryRoot();
      const release = join(root, "release");
      await macRelease(release);
      await writeMacReleaseManifest(release, "0.1.0");
      const diagnostics = join(root, "diagnostics.json");
      await writeFile(diagnostics, JSON.stringify(doctor("darwin")));
      const qualificationPath = join(root, "qualification.json");
      await writeFile(
        qualificationPath,
        JSON.stringify({
          ...qualification("darwin-arm64", await releaseDigest(release)),
          providerDispatch: {
            expectedProvider: "MPS",
            profileCount: 0,
            acceleratedNodeEvents: 6,
            cpuNodeEvents: 1,
            proven: false,
          },
        }),
      );

      await expect(
        createEnrollmentReport({
          releaseRoot: release,
          diagnosticsPath: diagnostics,
          qualificationPath,
          label: "Mac mini worker",
          host: {
            platform: "darwin",
            arch: "arm64",
            release: "25.6.0",
            cpu: "Apple M4 Pro",
            memoryBytes: 25_769_803_776,
          },
        }),
      ).rejects.toThrow("Accelerated provider dispatch was not proven");
    },
  );
});

const userSid = "S-1-5-21-111-222-333-1001";
function runtimeObservations(raw: ReturnType<typeof userQualification>) {
  return {
    label: "Store Windows user",
    host: {
      platform: "win32" as const,
      arch: "x64",
      release: "10.0.19045",
      cpu: "Intel x64",
      memoryBytes: 16_000_000_000,
    },
    expectedUserSid: userSid,
    expectedFixtureDigest: "a".repeat(64),
    workerVersion: "0.1.3",
    manifestDigest: "c".repeat(64),
    modelDigest,
    diagnostics: doctor("win32"),
    qualification: raw,
    currentGpus: [gpuIdentity],
    recipeDigests: Object.fromEntries(
      raw.recipes.map((row) => [row.recipeId, row.recipeDigest]),
    ) as Record<(typeof WORKER_RECIPE_IDS)[number], string>,
  };
}
const gpuIdentity: DirectmlGpuIdentity = {
  source: "DXGI EnumAdapters1/GetDesc1",
  deviceIndex: 3,
  name: "Intel Iris Xe",
  vendorId: 32902,
  deviceId: 1234,
  subsystemId: 5678,
  revision: 1,
  driverVersion: "32.0.1.1",
  luid: "0000000000000042",
  dedicatedVideoMemoryBytes: 0,
  sharedSystemMemoryLimitBytes: 8_000_000_000,
};

function userQualification(manifestDigest: string) {
  return {
    ...qualification("windows-amd64", manifestDigest),
    runtimeDiagnostics: doctor("win32"),
    runtimeProfile: "windows-user",
    serviceIdentity: userSid,
    gpuId: `dxgi-${gpuIdentity.luid}`,
    directmlDeviceId: gpuIdentity.deviceIndex,
    gpuIdentity,
    gpuOnlyPolicy: "onnxruntime-disable-cpu-fallback-v1",
    resourceObservations: {
      inferenceSlots: 1,
      dedicatedVideoMemoryLimitBytes: gpuIdentity.dedicatedVideoMemoryBytes,
      sharedSystemMemoryLimitBytes: gpuIdentity.sharedSystemMemoryLimitBytes,
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-report-"));
  roots.push(root);
  return root;
}

async function macRelease(root: string): Promise<void> {
  const executables = [
    "app/dist/src/cli/main.js",
    "runtime/node/bin/node",
    "runtime/python/bin/python3.13",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
  ];
  for (const path of executables) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(absolute, 0o755);
  }
  await symlink(
    "python3.13",
    join(root, "runtime", "python", "bin", "python3"),
  );
  await commonReleaseFiles(root);
}

async function windowsRelease(root: string): Promise<void> {
  const files = [
    "app/dist/src/cli/main.js",
    "installer/manage-windows-service.ps1",
    "runtime/node/node.exe",
    "runtime/python/python.exe",
    "runtime/bin/ffmpeg.exe",
    "runtime/bin/ffprobe.exe",
    "runtime/service/MusicMuteWorkerService.exe",
    "runtime/service/LICENSE.txt",
    "runtime/service/source-manifest.json",
  ];
  for (const path of files) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `${path}\n`);
  }
  await commonReleaseFiles(root);
}

async function commonReleaseFiles(root: string): Promise<void> {
  await mkdir(join(root, "app", "engine"), { recursive: true });
  await writeFile(join(root, "app", "engine", "module.py"), "VALUE = 1\n");
  await writeFile(
    join(root, "app", "package.json"),
    '{"name":"@music-mute/worker","version":"0.1.0"}\n',
  );
  for (const [path, contents] of [
    ["runtime/licenses/ffmpeg/COPYING.LGPLv2.1", "FFmpeg license\n"],
    ["runtime/licenses/lame/COPYING", "LAME license\n"],
    ["runtime/media-source-manifest.json", '{"schemaVersion":1}\n'],
  ] as const) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}

function doctor(platform: "darwin" | "win32") {
  return {
    status: "ok",
    platform,
    architecture: platform === "darwin" ? "arm64" : "x64",
    python: platform === "darwin" ? "3.13.7" : "3.12.10",
    onnxRuntime: platform === "darwin" ? "1.30.0" : "1.24.4",
    audioSeparator: "0.47.0",
    provider: platform === "darwin" ? "MPS" : "DmlExecutionProvider",
    ...(platform === "darwin" ? { torch: "2.14.0" } : {}),
    modelSha256: modelDigest,
    modelBytes: 66_759_214,
    ffmpeg: "ffmpeg version 8.0.3 MusicMute",
    ffprobe: "ffprobe version 8.0.3 MusicMute",
    modelPath: "/protected/models/Kim_Vocal_2.onnx",
  };
}

async function releaseDigest(release: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(join(release, "release-manifest.json")))
    .digest("hex");
}

function qualification(
  platform: "darwin-arm64" | "windows-amd64",
  releaseManifestDigest: string,
) {
  const provider = platform === "darwin-arm64" ? "mps" : "directml";
  return {
    schemaVersion: 1,
    status: "PASS",
    platform,
    provider,
    gpuId: "gpu0",
    directmlDeviceId: 0,
    serviceIdentity: platform === "darwin-arm64" ? "_musicmute" : "S-1-5-19",
    releaseManifestDigest,
    modelDigest,
    fixtureDigest: "a".repeat(64),
    providerDispatch: {
      expectedProvider: provider === "mps" ? "MPS" : "DmlExecutionProvider",
      profileCount: provider === "mps" ? 0 : 1,
      acceleratedNodeEvents: 6,
      cpuNodeEvents: 0,
      proven: true,
    },
    recipes: WORKER_RECIPE_IDS.map((recipeId, index) => ({
      recipeId,
      recipeDigest: `${index}`.repeat(64),
      resultDigest: `${index + 4}`.repeat(64),
      resultBytes: 10_000 + index,
      sourceDurationSeconds: 6,
      outputDurationSeconds: 5.5,
      endToEndSeconds: 2 + index,
    })),
    uploadCandidate: {
      path:
        platform === "darwin-arm64"
          ? "/Library/Application Support/MusicMute/attempts/qualification.mp3"
          : "C:\\ProgramData\\MusicMute\\attempts\\qualification.mp3",
      resultDigest: "4".repeat(64),
      resultBytes: 10_000,
      contentType: "audio/mpeg",
    },
    totalSeconds: 20,
  };
}
