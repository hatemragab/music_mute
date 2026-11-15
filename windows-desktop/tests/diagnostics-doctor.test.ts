import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { WindowsDiagnosticDoctorRunner } from "../src/main/diagnostics/doctor.js";
import {
  parseDiagnosticDoctorConfiguration,
  parseDiagnosticDoctorResult,
  runDiagnosticDoctorChild,
  type DiagnosticDoctorConfiguration,
} from "../src/main/diagnostics/doctor-child.js";
import { MediaShutdownPending } from "../src/main/prepare/owned-media-operation.js";
import type { CloudScratchAdmission } from "../src/main/cloud/workspace.js";
import { diagnosticFixture } from "./diagnostics-fixtures.js";
import { processIdentity } from "./fleet-advanced-fixtures.js";
import type { ConsumerOwnedProcess } from "../../worker/src/platform/windows/consumer-native.js";
const harness = vi.hoisted(() => ({ owned: vi.fn() }));
vi.mock("../src/main/prepare/owned-media-operation.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/main/prepare/owned-media-operation.js")
  >("../src/main/prepare/owned-media-operation.js");
  return { ...actual, runOwnedMediaOperation: harness.owned };
});
vi.mock("node:path", async () => {
  const a = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...a,
    win32: {
      ...a.win32,
      join: (...p: string[]) => a.join(...p.flatMap((v) => v.split("\\"))),
    },
  };
});
const configuration = (): DiagnosticDoctorConfiguration => ({
  version: 1,
  operation: "diagnostics_doctor",
  requestId: randomUUID(),
  executionId: randomUUID(),
  release: "a".repeat(64),
  sid: processIdentity.sid,
  manifestSha256: "b".repeat(64),
  helperSha256: "c".repeat(64),
});
const result = (c: DiagnosticDoctorConfiguration) => ({
  ...c,
  nodeAccepted: true,
  pythonAccepted: true,
  directmlAvailable: true,
  engineProtocolAccepted: true,
  mediaToolsAccepted: true,
  gpuCount: 1,
  inferencePerformed: false,
  networkRequests: 0,
});
function childResult(c: DiagnosticDoctorConfiguration) {
  const { helperSha256: _helper, ...value } = result(c);
  return value;
}
type Operation = {
  host: unknown;
  tools: {
    snapshotMediaTools(signal: AbortSignal): Promise<{
      releaseRoot: string;
      manifestSha256: string;
      nativeSha256: string;
    }>;
  };
  signal: AbortSignal;
  configuration(v: unknown): DiagnosticDoctorConfiguration;
  beforeLaunch(): Promise<void>;
  onOwner(owner: ConsumerOwnedProcess): Promise<void>;
  parse(value: unknown, c: DiagnosticDoctorConfiguration): unknown;
};
function admission(events: string[]): CloudScratchAdmission {
  return {
    beginWrite: async () => {
      events.push("writer");
      return {
        captureCreated: async () => {
          events.push("birth");
        },
        handoff: async () => {
          events.push("writer-handoff");
        },
        settle: async () => {
          events.push("settle");
        },
        preparePublish: async () => {
          throw new Error("not a media publisher");
        },
      };
    },
    protectTree: async () => ({
      release: async () => {
        events.push("pin-release");
      },
    }),
    reserveScratch: async () => {
      events.push("reserve");
      return {
        handoff: async () => {
          events.push("reservation-handoff");
        },
        bind: async () => {
          events.push("bind-owner");
        },
        release: async () => {
          events.push("reservation-release");
        },
      };
    },
    trackWorkspace: async () => {
      events.push("track-owner");
      return {
        release: async () => {
          events.push("native-pin-release");
        },
        retireForRelaunch: async () => {},
      };
    },
  };
}
it("cold Doctor hands bounded Node scratch to the owned CPU Job before inspection and never calls model readiness", async () => {
  const f = await diagnosticFixture(),
    events: string[] = [],
    tools = {
      snapshotMediaTools: vi.fn(async () => ({
        releaseRoot: `C:\\runtime\\${"a".repeat(64)}`,
        manifestSha256: "b".repeat(64),
        nativeSha256: "c".repeat(64),
        ffmpegPath: "fixed",
        ffprobePath: "fixed",
      })),
    },
    runner = new WindowsDiagnosticDoctorRunner(
      f.host,
      tools,
      admission(events),
    );
  try {
    harness.owned.mockImplementation(async (o: Operation) => {
      const c = o.configuration(await o.tools.snapshotMediaTools(o.signal));
      await o.beforeLaunch();
      events.push("launch");
      await o.onOwner({
        role: "prepare",
        nonce: "a".repeat(64),
        identity: { ...processIdentity, pid: 12347 },
      });
      return o.parse(childResult(c), c);
    });
    const report = await runner.run(false, new AbortController().signal);
    expect(report).toMatchObject({
      inferencePerformed: false,
      networkRequests: 0,
      verifiedModelSha256: null,
      directmlAvailable: true,
    });
    expect(report.checks).toContainEqual({
      name: "model-bytes",
      status: "not-run",
      code: "MODEL_NOT_READY",
    });
    expect(events.indexOf("reserve")).toBeLessThan(events.indexOf("writer"));
    expect(events.indexOf("birth")).toBeLessThan(
      events.indexOf("writer-handoff"),
    );
    expect(events.indexOf("writer-handoff")).toBeLessThan(
      events.indexOf("launch"),
    );
    expect(events.indexOf("bind-owner")).toBeLessThan(
      events.indexOf("reservation-release"),
    );
    expect(runner.activity().idle).toBe(true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("uncertain CPU shutdown retains workspace/activity until the exact owner tree exit is proven", async () => {
  const f = await diagnosticFixture(),
    events: string[] = [],
    runner = new WindowsDiagnosticDoctorRunner(
      f.host,
      {
        snapshotMediaTools: async () => ({
          releaseRoot: `C:\\runtime\\${"a".repeat(64)}`,
          manifestSha256: "b".repeat(64),
          nativeSha256: "c".repeat(64),
          ffmpegPath: "fixed",
          ffprobePath: "fixed",
        }),
      },
      admission(events),
    );
  try {
    f.native.ownedTreeExited.mockResolvedValue(false);
    harness.owned.mockImplementation(async (o: Operation) => {
      await o.beforeLaunch();
      await o.onOwner({
        role: "prepare",
        nonce: "a".repeat(64),
        identity: { ...processIdentity, pid: 12347 },
      });
      throw new MediaShutdownPending();
    });
    await expect(
      runner.run(false, new AbortController().signal),
    ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
    expect(runner.activity()).toEqual({ pending: 0, retained: 1, idle: false });
    expect(events).not.toContain("reservation-release");
    f.native.ownedTreeExited.mockResolvedValue(true);
    await runner.recover();
    expect(runner.activity().idle).toBe(true);
    expect(events).toContain("reservation-release");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("fixed child uses only private signed executables and offline module metadata; hostile stdout never persists", async () => {
  const f = await diagnosticFixture(),
    c = configuration(),
    calls: { file: string; args: string[] }[] = [];
  try {
    await f.host.directory(`cloud\\work\\${c.requestId}`);
    await runDiagnosticDoctorChild(
      f.host,
      c,
      `C:\\runtime\\${c.release}`,
      async (file, args, options) => {
        calls.push({ file, args });
        expect(options.env).not.toHaveProperty("GOOGLE_TOKEN");
        expect(options.env).not.toHaveProperty("MUSICMUTE_OWNERSHIP_NONCE");
        return {
          stdout:
            calls.length === 1
              ? "Bearer private-token C:\\Users\\private"
              : '{"mediaToolsAccepted":true}',
        };
      },
    );
    const bytes = await readFile(
        f.path(`cloud\\work\\${c.requestId}\\doctor-result.json`),
        "utf8",
      ),
      parsed = parseDiagnosticDoctorResult(JSON.parse(bytes), c);
    expect(parsed).toMatchObject({
      pythonAccepted: false,
      engineProtocolAccepted: false,
      mediaToolsAccepted: true,
      inferencePerformed: false,
      networkRequests: 0,
    });
    expect(bytes).not.toContain("private-token");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.file).toBe(
        `C:/runtime/${c.release}/runtime/python/python.exe`,
      );
      expect(call.args[0]).toBe("-I");
      expect(call.args.join(" ")).not.toContain("InferenceSession");
      expect(call.args.join(" ")).not.toContain("model-cache");
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("closed Doctor config and result reject inference/fallback/private fields and stale producer binding", () => {
  const c = configuration();
  expect(parseDiagnosticDoctorConfiguration(c)).toEqual(c);
  expect(parseDiagnosticDoctorResult(childResult(c), c)).toMatchObject({
    inferencePerformed: false,
  });
  for (const value of [
    { ...c, gpu: 0 },
    { ...c, executable: "cmd.exe" },
    { ...c, operation: "qualify" },
    { ...c, sid: "S-1-5-19" },
  ])
    expect(() => parseDiagnosticDoctorConfiguration(value)).toThrow(
      "DIAGNOSTICS_CONFIG_INVALID",
    );
  for (const v of [
    { ...childResult(c), sid: "S-1-5-19" },
    { ...childResult(c), inferencePerformed: true },
    { ...childResult(c), networkRequests: 1 },
    { ...childResult(c), executionId: randomUUID() },
    { ...childResult(c), stderr: "Bearer secret" },
  ])
    expect(() => parseDiagnosticDoctorResult(v, c)).toThrow(
      "DIAGNOSTICS_DOCTOR_INVALID",
    );
});
it("missing runtime remains a truthful native-host/GPU inspection with no scratch, download, model or child execution", async () => {
  const f = await diagnosticFixture(),
    events: string[] = [],
    runner = new WindowsDiagnosticDoctorRunner(
      f.host,
      {
        snapshotMediaTools: async () => {
          throw new Error("RUNTIME_MISSING");
        },
      },
      admission(events),
    );
  try {
    harness.owned.mockClear();
    const report = await runner.run(true, new AbortController().signal);
    expect(report).toMatchObject({
      healthy: false,
      inferencePerformed: false,
      networkRequests: 0,
      verifiedModelSha256: null,
    });
    expect(report.checks).toContainEqual({
      name: "signed-runtime",
      status: "failed",
      code: "SETUP_REQUIRED",
    });
    expect(events).toEqual([]);
    expect(harness.owned).not.toHaveBeenCalled();
    expect(f.native.enumerateGpus).toHaveBeenCalledOnce();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("keeps an active Doctor workspace owned when another run or recovery is requested", async () => {
  const f = await diagnosticFixture(),
    events: string[] = [];
  const tools = {
    snapshotMediaTools: async () => ({
      releaseRoot: `C:\\runtime\\${"a".repeat(64)}`,
      manifestSha256: "b".repeat(64),
      nativeSha256: "c".repeat(64),
      ffmpegPath: "fixed",
      ffprobePath: "fixed",
    }),
  };
  const runner = new WindowsDiagnosticDoctorRunner(
    f.host,
    tools,
    admission(events),
  );
  let entered!: () => void, release!: () => void;
  const begun = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.owned
    .mockImplementationOnce(async (o: Operation) => {
      const c = o.configuration(await o.tools.snapshotMediaTools(o.signal));
      entered();
      await blocked;
      await o.beforeLaunch();
      await o.onOwner({
        role: "prepare",
        nonce: "a".repeat(64),
        identity: { ...processIdentity, pid: 12347 },
      });
      return o.parse(childResult(c), c);
    })
    .mockImplementationOnce(async (o: Operation) => {
      const c = o.configuration(await o.tools.snapshotMediaTools(o.signal));
      return o.parse(childResult(c), c);
    });
  const first = runner.run(false, new AbortController().signal);
  try {
    await begun;
    await expect(
      runner.run(false, new AbortController().signal),
    ).rejects.toThrow("DIAGNOSTICS_BUSY");
    await expect(runner.recover()).rejects.toThrow("DIAGNOSTICS_BUSY");
    expect(runner.activity()).toEqual({ pending: 1, retained: 1, idle: false });
    expect(events).not.toContain("reservation-release");
    expect(events).not.toContain("pin-release");
    release();
    expect(await first).toMatchObject({
      inferencePerformed: false,
      networkRequests: 0,
    });
    expect(runner.activity().idle).toBe(true);
  } finally {
    release();
    await first.catch(() => {});
    await runner.recover().catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
});
