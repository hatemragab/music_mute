import { access, rm } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { createWindowsBrowserToolkit } from "../src/main/browser/toolkit-factory.js";
import { WindowsDiagnosticDoctorRunner } from "../src/main/diagnostics/doctor.js";
import { diagnosticFixture } from "./diagnostics-fixtures.js";
import { processIdentity } from "./fleet-advanced-fixtures.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { MediaShutdownPending } from "../src/main/prepare/owned-media-operation.js";
import type { CloudScratchAdmission } from "../src/main/cloud/workspace.js";
import type { ConsumerOwnedProcess } from "../../worker/src/platform/windows/consumer-native.js";
const boundary = vi.hoisted(() => ({ owned: vi.fn(), hash: vi.fn() }));
vi.mock("../src/main/prepare/owned-media-operation.js", async () => ({
  ...(await vi.importActual<
    typeof import("../src/main/prepare/owned-media-operation.js")
  >("../src/main/prepare/owned-media-operation.js")),
  runOwnedMediaOperation: boundary.owned,
}));
vi.mock("../src/main/prepare/private-files.js", async () => ({
  ...(await vi.importActual<
    typeof import("../src/main/prepare/private-files.js")
  >("../src/main/prepare/private-files.js")),
  hashPrivateFile: boundary.hash,
}));
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
function admission(events: string[]): CloudScratchAdmission {
  return {
    beginWrite: async (relative) => {
      events.push(`writer:${relative}`);
      return {
        captureCreated: async () => {},
        handoff: async () => {},
        settle: async () => {
          events.push(`settled:${relative}`);
        },
        preparePublish: async () => {
          throw new Error("not a publisher");
        },
      };
    },
    protectTree: async () => ({ release: async () => {} }),
    reserveScratch: async () => ({
      handoff: async () => {},
      bind: async () => {},
      release: async () => {},
    }),
    trackWorkspace: async () => ({
      release: async () => {},
      retireForRelaunch: async () => {},
    }),
  };
}
const tools = {
  snapshotMediaTools: async () => ({
    releaseRoot: `C:\\runtime\\${"a".repeat(64)}`,
    manifestSha256: "b".repeat(64),
    nativeSha256: "c".repeat(64),
    ffmpegPath: "fixed",
    ffprobePath: "fixed",
  }),
};
type Tools = typeof tools;
type Operation = {
  tools: Tools;
  signal: AbortSignal;
  configuration(
    tools: Awaited<ReturnType<Tools["snapshotMediaTools"]>>,
  ): Record<string, unknown>;
  parse(value: unknown, configuration: unknown): unknown;
  beforeLaunch(): Promise<void>;
  onOwner(owner: ConsumerOwnedProcess): Promise<void>;
};
async function result(o: Operation) {
  const c = o.configuration(await o.tools.snapshotMediaTools()),
    { helperSha256: _helper, ...base } = c;
  await o.beforeLaunch();
  await o.onOwner({
    role: "prepare",
    nonce: "a".repeat(64),
    identity: { ...processIdentity, pid: 12347 },
  });
  return c.operation === "diagnostics_doctor"
    ? o.parse(
        {
          ...base,
          nodeAccepted: true,
          pythonAccepted: true,
          directmlAvailable: true,
          engineProtocolAccepted: true,
          mediaToolsAccepted: true,
          gpuCount: 1,
          inferencePerformed: false,
          networkRequests: 0,
        },
        c,
      )
    : o.parse(
        {
          ...base,
          passed: true,
          errorCode: null,
          inferencePerformed: false,
          networkRequests: 0,
        },
        c,
      );
}
beforeEach(() => {
  boundary.owned.mockReset();
  boundary.hash.mockReset();
  boundary.hash.mockResolvedValue(MODEL.sha256);
});
it("Chrome CHECK uses the same production Doctor class but never recovers another live UI Doctor", async () => {
  const f = await diagnosticFixture(),
    events: string[] = [],
    storage = admission(events),
    ui = new WindowsDiagnosticDoctorRunner(f.host, tools, storage),
    toolkit = createWindowsBrowserToolkit({
      packageIdentity: "d".repeat(64),
      host: f.host,
      operations: tools,
      storage,
      clearCache: async () => {},
      recordEvent: () => {},
    });
  let releaseUi!: (value: unknown) => void;
  boundary.owned
    .mockImplementationOnce(async (o: Operation) => {
      const report = await result(o);
      return new Promise((r) => {
        releaseUi = () => r(report);
      });
    })
    .mockImplementation(result);
  const running = ui.run(true, new AbortController().signal);
  try {
    await vi.waitFor(() =>
      expect(ui.activity()).toEqual({ pending: 1, retained: 1, idle: false }),
    );
    const uiPath = events.find((v) => v.startsWith("writer:"))!.slice(7);
    await vi.waitFor(() => expect(releaseUi).toBeTypeOf("function"));
    const report = await toolkit.startCheck(
      new AbortController().signal,
      () => {},
    ).done;
    expect(report.state).toBe("passed");
    expect(report.installation_id).toBe("d".repeat(64));
    expect(ui.activity()).toEqual({ pending: 1, retained: 1, idle: false });
    expect(events).not.toContain(`settled:${uiPath}`);
    await access(f.path(uiPath));
    expect(toolkit.activity().idle).toBe(true);
    releaseUi(undefined);
    await running;
    expect(events).toContain(`settled:${uiPath}`);
    boundary.hash.mockResolvedValue("f".repeat(64));
    const second = await toolkit.startCheck(
      new AbortController().signal,
      () => {},
    ).done;
    expect(second.checks[1]).toMatchObject({
      state: "failed",
      error_code: "MODEL_NOT_READY",
    });
    expect(boundary.hash).toHaveBeenCalledTimes(3);
  } finally {
    releaseUi?.(undefined);
    await running.catch(() => {});
    await toolkit.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("uncertain owned-tool shutdown retains CHECK activity and workspace until positive whole-Job proof", async () => {
  const f = await diagnosticFixture(),
    events: string[] = [],
    toolkit = createWindowsBrowserToolkit({
      packageIdentity: "d".repeat(64),
      host: f.host,
      operations: tools,
      storage: admission(events),
      clearCache: async () => {},
      recordEvent: () => {},
    });
  f.native.ownedTreeExited.mockResolvedValue(false);
  boundary.owned.mockImplementation(async (o: Operation) => {
    const c = o.configuration(await o.tools.snapshotMediaTools());
    if (c.operation === "diagnostics_doctor") return result(o);
    await o.beforeLaunch();
    await o.onOwner({
      role: "prepare",
      nonce: "b".repeat(64),
      identity: { ...processIdentity, pid: 12348 },
    });
    throw new MediaShutdownPending();
  });
  try {
    const result = await toolkit.startCheck(
      new AbortController().signal,
      () => {},
    ).done;
    expect(result.checks[2]).toMatchObject({
      state: "failed",
      error_code: "STORAGE_RECOVERY_PENDING",
    });
    expect(toolkit.activity()).toEqual({
      pending: 0,
      retained: 1,
      idle: false,
    });
    await expect(toolkit.dispose()).rejects.toThrow("STORAGE_RECOVERY_PENDING");
    expect(toolkit.activity().retained).toBe(1);
    f.native.ownedTreeExited.mockResolvedValue(true);
    await toolkit.dispose();
    expect(toolkit.activity().idle).toBe(true);
  } finally {
    f.native.ownedTreeExited.mockResolvedValue(true);
    await toolkit.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});
