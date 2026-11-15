import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import yauzl from "yauzl";
import {
  WindowsFleetInspection,
  type FleetPrivateFiles,
} from "../src/main/fleet/advanced/inspection.js";
import { createFleetDiagnosticArchive } from "../src/main/fleet/advanced/archive.js";
import { sanitizeAdvancedData } from "../src/main/fleet/advanced/controller.js";
import { parseLocalRuntimeStatus } from "../../worker/src/runtime/local-runtime-status.js";
import type { HostContext } from "../src/main/host-context.js";
import { fleetNow, record } from "./fleet-fixtures.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import {
  advancedGpu,
  processIdentity,
  readySnapshot,
} from "./fleet-advanced-fixtures.js";
function fixture() {
  const attemptId = randomUUID(),
    jobId = "a".repeat(24),
    current = { ...processIdentity, pid: 32100 },
    owner = {
      role: "fleet" as const,
      nonce: "a".repeat(64),
      identity: current,
    };
  const events = [
    {
      recordedAt: new Date(fleetNow - 3000).toISOString(),
      event: {
        kind: "attempt-started",
        attemptId,
        jobId,
        attemptNumber: 1,
        provider: "directml",
        authorization: "Bearer secret",
        signed_url: "https://private.invalid?token=secret",
        raw: "secret",
      },
    },
    {
      recordedAt: new Date(fleetNow - 2000).toISOString(),
      event: {
        kind: "attempt-failed",
        attemptId,
        jobId,
        component: "engine",
        code: "GPU_OOM",
        stage: "separation",
        detail: "https://private.invalid?token=secret",
      },
    },
    {
      recordedAt: new Date(fleetNow - 1000).toISOString(),
      event: {
        kind: "attempt-started",
        attemptId: randomUUID(),
        jobId: "b".repeat(24),
        attemptNumber: 1,
      },
    },
  ];
  const status = {
    schemaVersion: 1,
    processId: current.pid,
    activeAttemptIds: [],
    updatedAt: new Date(fleetNow).toISOString(),
    childState: "ready",
    diagnostics: {
      blockedReason: null,
      earliestAvailableAt: new Date(fleetNow - 3000).toISOString(),
      incompleteHistory: true,
      retainedBytes: 1000,
    },
  };
  const content = new Map([
    [
      "logs\\events.jsonl",
      Buffer.from(events.map((event) => JSON.stringify(event)).join("\n")),
    ],
    ["state\\runtime-status.json", Buffer.from(JSON.stringify(status))],
  ]);
  const files: FleetPrivateFiles = {
    root: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteWorker",
    read: vi.fn(async (name) => {
      const bytes = content.get(name);
      if (!bytes)
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return bytes;
    }),
    names: vi.fn(async () => ["events.jsonl", "foreign.env"]),
  };
  const host = {
    identity: processIdentity,
    native: {
      vaultRead: vi.fn(async (_namespace: string, key: string) =>
        key === "fleet_ticket"
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                owner,
                server: { ...current, pid: 32101 },
                channel: "b".repeat(64),
                nonce: "c".repeat(64),
                expiresAt: fleetNow + 30000,
              }),
            )
          : null,
      ),
      bootIdentity: vi.fn(async () => readySnapshot().bootIdentity),
      enumerateGpus: vi.fn(async () => [advancedGpu]),
    },
    processIdentity: vi.fn(async () => ({ ...current })),
  } as unknown as HostContext;
  const native = { isOwnedProcess: vi.fn(async () => true) },
    session = {
      command: vi.fn(async () => ({
        fleet: { intent: "paused", phase: "paused", problem: null },
      })),
    };
  const ready = vi.fn(async () => readySnapshot());
  const readyStatus = vi.fn(async () => readySnapshot());
  const inspection = new WindowsFleetInspection({
    host,
    native,
    files,
    session: session as never,
    record: async () => {
      const r = record();
      r.prepared.modelDigest = MODEL.sha256;
      r.prepared.report.runtime.modelDigest = MODEL.sha256;
      return r;
    },
    ready,
    readyStatus,
    capacity: async () => ({ selectedWorkers: 1 }),
    now: () => fleetNow,
  });
  return {
    inspection,
    content,
    files,
    host,
    native,
    attemptId,
    jobId,
    status,
    current,
    ready,
    readyStatus,
  };
}
describe("consumer inspection reuses shared local history semantics", () => {
  it("ordinary inspection uses the attested status port and never falls back to full inventory hashing", async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    f.ready.mockRejectedValue(new Error("FULL_INVENTORY_CHANGED"));
    for (const [section, filter] of [
      ["logs", {}],
      ["status", {}],
      ["versions", {}],
      ["doctor", {}],
      ["job", { jobId: f.jobId }],
      ["errors", {}],
      ["explain", { code: "GPU_OOM" }],
      ["performance", {}],
      ["capacity", {}],
    ] as const)
      await f.inspection.read(section, filter, signal);
    expect(f.readyStatus).toHaveBeenCalledTimes(2);
    expect(f.ready).not.toHaveBeenCalled();
    const full = (await f.inspection.read(
      "doctor",
      { full: true },
      signal,
    )) as { healthy: boolean };
    expect(full.healthy).toBe(false);
    expect(f.ready).toHaveBeenCalledTimes(1);
    expect(f.readyStatus).toHaveBeenCalledTimes(2);
    f.readyStatus.mockRejectedValue(new Error("STATUS_ATTESTATION_CHANGED"));
    const refused = (await f.inspection.read("doctor", {}, signal)) as {
      healthy: boolean;
    };
    expect(refused.healthy).toBe(false);
    expect(f.ready).toHaveBeenCalledTimes(1);
  });
  it("reports missing model/readiness as failed Doctor/version checks while retaining history and status", async () => {
    const f = fixture();
    f.readyStatus.mockRejectedValue(new Error("MODEL_MISSING"));
    const signal = new AbortController().signal;
    expect(
      ((await f.inspection.read("doctor", {}, signal)) as { healthy: boolean })
        .healthy,
    ).toBe(false);
    expect(
      (
        (await f.inspection.read("versions", {}, signal)) as {
          ready: boolean;
          verifiedCurrentVersion: unknown;
        }
      ).verifiedCurrentVersion,
    ).toBe(null);
    expect(
      ((await f.inspection.read("status", {}, signal)) as { current: boolean })
        .current,
    ).toBe(true);
    expect(
      (
        (await f.inspection.read("job", { jobId: f.jobId }, signal)) as {
          foundLocally: boolean;
        }
      ).foundLocally,
    ).toBe(true);
  });
  it("filters bounded structured logs and drops secrets without reading arbitrary files", async () => {
    const f = fixture(),
      events = await f.inspection.events({
        lines: 1,
        jobId: f.jobId,
        errorsOnly: true,
      });
    expect(events).toHaveLength(1);
    expect(events[0]?.event.code).toBe("GPU_OOM");
    expect(JSON.stringify(events)).not.toContain("private.invalid");
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(f.files.read).toHaveBeenCalledWith(
      "logs\\events.jsonl",
      2 * 1024 ** 2,
      true,
    );
    expect(f.files.read).not.toHaveBeenCalledWith(
      "foreign.env",
      expect.anything(),
    );
    await expect(f.inspection.events({ lines: 10001 })).rejects.toThrow(
      "ADVANCED_REQUEST_INVALID",
    );
  });
  it("uses existing investigation and performance grouping with retained/incomplete history labels", async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    const job = (await f.inspection.read(
      "job",
      { jobId: f.jobId },
      signal,
    )) as {
      attempts: { state: string }[];
      incompleteHistory: boolean;
      foundLocally: boolean;
    };
    expect(job.foundLocally).toBe(true);
    expect(job.incompleteHistory).toBe(true);
    expect(job.attempts[0]?.state).toBe("failed");
    const errors = (await f.inspection.read("errors", {}, signal)) as {
      groups: { code: string; occurrences: number }[];
    };
    expect(errors.groups[0]?.code).toBe("GPU_OOM");
    expect(errors.groups[0]?.occurrences).toBe(1);
    const performance = (await f.inspection.read(
      "performance",
      {},
      signal,
    )) as { states: { failed: number }; incompleteHistory: boolean };
    expect(performance.states.failed).toBe(1);
    expect(performance.incompleteHistory).toBe(true);
    const explanation = (await f.inspection.read(
      "explain",
      { code: "GPU_OOM" },
      signal,
    )) as { nextSteps: string[] };
    expect(explanation.nextSteps.some((step) => step.startsWith("mw "))).toBe(
      false,
    );
  });
  it("requires exact native birth and Job membership for current runtime; cached backend policy never becomes live permission", async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    const live = (await f.inspection.read("status", {}, signal)) as {
      current: boolean;
      serverPolicy: { current: boolean };
    };
    expect(live.current).toBe(true);
    expect(live.serverPolicy.current).toBe(false);
    vi.mocked(f.host.processIdentity).mockResolvedValueOnce({
      ...f.current,
      creationTime: "133000000000000001",
    });
    expect(
      ((await f.inspection.read("status", {}, signal)) as { current: boolean })
        .current,
    ).toBe(false);
    f.native.isOwnedProcess.mockResolvedValueOnce(false);
    expect(
      ((await f.inspection.read("status", {}, signal)) as { current: boolean })
        .current,
    ).toBe(false);
    f.content.set(
      "state\\runtime-status.json",
      Buffer.from(
        JSON.stringify({
          ...f.status,
          updatedAt: new Date(fleetNow - 120001).toISOString(),
        }),
      ),
    );
    expect(
      ((await f.inspection.read("status", {}, signal)) as { current: boolean })
        .current,
    ).toBe(false);
  });
  it("Doctor labels live inference not-run and detects changed physical GPU driver", async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    const doctor = (await f.inspection.read("doctor", {}, signal)) as {
      healthy: boolean;
      checks: { name: string; status: string }[];
    };
    expect(doctor.healthy).toBe(true);
    expect(
      doctor.checks.find((check) => check.name === "live-directml-inference")
        ?.status,
    ).toBe("not-run");
    vi.mocked(f.host.native.bootIdentity).mockResolvedValueOnce("f".repeat(64));
    expect(
      ((await f.inspection.read("doctor", {}, signal)) as { healthy: boolean })
        .healthy,
    ).toBe(false);
    vi.mocked(f.host.native.enumerateGpus).mockResolvedValueOnce([
      { ...advancedGpu, driverVersion: "new-driver" },
    ]);
    expect(
      ((await f.inspection.read("doctor", {}, signal)) as { healthy: boolean })
        .healthy,
    ).toBe(false);
  });
  it("bounds event streams and refuses corrupt runtime publications rather than marking them active", async () => {
    const f = fixture();
    f.content.set("logs\\events.jsonl", Buffer.from("x".repeat(8193)));
    await expect(f.inspection.events({ lines: 10 })).rejects.toThrow(
      "ADVANCED_FILE_INVALID",
    );
    f.content.set(
      "state\\runtime-status.json",
      Buffer.from(
        JSON.stringify({ ...f.status, activeAttemptIds: ["not-an-attempt"] }),
      ),
    );
    await expect(f.inspection.status()).rejects.toThrow();
    expect(() =>
      parseLocalRuntimeStatus({ ...f.status, hiddenSecret: "secret" }),
    ).toThrow();
  });
});
describe("actual local diagnostic ZIP", () => {
  it("contains exactly sanitized manifest/report JSON and can be read as an archive", async () => {
    const archive = createFleetDiagnosticArchive(
      sanitizeAdvancedData({
        token: "secret",
        path: "C:\\Users\\private",
        result: {
          code: "GPU_OOM",
          detail: "Bearer secret https://private.invalid/grant",
        },
      }),
    );
    const files = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
        if (error || !zip) return reject(error);
        const found = new Map<string, Buffer>();
        zip.on("error", reject);
        zip.on("end", () => resolve(found));
        zip.on("entry", (entry) => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return reject(streamError);
            const chunks: Buffer[] = [];
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("error", reject);
            stream.on("end", () => {
              found.set(entry.fileName, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      });
    });
    expect([...files.keys()]).toEqual(["manifest.json", "report.json"]);
    const report = files.get("report.json")!.toString();
    expect(report).toContain("GPU_OOM");
    expect(report).not.toContain("secret");
    expect(report).not.toContain("private.invalid");
    expect(JSON.parse(files.get("manifest.json")!.toString()).scope).toBe(
      "windows-user-fleet",
    );
    expect(() =>
      createFleetDiagnosticArchive("x".repeat(8 * 1024 ** 2)),
    ).toThrow("ADVANCED_RESULT_TOO_LARGE");
  });
});
