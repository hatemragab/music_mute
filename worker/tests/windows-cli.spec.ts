import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runWindowsCommand,
  type WindowsCommandRuntime,
} from "../src/platform/windows/cli.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Windows CLI qualification", () => {
  it("accepts only complete DirectML LocalService evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-windows-cli-"));
    roots.push(root);
    const reportPath = join(root, "qualification.json");
    const fixtureSha256 = "a".repeat(64);
    await writeFile(
      reportPath,
      `${JSON.stringify(qualificationReport(fixtureSha256))}\n`,
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runWindowsCommand([
      "qualification-check",
      "--report",
      reportPath,
      "--fixture-sha256",
      fixtureSha256,
    ]);

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      status: "ok",
      action: "qualification-check",
      recipeCount: 4,
    });
  });

  it("rejects CPU fallback qualification evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-windows-cli-"));
    roots.push(root);
    const reportPath = join(root, "qualification.json");
    const fixtureSha256 = "b".repeat(64);
    const report = qualificationReport(fixtureSha256);
    report.providerDispatch.cpuNodeEvents = 1;
    await writeFile(reportPath, `${JSON.stringify(report)}\n`);

    await expect(
      runWindowsCommand([
        "qualification-check",
        "--report",
        reportPath,
        "--fixture-sha256",
        fixtureSha256,
      ]),
    ).rejects.toThrow("Accelerated provider dispatch was not proven");
  });
});

describe("Windows CLI bootstrap", () => {
  it("prepares, stages, enrolls and installs with optional flags omitted", async () => {
    const calls = {
      prepare: [] as string[][],
      enroll: [] as string[][],
      service: [] as Array<{ scriptPath: string; arguments_: string[] }>,
    };
    const runtime = bootstrapRuntime(calls, false);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runWindowsCommand(
      [
        "bootstrap",
        "--backend-url",
        "http://127.0.0.1:3100",
        "--enrollment-file",
        "C:\\MusicMutePrivate\\enrollment.credential",
        "--output",
        "C:\\MusicMutePrivate\\bootstrap",
        "--label",
        "z440",
      ],
      runtime,
    );

    expect(calls.prepare).toHaveLength(1);
    expect(calls.prepare[0]).toContain("windows-amd64");
    expect(calls.enroll).toHaveLength(1);
    expect(calls.enroll[0]).not.toContain("--group-id");
    expect(calls.service).toHaveLength(2);
    expect(calls.service[0]?.arguments_).toContain("Stage");
    expect(calls.service[0]?.arguments_).toContain("-QualificationOutput");
    expect(calls.service[1]?.arguments_).toContain("Install");
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual({
      status: "ok",
      action: "bootstrap",
      releaseVersion: "0.1.3",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    });
  });

  it("reuses an existing qualification report on a safe retry", async () => {
    const calls = {
      prepare: [] as string[][],
      enroll: [] as string[][],
      service: [] as Array<{ scriptPath: string; arguments_: string[] }>,
    };

    await runWindowsCommand(
      [
        "bootstrap",
        "--backend-url",
        "https://workers.example.test",
        "--enrollment-file",
        "C:\\MusicMutePrivate\\enrollment.credential",
        "--output",
        "C:\\MusicMutePrivate\\bootstrap",
        "--label",
        "z440",
        "--group-id",
        "primary",
      ],
      bootstrapRuntime(calls, true),
    );

    expect(calls.service).toHaveLength(1);
    expect(calls.service[0]?.arguments_).toContain("Install");
    expect(calls.enroll[0]).toEqual(
      expect.arrayContaining(["--group-id", "primary"]),
    );
  });
});

function bootstrapRuntime(
  calls: {
    prepare: string[][];
    enroll: string[][];
    service: Array<{ scriptPath: string; arguments_: string[] }>;
  },
  qualificationExists: boolean,
): WindowsCommandRuntime {
  const digest = "a".repeat(64);
  return {
    platform: "win32",
    architecture: "x64",
    prepareInstallation(arguments_) {
      calls.prepare.push(arguments_);
      return Promise.resolve();
    },
    readInstallationReceipt() {
      return Promise.resolve({
        schemaVersion: 1,
        installationId: "123e4567-e89b-42d3-a456-426614174000",
        platform: "windows-amd64",
        releaseVersion: "0.1.3",
        release: {
          path: "C:\\MusicMutePrivate\\bootstrap\\installation-artifacts\\release.zip",
          releaseRoot:
            "C:\\MusicMutePrivate\\bootstrap\\installation-artifacts\\releases\\0.1.3",
          bytes: 1,
          sha256: digest,
          contentType: "application/zip",
        },
        model: {
          path: "C:\\MusicMutePrivate\\bootstrap\\installation-artifacts\\Kim_Vocal_2.onnx",
          bytes: 1,
          sha256: digest,
          contentType: "application/octet-stream",
        },
        fixture: {
          path: "C:\\MusicMutePrivate\\bootstrap\\installation-artifacts\\fixture.wav",
          bytes: 1,
          sha256: digest,
          contentType: "audio/wav",
        },
      });
    },
    enroll(arguments_) {
      calls.enroll.push(arguments_);
      return Promise.resolve();
    },
    privateFileExists() {
      return Promise.resolve(qualificationExists);
    },
    runServiceManager(scriptPath, arguments_) {
      calls.service.push({ scriptPath, arguments_ });
      return Promise.resolve();
    },
  };
}

function qualificationReport(fixtureDigest: string) {
  return {
    schemaVersion: 1,
    status: "PASS",
    platform: "windows-amd64",
    provider: "directml",
    gpuId: "gpu0",
    directmlDeviceId: 0,
    serviceIdentity: "S-1-5-19",
    releaseManifestDigest: "c".repeat(64),
    modelDigest: "d".repeat(64),
    fixtureDigest,
    providerDispatch: {
      expectedProvider: "DmlExecutionProvider",
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
      recipeDigest: "e".repeat(64),
      resultDigest: "f".repeat(64),
      resultBytes: 1,
      sourceDurationSeconds: 1,
      outputDurationSeconds: 1,
      endToEndSeconds: 1,
    })),
    uploadCandidate: {
      path: "C:\\ProgramData\\MusicMute\\attempts\\qualification.mp3",
      resultDigest: "f".repeat(64),
      resultBytes: 1,
      contentType: "audio/mpeg",
    },
    totalSeconds: 4,
  };
}
