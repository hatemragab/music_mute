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
import { createEnrollmentReport } from "../src/enrollment/report-builder.js";
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
  it("derives the Mac report from a verified release, doctor and host GPU", async () => {
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
        providerRuntimeVersion: "onnxruntime 1.30.0",
      },
      capabilities: [
        {
          platform: "darwin-arm64",
          provider: "coreml",
          gpuId: "gpu0",
          maxSlots: 1,
        },
      ],
    });
    expect(report.capabilities[0]?.recipeIds).toHaveLength(4);
    expect(report.runtime.manifestDigest).toBe(
      createHash("sha256")
        .update(await readFile(join(release, "release-manifest.json")))
        .digest("hex"),
    );
  });

  it("uses the service-qualified runtime diagnostics without a second input file", async () => {
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

    expect(report.runtime.providerRuntimeVersion).toBe("onnxruntime 1.30.0");
    expect(report.capabilities[0]).toMatchObject({
      platform: "darwin-arm64",
      provider: "coreml",
      maxSlots: 1,
    });
  });

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

  it("rejects doctor-only or CPU-fallback qualification evidence", async () => {
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
          expectedProvider: "CoreMLExecutionProvider",
          profileCount: 1,
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
  });
});

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
    '{"name":"@musicmute/worker","version":"0.1.0"}\n',
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
    provider:
      platform === "darwin"
        ? "CoreMLExecutionProvider"
        : "DmlExecutionProvider",
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
  const provider = platform === "darwin-arm64" ? "coreml" : "directml";
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
      expectedProvider:
        provider === "coreml"
          ? "CoreMLExecutionProvider"
          : "DmlExecutionProvider",
      profileCount: 1,
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
