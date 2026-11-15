import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { expect, it, vi } from "vitest";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { parseQualificationEvidence } from "../../worker/src/enrollment/report-builder.js";
import type { HostContext } from "../src/main/host-context.js";
import {
  selectTrustedPreparationGpu,
  type TrustedPreparationGpuSelection,
  QualificationCleanupUnconfirmed,
} from "../src/main/prepare/qualification-runner.js";
import type { WindowsPreparationOperations } from "../src/main/prepare/operations.js";
import {
  createWindowsFleetRecovery,
  createFleetRecoveryMaintenancePort,
  inspectWindowsFleetRecovery,
} from "../src/main/fleet/recovery.js";
import { freshSessionState } from "../src/main/session/supervisor.js";
import { record } from "./fleet-fixtures.js";
import { receipt } from "./fixtures/prepare.js";
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const enrollment = record(),
    personalRoot = "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal";
  enrollment.prepared.modelDigest = MODEL.sha256;
  enrollment.prepared.report.runtime.modelDigest = MODEL.sha256;
  enrollment.prepared.qualificationPath = win32.join(
    personalRoot,
    `prepare\\approved\\qualification-${createHash("sha256").update(enrollment.requests.report).digest("hex")}.json`,
  );
  const original = {
    ...receipt().qualification,
    serviceIdentity: enrollment.sid,
    gpuId: `dxgi-${enrollment.prepared.gpu.luid}`,
    directmlDeviceId: enrollment.prepared.gpu.deviceIndex,
    gpuIdentity: enrollment.prepared.gpu,
    fixtureDigest: enrollment.prepared.fixtureDigest,
    resourceObservations: {
      inferenceSlots: 1,
      dedicatedVideoMemoryLimitBytes:
        enrollment.prepared.gpu.dedicatedVideoMemoryBytes,
      sharedSystemMemoryLimitBytes:
        enrollment.prepared.gpu.sharedSystemMemoryLimitBytes,
    },
  };
  const ready = {
      bootIdentity: receipt().bootIdentity,
      release: "1".repeat(64),
      manifestSha256: "2".repeat(64),
      archiveSha256: "3".repeat(64),
      modelSha256: MODEL.sha256,
      nativeSha256: "4".repeat(64),
      evidence: { gpuIdentity: { ...enrollment.prepared.gpu } },
    },
    raw = { ...original, releaseManifestDigest: ready.manifestSha256 };
  const helper = {
      sid: enrollment.sid,
      sessionId: 1,
      pid: 12,
      creationTime: "133000000000000000",
    },
    owner = { ...helper, pid: process.pid, creationTime: "133000000000000001" },
    sessionOwner = { ...helper, pid: 13, creationTime: "133000000000000002" };
  const data = new Map<string, Buffer>([
      ["fleet:enrollment", Buffer.from(JSON.stringify(enrollment))],
      ["fleet:capacity", Buffer.from("old")],
    ]),
    events: string[] = [],
    leases = new Map<string, string>();
  let retired = false;
  const native = {
    bootIdentity: vi.fn(async () => ready.bootIdentity),
    enumerateGpus: vi.fn(async () => [raw.gpuIdentity]),
    processIdentity: vi.fn(async (pid: number) =>
      pid === process.pid ? owner : null,
    ),
    vaultRead: vi.fn(async (ns: string, key: string) =>
      data.has(`${ns}:${key}`) ? Buffer.from(data.get(`${ns}:${key}`)!) : null,
    ),
    vaultWrite: vi.fn(async (ns: string, key: string, bytes: Buffer) => {
      events.push(`write:${key}`);
      data.set(`${ns}:${key}`, Buffer.from(bytes));
    }),
    vaultDelete: vi.fn(async (ns: string, key: string) => {
      events.push(`delete:${key}`);
      data.delete(`${ns}:${key}`);
    }),
    acquireMutex: vi.fn(async (scope: "cache" | "prepare") => {
      events.push(`acquire:${scope}`);
      if (leases.has(scope)) return null;
      const nonce = "a".repeat(64);
      leases.set(scope, nonce);
      return { scope, nonce, identity: helper, abandoned: false };
    }),
    releaseMutex: vi.fn(async (lease: { scope: string; nonce: string }) => {
      if (leases.get(lease.scope) !== lease.nonce) throw Error("bad lease");
      events.push(`release:${lease.scope}`);
      leases.delete(lease.scope);
    }),
  };
  const host = {
    native,
    identity: helper,
    personalRoot,
    processIdentity: async (pid: number) => native.processIdentity(pid),
  } as unknown as HostContext;
  const session = {
    authority: sessionOwner,
    commit: vi.fn(async () => {
      events.push("session:commit");
      retired = true;
    }),
    release: vi.fn(async () => {
      events.push("session:release");
    }),
  };
  const maintenance = {
    acquire: vi.fn(async () => {
      events.push("session:acquire");
      return session;
    }),
    cancel: vi.fn(async () => {
      events.push("session:cancel");
    }),
    retired: vi.fn(async () => retired),
  };
  const activity = {
    assertIdle: vi.fn(async () => {
      events.push("activity:idle");
    }),
    release: vi.fn(async () => {
      events.push("activity:release");
    }),
    commit: vi.fn(async () => {
      events.push("activity:commit");
    }),
  };
  const options = {
    host,
    operations: {
      snapshotReady: vi.fn(async () => ({ ...ready })),
      requalifyInstalled: vi.fn(
        async (
          signal: AbortSignal,
          selection?: TrustedPreparationGpuSelection,
        ) => {
          signal.throwIfAborted();
          expect(leases.has("prepare")).toBe(true);
          if (!selection) throw Error("selection required");
          events.push("gpu:personal-align");
          ready.evidence.gpuIdentity = selectTrustedPreparationGpu(
            selection,
            await native.bootIdentity(),
            await native.enumerateGpus(),
          );
        },
      ),
    } as unknown as Pick<
      WindowsPreparationOperations,
      "snapshotReady" | "requalifyInstalled"
    >,
    maintenance,
    consumerActivity: {
      acquire: vi.fn(async () => {
        events.push("activity:acquire");
        return activity;
      }),
    },
    onSessionRetired: vi.fn(async () => {
      expect(leases.has("prepare")).toBe(false);
      events.push("rebind:scheduled");
    }),
    qualification: {
      readFixture: vi.fn(async () => ({
        relativePath: `prepare\\approved\\${enrollment.prepared.fixtureDigest}.wav`,
        bytes: 100,
        sha256: enrollment.prepared.fixtureDigest,
      })),
      readOriginalQualification: vi.fn(async () => original),
      qualify: vi.fn(async () => {
        expect(leases.has("prepare")).toBe(true);
        events.push("gpu:qualify");
        return {
          bootIdentity: ready.bootIdentity,
          raw,
          evidence: parseQualificationEvidence(raw, {
            runtimeProfile: "windows-user",
            expectedUserSid: enrollment.sid,
            expectedFixtureDigest: enrollment.prepared.fixtureDigest,
          }),
        };
      }),
    },
  };
  return {
    options,
    controller: createWindowsFleetRecovery(options),
    native,
    enrollment,
    owner,
    sessionOwner,
    data,
    events,
    leases,
    session,
    activity,
    maintenance,
    ready,
    raw,
    setRetired: (v: boolean) => {
      retired = v;
    },
  };
}
it("no enrollment and current proof require no maintenance, GPU, intent or account mutation", async () => {
  const f = fixture();
  f.data.delete("fleet:enrollment");
  expect(await f.controller.run(new AbortController().signal)).toBe("none");
  expect(f.options.operations.snapshotReady).not.toHaveBeenCalled();
  f.ready.release = f.enrollment.prepared.release;
  f.ready.manifestSha256 = f.enrollment.prepared.manifestDigest;
  f.ready.archiveSha256 = f.enrollment.prepared.archiveDigest;
  f.data.set("fleet:enrollment", Buffer.from(JSON.stringify(f.enrollment)));
  expect(await f.controller.run(new AbortController().signal)).toBe("current");
  expect(f.options.consumerActivity.acquire).not.toHaveBeenCalled();
  expect(f.options.qualification.qualify).not.toHaveBeenCalled();
});
it("drains the actual session before approved qualification and releases Prepare before scheduling saved-intent rebind", async () => {
  const f = fixture(),
    original = Buffer.from(f.data.get("fleet:enrollment")!);
  expect(await f.controller.run(new AbortController().signal)).toBe(
    "requalified",
  );
  expect(f.data.get("fleet:enrollment")).toEqual(original);
  expect(f.data.has("fleet:capacity")).toBe(false);
  expect(f.data.has("fleet:requalification")).toBe(false);
  expect(f.leases.size).toBe(0);
  expect(f.events.indexOf("activity:acquire")).toBeLessThan(
    f.events.indexOf("session:acquire"),
  );
  expect(f.events.indexOf("session:acquire")).toBeLessThan(
    f.events.indexOf("gpu:qualify"),
  );
  expect(f.events.indexOf("gpu:qualify")).toBeLessThan(
    f.events.indexOf("session:commit"),
  );
  expect(f.events.indexOf("release:prepare")).toBeLessThan(
    f.events.indexOf("rebind:scheduled"),
  );
  expect(f.activity.commit).not.toHaveBeenCalled();
  expect(f.controller.activity()).toEqual({ busy: false, idle: true });
});
it("a busy partial maintenance acquisition is cancelled without qualification or a saved-intent write", async () => {
  const f = fixture();
  f.maintenance.acquire.mockRejectedValueOnce(Error("UPDATE_BUSY"));
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "UPDATE_BUSY",
  );
  expect(f.maintenance.cancel).toHaveBeenCalledOnce();
  expect(f.activity.release).toHaveBeenCalledOnce();
  expect(f.options.qualification.qualify).not.toHaveBeenCalled();
  expect(f.data.has("fleet:requalification")).toBe(false);
  expect(f.controller.activity().idle).toBe(true);
});
it("uncertain maintenance cleanup retains durable fencing and keeps close unsafe", async () => {
  const f = fixture();
  f.maintenance.acquire.mockRejectedValueOnce(Error("UPDATE_BUSY"));
  f.maintenance.cancel.mockRejectedValueOnce(Error("ACK_LOST"));
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_RECOVERY_REQUIRED",
  );
  expect(f.data.has("fleet:requalification")).toBe(true);
  expect(f.activity.release).not.toHaveBeenCalled();
  expect(f.controller.activity().busy).toBe(true);
  await expect(f.controller.close()).rejects.toThrow(
    "FLEET_REQUALIFICATION_RECOVERY_REQUIRED",
  );
});
it("pending commands reject concurrency and keep truthful activity until actual qualification settles", async () => {
  const f = fixture(),
    wait = deferred<void>(),
    qualify = f.options.qualification.qualify.getMockImplementation()!;
  f.options.qualification.qualify.mockImplementationOnce(async () => {
    await wait.promise;
    return qualify();
  });
  const first = f.controller.run(new AbortController().signal);
  await vi.waitFor(() =>
    expect(f.options.qualification.qualify).toHaveBeenCalledOnce(),
  );
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_BUSY",
  );
  expect(f.controller.activity().busy).toBe(true);
  wait.resolve();
  await first;
  expect(f.controller.activity().idle).toBe(true);
});
it("lost retirement ACK retries only after durable retired proof, without rerunning GPU or releasing pending fence", async () => {
  const f = fixture();
  f.session.commit.mockImplementationOnce(async () => {
    f.setRetired(true);
    throw Error("ACK_LOST");
  });
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "ACK_LOST",
  );
  expect(
    JSON.parse(f.data.get("fleet:requalification")!.toString()).phase,
  ).toBe("retiring");
  expect(f.activity.release).not.toHaveBeenCalled();
  expect(await f.controller.run(new AbortController().signal)).toBe(
    "requalified",
  );
  expect(f.options.qualification.qualify).toHaveBeenCalledOnce();
  expect(f.session.commit).toHaveBeenCalledOnce();
});
it("foreign live controller and corrupt journal fail closed before acquiring any consumer fence", async () => {
  const f = fixture();
  f.data.set("fleet:requalification", Buffer.from('{"version":1,"version":1}'));
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_STATE_INVALID",
  );
  expect(f.options.consumerActivity.acquire).not.toHaveBeenCalled();
  f.data.delete("fleet:requalification");
  f.session.commit.mockRejectedValueOnce(Error("ACK_LOST"));
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "ACK_LOST",
  );
  const other = createWindowsFleetRecovery(f.options);
  await expect(other.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_BUSY",
  );
});
it("actual Node birth absence and foreign Prepare helper receipt cannot qualify", async () => {
  const f = fixture();
  f.native.processIdentity.mockResolvedValueOnce(null);
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_STATE_INVALID",
  );
  expect(f.options.qualification.qualify).not.toHaveBeenCalled();
  const real = f.native.acquireMutex.getMockImplementation()!;
  f.native.acquireMutex.mockImplementation(async (scope) => {
    const lease = await real(scope);
    return lease && scope === "prepare"
      ? { ...lease, identity: { ...lease.identity, pid: 999 } }
      : lease;
  });
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_BUSY",
  );
  expect(f.options.qualification.qualify).not.toHaveBeenCalled();
  expect(f.leases.size).toBe(0);
});
it("production retirement adapter requires supervisor retired state plus exact process exit, never Node absence alone", async () => {
  const f = fixture(),
    state = {
      ...freshSessionState(f.enrollment.sid),
      fleetIntent: "running" as const,
    };
  f.data.set("fleet:session_state", Buffer.from(JSON.stringify(state)));
  const native = {
    processIdentity: vi.fn(async () => null),
    waitProcessExit: vi.fn(async () => false),
    acquireMutex: vi.fn(),
    releaseMutex: vi.fn(),
  };
  const port = createFleetRecoveryMaintenancePort(f.options.host, native, {
    command: vi.fn(),
    currentAuthority: () => f.sessionOwner,
  });
  expect(await port.retired(f.sessionOwner)).toBe(false);
  native.waitProcessExit.mockResolvedValueOnce(true);
  expect(await port.retired(f.sessionOwner)).toBe(true);
  f.data.set(
    "fleet:session_state",
    Buffer.from(
      JSON.stringify({
        ...state,
        maintenance: {
          transaction: "a989d129-1c23-47ea-bb02-e6ea6b7a9901",
          peer: f.owner,
          idle: false,
        },
      }),
    ),
  );
  expect(await port.retired(f.sessionOwner)).toBe(false);
});

it("a crashed prior controller on a new witness must requalify the immutable approval before releasing its retired-session journal", async () => {
  const f = fixture(),
    original = Buffer.from(f.data.get("fleet:enrollment")!);
  f.session.commit.mockImplementationOnce(async () => {
    f.setRetired(true);
    throw Error("ACK_LOST");
  });
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "ACK_LOST",
  );
  // Simulate process-birth replacement and OS-released mutexes after controller death.
  f.leases.clear();
  f.ready.bootIdentity = "f".repeat(64);
  const newOwner = { ...f.owner, creationTime: "133000000000000099" };
  f.native.processIdentity.mockImplementation(async (pid) =>
    pid === process.pid ? newOwner : null,
  );
  const next = createWindowsFleetRecovery(f.options);
  expect(await next.run(new AbortController().signal)).toBe("requalified");
  expect(f.options.qualification.qualify).toHaveBeenCalledTimes(2);
  expect(f.session.commit).toHaveBeenCalledOnce();
  expect(f.data.get("fleet:enrollment")).toEqual(original);
  expect(
    JSON.parse(f.data.get("fleet:active_runtime")!.toString()).bootIdentity,
  ).toBe(f.ready.bootIdentity);
});

it("startup inspection is read-only and fences pending, corrupt and unavailable state without requiring account, model or GPU", async () => {
  const f = fixture();
  expect(
    await inspectWindowsFleetRecovery({
      native: f.options.host.native,
      identity: f.options.host.identity,
    }),
  ).toEqual({
    recoveryRequired: false,
    invalidState: false,
  });
  f.data.set("fleet:requalification", Buffer.from("not json"));
  expect(await inspectWindowsFleetRecovery(f.options.host)).toEqual({
    recoveryRequired: true,
    invalidState: true,
  });
  f.native.vaultRead.mockRejectedValueOnce(Error("PIPE_UNAVAILABLE"));
  expect(await inspectWindowsFleetRecovery(f.options.host)).toEqual({
    recoveryRequired: true,
    invalidState: true,
  });
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
  expect(f.native.acquireMutex).not.toHaveBeenCalled();
  expect(f.native.enumerateGpus).not.toHaveBeenCalled();
  expect(f.options.operations.snapshotReady).not.toHaveBeenCalled();
});

it("valid fleet proof with a different personal-ranked GPU must align PERSONAL under real fences before rebind", async () => {
  const f = fixture(),
    approved = f.enrollment.prepared.gpu,
    primary = {
      ...approved,
      deviceId: 9999,
      luid: "0000000000000001",
      deviceIndex: 0,
      dedicatedVideoMemoryBytes: 16 * 1024 ** 3,
    },
    before = Buffer.from(f.data.get("fleet:enrollment")!);
  f.ready.release = f.enrollment.prepared.release;
  f.ready.manifestSha256 = f.enrollment.prepared.manifestDigest;
  f.ready.archiveSha256 = f.enrollment.prepared.archiveDigest;
  f.ready.evidence.gpuIdentity = primary;
  f.native.enumerateGpus.mockResolvedValue([primary, approved]);
  expect(await f.controller.run(new AbortController().signal)).toBe(
    "requalified",
  );
  expect(f.options.operations.requalifyInstalled).toHaveBeenCalledOnce();
  expect(f.options.qualification.qualify).not.toHaveBeenCalled();
  expect(f.ready.evidence.gpuIdentity.luid).toBe(approved.luid);
  expect(f.data.get("fleet:enrollment")).toEqual(before);
  expect(f.data.get("fleet:capacity")?.toString()).toBe("old");
  expect(f.events.indexOf("session:acquire")).toBeLessThan(
    f.events.indexOf("gpu:personal-align"),
  );
  expect(f.events.indexOf("gpu:personal-align")).toBeLessThan(
    f.events.indexOf("session:commit"),
  );
});
it("a rejected PERSONAL alignment cannot publish a fleet proof or release an uncertain changed receipt as current", async () => {
  const f = fixture(),
    primary = {
      ...f.enrollment.prepared.gpu,
      deviceId: 9999,
      luid: "0000000000000001",
      deviceIndex: 0,
    };
  f.ready.evidence.gpuIdentity = primary;
  vi.mocked(f.options.operations.requalifyInstalled).mockRejectedValueOnce(
    new QualificationCleanupUnconfirmed(Error("TREE_STILL_LIVE")),
  );
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_RECOVERY_REQUIRED",
  );
  expect(f.options.qualification.qualify).not.toHaveBeenCalled();
  expect(f.data.has("fleet:active_runtime")).toBe(false);
  expect(f.session.commit).not.toHaveBeenCalled();
  expect(f.data.get("fleet:capacity")?.toString()).toBe("old");
  expect(f.session.release).not.toHaveBeenCalled();
  expect(f.activity.release).not.toHaveBeenCalled();
  expect(f.leases.has("prepare")).toBe(true);
  expect(
    JSON.parse(f.data.get("fleet:requalification")!.toString()).phase,
  ).toBe("fencing-uncertain");
  vi.mocked(f.options.operations.requalifyInstalled).mockRejectedValueOnce(
    Error("BUSY"),
  );
  await expect(f.controller.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_RECOVERY_REQUIRED",
  );
  expect(f.session.release).not.toHaveBeenCalled();
  expect(f.leases.has("prepare")).toBe(true);
  expect(await f.controller.run(new AbortController().signal)).toBe(
    "requalified",
  );
  expect(f.leases.has("prepare")).toBe(false);
  expect(f.data.has("fleet:requalification")).toBe(false);
});
