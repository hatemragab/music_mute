import { describe, it, expect, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createWindowsFleetAdvanced } from "../src/main/fleet/advanced/factory.js";
import {
  VaultFleetStore,
  fleetRecordAuthority,
} from "../src/main/fleet/store.js";
import { consumerFleetRemoved } from "../src/main/fleet/advanced/removal-marker.js";
import {
  readConsumerFleetCapacity,
  consumerCapacityIdentity,
  createConsumerFleetCapacityReceipt,
  consumerFleetRuntimeSlots,
} from "../src/main/fleet/advanced/capacity.js";
import { parseCapacityBenchmarkReport } from "../../worker/src/platform/shared/capacity-benchmark.js";
import type { HostContext } from "../src/main/host-context.js";
import type {
  ConsumerHostIdentity,
  ConsumerMutexLease,
} from "../../worker/src/platform/windows/consumer-native.js";
import type { FileCapabilities } from "../src/main/file-capabilities.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { fleetNow, fleetSid, record } from "./fleet-fixtures.js";
import {
  advancedGpu,
  processIdentity,
  readySnapshot,
  consumerCapacityRaw,
} from "./fleet-advanced-fixtures.js";
const hostIdentity: ConsumerHostIdentity = {
  ...processIdentity,
  nativeArch: "x64",
  processArch: "x64",
  logonSid: "S-1-5-5-1-2",
  osMajor: 10,
  osBuild: 19045,
  localAppData: "C:\\Users\\fixture\\AppData\\Local",
};
function fixture() {
  const vault = new Map<string, Buffer>(),
    events: string[] = [];
  const enrollment = record();
  enrollment.prepared.modelDigest = MODEL.sha256;
  enrollment.prepared.report.runtime.modelDigest = MODEL.sha256;
  vault.set("enrollment", Buffer.from(JSON.stringify(enrollment)));
  const lease: ConsumerMutexLease = {
    scope: "cache",
    nonce: "f".repeat(64),
    identity: processIdentity,
    abandoned: false,
  };
  const native = {
    bootIdentity: async () => "e".repeat(64),
    vaultRead: vi.fn(async (_scope: string, key: string) =>
      vault.has(key) ? Buffer.from(vault.get(key)!) : null,
    ),
    vaultWrite: vi.fn(async (_scope: string, key: string, bytes: Buffer) => {
      vault.set(key, Buffer.from(bytes));
      events.push(`write:${key}`);
    }),
    vaultDelete: vi.fn(async (_scope: string, key: string) => {
      vault.delete(key);
    }),
    acquireMutex: vi.fn(async () => lease),
    releaseMutex: vi.fn(async () => {}),
    ensurePrivateDirectory: vi.fn(
      async () => "C:\\Users\\fixture\\AppData\\Local\\MusicMuteWorker",
    ),
    validatePath: vi.fn(async () => {}),
    enumerateGpus: vi.fn(async () => [advancedGpu]),
  };
  const host = {
    native,
    identity: hostIdentity,
    personalRoot: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
    processIdentity: vi.fn(async () => processIdentity),
    ownedTreeExited: vi.fn(async () => true),
  } as unknown as HostContext;
  const session = {
    command: vi.fn(
      async (command: {
        action: string;
        transaction?: string;
        intent?: string;
        confirmation?: string;
        reason?: string;
        expected_revision?: number;
      }) => {
        events.push(`session:${command.action}`);
        return {
          revision: 7,
          maintenance:
            command.transaction ||
            (command.action === "fleet_force" &&
              ["update", "revoke"].includes(command.reason ?? ""))
              ? {
                  transaction: command.transaction ?? command.confirmation,
                  phase: "idle",
                }
              : null,
          fleet: {
            intent:
              command.reason === "stop"
                ? "stopped"
                : (command.intent ?? "paused"),
            phase: "paused",
            problem: null,
          },
        };
      },
    ),
  };
  const fetcher = vi.fn(async () =>
    Response.json({
      machine_id: enrollment.machineId,
      status: "revoked",
      confirmed: true,
      revision: 3,
    }),
  );
  const updates = {
    check: vi.fn(async () => ({ phase: "current" })),
    install: vi.fn(async () => ({ phase: "complete" })),
    recover: vi.fn(async () => ({ phase: "current" })),
  };
  const operations = {
    snapshotReady: vi.fn(async () => readySnapshot()),
    snapshotReadyStatus: vi.fn(async () => readySnapshot()),
  };
  return {
    enrollment,
    vault,
    native,
    host,
    session,
    fetcher,
    updates,
    events,
    operations,
  };
}
async function advanced(f: ReturnType<typeof fixture>, withUpdates = true) {
  return createWindowsFleetAdvanced({
    host: f.host,
    native: { isOwnedProcess: vi.fn(async () => false) },
    operations: f.operations,
    session: f.session as never,
    files: {} as FileCapabilities,
    fileOwner: "fixture-window",
    storage: {
      protectTree: vi.fn(async () => ({ release: async () => {} })),
      beginWrite: vi.fn(async () => ({
        captureCreated: async () => {},
        settle: async () => {},
        handoff: async () => {},
      })),
      trackWorkspace: vi.fn(async () => ({ release: async () => {} })),
    },
    exportArchive: vi.fn(async () => {}),
    ...(withUpdates ? { updates: f.updates as never } : {}),
    fetch: f.fetcher,
    now: () => fleetNow,
  });
}
async function run(
  controller: Awaited<ReturnType<typeof advanced>>["controller"],
  action: "revoke" | "remove" | "purge" | "restore",
) {
  await controller.execute({ type: "CONFIRM", mutation: { action } });
  await controller.execute({
    type: "RUN",
    confirmation: controller.snapshot().confirmation!.token,
  });
}
describe("real no-admin Advanced production dispatch with fixture transports", () => {
  it("ordinary receiving reads stay off full inventory hashing while an explicit benchmark still requires full current verification", async () => {
    const f = fixture(),
      app = await advanced(f);
    try {
      await app.controller.execute({ type: "READ", section: "versions" });
      await app.controller.execute({ type: "READ", section: "doctor" });
      await app.controller.execute({ type: "READ", section: "capacity" });
      expect(f.operations.snapshotReady).not.toHaveBeenCalled();
      expect(f.operations.snapshotReadyStatus).toHaveBeenCalledTimes(2);
      f.operations.snapshotReady.mockRejectedValue(
        new Error("FULL_CURRENT_INVENTORY_REQUIRED"),
      );
      await app.controller.execute({
        type: "CONFIRM",
        mutation: { action: "benchmark_capacity" },
      });
      await expect(
        app.controller.execute({
          type: "RUN",
          confirmation: app.controller.snapshot().confirmation!.token,
        }),
      ).rejects.toThrow("FULL_CURRENT_INVENTORY_REQUIRED");
      expect(f.operations.snapshotReady).toHaveBeenCalledTimes(1);
      expect(f.operations.snapshotReadyStatus).toHaveBeenCalledTimes(2);
      expect(app.controller.snapshot().phase).toBe("recovery");
      expect(
        f.native.vaultWrite.mock.calls.some(
          (call) => call[1] === "benchmark_owner",
        ),
      ).toBe(false);
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each(["stop", "restart"] as const)(
    "dispatches reviewed Force %s only to the exact authenticated session transaction and preserves unrelated credential/account state",
    async (reason) => {
      const f = fixture(),
        app = await advanced(f);
      await app.controller.execute({
        type: "CONFIRM",
        mutation: { action: reason, force: true },
      });
      const token = app.controller.snapshot().confirmation!.token;
      await app.controller.execute({ type: "RUN", confirmation: token });
      const journal = JSON.parse(f.vault.get("advanced_journal")!.toString()),
        commands = f.session.command.mock.calls.map(([command]) => command);
      expect(commands).toContainEqual(
        expect.objectContaining({
          action: "fleet_force",
          reason,
          request_id: journal.transaction,
          confirmation: journal.transaction,
          machine_id: f.enrollment.machineId,
          authority: fleetRecordAuthority(f.enrollment),
          expected_revision: 7,
        }),
      );
      expect(
        commands.some((command) => command.action === "maintenance_begin"),
      ).toBe(false);
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(JSON.parse(f.vault.get("enrollment")!.toString())).toEqual(
        f.enrollment,
      );
    },
  );
  it("reviewed forced Revoke uses existing forced backend confirmation only after exact native session proof and retires credentials normally", async () => {
    const f = fixture(),
      app = await advanced(f);
    await app.controller.execute({
      type: "CONFIRM",
      mutation: { action: "revoke", force: true },
    });
    await app.controller.execute({
      type: "RUN",
      confirmation: app.controller.snapshot().confirmation!.token,
    });
    const commands = f.session.command.mock.calls.map(([command]) => command);
    expect(commands).toContainEqual(
      expect.objectContaining({
        action: "fleet_force",
        reason: "revoke",
        expected_revision: 7,
      }),
    );
    const request = f.fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toEqual({ force: true });
    const retired = JSON.parse(f.vault.get("enrollment")!.toString());
    expect(retired.phase).toBe("revoked");
    expect(retired.machineCredential).toBeNull();
    expect(f.events.indexOf("session:fleet_force")).toBeLessThan(
      f.events.indexOf("session:fleet_intent"),
    );
    expect(f.events).toContain("session:maintenance_end");
  });
  it("a force tree/ACK failure keeps protected review authority and cannot reach backend unpair or credential deletion", async () => {
    const f = fixture(),
      app = await advanced(f);
    const original = f.session.command.getMockImplementation()!;
    f.session.command.mockImplementation(async (command) => {
      if (command.action === "fleet_force")
        throw new Error("CHILD_SHUTDOWN_PENDING");
      return original(command);
    });
    await app.controller.execute({
      type: "CONFIRM",
      mutation: { action: "revoke", force: true },
    });
    await expect(
      app.controller.execute({
        type: "RUN",
        confirmation: app.controller.snapshot().confirmation!.token,
      }),
    ).rejects.toThrow("CHILD_SHUTDOWN_PENDING");
    expect(app.controller.snapshot().phase).toBe("recovery");
    expect(
      JSON.parse(f.vault.get("advanced_journal")!.toString()),
    ).toMatchObject({ phase: "running", forceRevision: 7 });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(f.vault.get("enrollment")!.toString())).toEqual(
      f.enrollment,
    );
    expect(f.events).not.toContain("session:maintenance_end");
  });
  it("distinct authenticated pre-effect stale force review closes only that no-effect journal and requires a new explicit confirmation", async () => {
    const f = fixture(),
      app = await advanced(f),
      original = f.session.command.getMockImplementation()!;
    f.session.command.mockImplementation(async (command) => {
      if (command.action === "fleet_force")
        throw new Error("FORCE_CONFIRMATION_STALE");
      return original(command);
    });
    await app.controller.execute({
      type: "CONFIRM",
      mutation: { action: "revoke", force: true },
    });
    await expect(
      app.controller.execute({
        type: "RUN",
        confirmation: app.controller.snapshot().confirmation!.token,
      }),
    ).rejects.toThrow("ADVANCED_FORCE_CONFIRMATION_STALE");
    expect(
      JSON.parse(f.vault.get("advanced_journal")!.toString()),
    ).toMatchObject({ phase: "complete" });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(f.vault.get("enrollment")!.toString())).toEqual(
      f.enrollment,
    );
    await app.controller.execute({
      type: "CONFIRM",
      mutation: { action: "revoke", force: true },
    });
    expect(app.controller.snapshot().confirmation).not.toBeNull();
  });
  it("Force catalog Update forwards the exact immutable reviewed source/machine/revision to the sole updater and leaves native force to its admitted transaction", async () => {
    const f = fixture(),
      app = await advanced(f);
    await app.controller.execute({ type: "UPDATE_CHECK", source: "catalog" });
    expect(f.updates.check).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      "catalog",
    );
    await app.controller.execute({
      type: "CONFIRM",
      mutation: { action: "update", source: "catalog", force: true },
    });
    await app.controller.execute({
      type: "RUN",
      confirmation: app.controller.snapshot().confirmation!.token,
    });
    const journal = JSON.parse(f.vault.get("advanced_journal")!.toString());
    expect(f.updates.install).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      "catalog",
      {
        transaction: journal.transaction,
        machineId: f.enrollment.machineId,
        authority: fleetRecordAuthority(f.enrollment),
        expectedRevision: 7,
        force: true,
      },
    );
    expect(f.events).not.toContain("session:fleet_force");
    expect(f.events).not.toContain("session:maintenance_begin");
  });
  it("a completed update with failed final Advanced journal persists exact original authority and can recover through a recreated factory", async () => {
    const f = fixture(),
      app = await advanced(f),
      originalWrite = f.native.vaultWrite.getMockImplementation()!;
    let failComplete = true;
    f.native.vaultWrite.mockImplementation(async (ns, key, bytes) => {
      if (
        key === "advanced_journal" &&
        JSON.parse(bytes.toString()).phase === "complete" &&
        failComplete
      ) {
        failComplete = false;
        throw new Error("ADVANCED_JOURNAL_UNAVAILABLE");
      }
      return originalWrite(ns, key, bytes);
    });
    await app.controller.execute({
      type: "CONFIRM",
      mutation: { action: "update", source: "catalog" },
    });
    await expect(
      app.controller.execute({
        type: "RUN",
        confirmation: app.controller.snapshot().confirmation!.token,
      }),
    ).rejects.toThrow("ADVANCED_JOURNAL_UNAVAILABLE");
    const receipt = await app.pendingUpdateRecovery();
    expect(receipt).toMatchObject({
      machineId: f.enrollment.machineId,
      authority: fleetRecordAuthority(f.enrollment),
      source: "catalog",
    });
    const recreated = await advanced(f);
    await recreated.controller.initialize();
    expect(recreated.controller.snapshot().phase).toBe("recovery");
    await recreated.controller.execute({ type: "RECOVER" });
    expect(f.updates.recover).toHaveBeenCalledOnce();
    expect(await recreated.pendingUpdateRecovery()).toBeNull();
    expect(JSON.parse(f.vault.get("enrollment")!.toString())).toEqual(
      f.enrollment,
    );
  });
  it("keeps basic Advanced available when updates are unconfigured and refuses update before journaling", async () => {
    const f = fixture(),
      app = await advanced(f, false);
    await app.controller.initialize();
    await expect(
      app.controller.execute({ type: "UPDATE_CHECK" }),
    ).rejects.toThrow("UPDATE_UNAVAILABLE");
    await expect(
      app.controller.execute({
        type: "CONFIRM",
        mutation: { action: "update" },
      }),
    ).rejects.toThrow("UPDATE_UNAVAILABLE");
    expect(f.vault.has("advanced_journal")).toBe(false);
    await run(app.controller, "remove");
    expect(await consumerFleetRemoved(f.native, f.enrollment)).toBe(true);
  });
  it("confirms exact backend unpair before changing local fleet state and saves Stop independently", async () => {
    const f = fixture(),
      app = await advanced(f);
    await run(app.controller, "revoke");
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, init] = f.fetcher.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(new URL(url).pathname).toBe("/worker/unpairings");
    expect(JSON.parse(String(init.body))).toEqual({ force: false });
    expect(JSON.parse(f.vault.get("enrollment")!.toString()).phase).toBe(
      "revoked",
    );
    expect(f.vault.has("confirmed_unpair")).toBe(true);
    expect(f.events.indexOf("write:confirmed_unpair")).toBeLessThan(
      f.events.lastIndexOf("write:enrollment"),
    );
    expect(f.events).toContain("session:fleet_intent");
    expect(f.events).toContain("session:maintenance_end");
  });
  it("preserves credential/configuration on an ambiguous backend response and retains the maintenance fence", async () => {
    const f = fixture(),
      app = await advanced(f);
    f.fetcher.mockRejectedValueOnce(new Error("ACK_LOST"));
    await expect(run(app.controller, "revoke")).rejects.toThrow();
    expect(JSON.parse(f.vault.get("enrollment")!.toString()).phase).toBe(
      "complete",
    );
    expect(f.vault.has("confirmed_unpair")).toBe(false);
    expect(app.controller.snapshot().phase).toBe("recovery");
    expect(f.events).not.toContain("session:maintenance_end");
  });
  it("recovers a persisted backend confirmation after local enrollment-write failure without repeating unpair", async () => {
    const f = fixture(),
      app = await advanced(f),
      write = f.native.vaultWrite;
    write.mockImplementationOnce(async (_scope, key, bytes) => {
      f.vault.set(key, Buffer.from(bytes));
    });
    const original = write.getMockImplementation()!;
    write.mockImplementation(async (scope, key, bytes) => {
      if (key === "enrollment") throw new Error("LOCAL_WRITE_FAILED");
      return original(scope, key, bytes);
    });
    await expect(run(app.controller, "revoke")).rejects.toThrow(
      "LOCAL_WRITE_FAILED",
    );
    expect(f.vault.has("confirmed_unpair")).toBe(true);
    expect(f.fetcher).toHaveBeenCalledOnce();
    write.mockImplementation(async (_scope, key, bytes) => {
      f.vault.set(key, Buffer.from(bytes));
    });
    await app.controller.execute({ type: "RECOVER" });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(f.vault.get("enrollment")!.toString()).phase).toBe(
      "revoked",
    );
    expect(app.controller.snapshot().phase).toBe("complete");
  });
  it("refuses a wrong-machine backend receipt and fences a new enrollment during the unpair request", async () => {
    for (const replacement of [false, true]) {
      const f = fixture(),
        app = await advanced(f),
        newMachine = randomUUID();
      f.fetcher.mockImplementationOnce(async () => {
        if (replacement)
          f.vault.set(
            "enrollment",
            Buffer.from(
              JSON.stringify({
                ...f.enrollment,
                machineId: newMachine,
                machineCredential: "n".repeat(43),
              }),
            ),
          );
        return Response.json({
          machine_id: replacement ? f.enrollment.machineId : newMachine,
          status: "revoked",
          confirmed: true,
          revision: 3,
        });
      });
      await expect(run(app.controller, "revoke")).rejects.toThrow(
        "ADVANCED_MACHINE_CHANGED",
      );
      expect(f.vault.has("confirmed_unpair")).toBe(false);
      expect(JSON.parse(f.vault.get("enrollment")!.toString()).phase).toBe(
        "complete",
      );
    }
  });
  it("separates local Remove from backend Revoke and refuses purge until both are complete", async () => {
    const f = fixture(),
      app = await advanced(f);
    await run(app.controller, "remove");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(await consumerFleetRemoved(f.native, f.enrollment)).toBe(true);
    expect(JSON.parse(f.vault.get("enrollment")!.toString()).phase).toBe(
      "complete",
    );
    await expect(run(app.controller, "purge")).rejects.toThrow(
      "ADVANCED_REVOKE_AND_REMOVE_REQUIRED",
    );
    expect(f.native.vaultDelete).not.toHaveBeenCalled();
  });
  it("an old Remove marker never disables a newly enrolled machine", async () => {
    const f = fixture(),
      app = await advanced(f);
    await run(app.controller, "remove");
    expect(
      await consumerFleetRemoved(f.native, {
        ...f.enrollment,
        machineId: randomUUID(),
        machineCredential: "n".repeat(43),
      }),
    ).toBe(false);
  });
  it("restores the exact approved removed identity with Stop saved and no new enrollment or auto-start", async () => {
    const f = fixture(),
      app = await advanced(f);
    await run(app.controller, "remove");
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        machine_id: f.enrollment.machineId,
        status: "active",
        group_id: null,
        policy_revision: 2,
        revision: 3,
        active_attempts: 0,
        last_seen_at: null,
        claims_allowed: true,
      }),
    );
    await run(app.controller, "restore");
    expect(await consumerFleetRemoved(f.native, f.enrollment)).toBe(false);
    expect(JSON.parse(f.vault.get("enrollment")!.toString())).toEqual(
      f.enrollment,
    );
    expect(app.controller.snapshot().data).toMatchObject({
      restored: "consumer-fleet-role",
      machineId: f.enrollment.machineId,
      savedIntent: "stopped",
      identityPreserved: true,
      explicitStartRequired: true,
    });
    expect(f.fetcher).toHaveBeenCalledOnce();
    const call = f.fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(new URL(call[0]).pathname).toBe("/worker/status");
    expect(
      f.session.command.mock.calls
        .filter(([command]) => command.action === "fleet_intent")
        .every(([command]) => command.intent === "stopped"),
    ).toBe(true);
    await app.close();
  });
  it("refuses Restore when approval is paused or the original machine was revoked", async () => {
    for (const revoked of [false, true]) {
      const f = fixture(),
        app = await advanced(f);
      await run(app.controller, "remove");
      if (revoked) {
        const r = { ...f.enrollment, phase: "revoked" };
        f.vault.set("enrollment", Buffer.from(JSON.stringify(r)));
      } else
        f.fetcher.mockResolvedValueOnce(
          Response.json({
            machine_id: f.enrollment.machineId,
            status: "paused",
            group_id: null,
            policy_revision: 2,
            revision: 3,
            active_attempts: 0,
            last_seen_at: null,
            claims_allowed: false,
          }),
        );
      await expect(run(app.controller, "restore")).rejects.toThrow(
        revoked ? "FLEET_REVOKED" : "FLEET_APPROVAL_REQUIRED",
      );
      expect(f.vault.has("removed")).toBe(true);
      expect(f.fetcher).toHaveBeenCalledTimes(revoked ? 0 : 1);
      await app.close();
    }
  });
  it("atomically compares full machine authority before a delayed confirmed credential effect", async () => {
    const f = fixture(),
      store = new VaultFleetStore(f.native, fleetSid),
      expected = fleetRecordAuthority(f.enrollment);
    await store.writeIfCurrent(expected, { ...f.enrollment, phase: "revoked" });
    expect((await store.read())?.phase).toBe("revoked");
    f.vault.set(
      "enrollment",
      Buffer.from(
        JSON.stringify({
          ...f.enrollment,
          machineId: randomUUID(),
          machineCredential: "n".repeat(43),
        }),
      ),
    );
    await expect(
      store.writeIfCurrent(expected, { ...f.enrollment, phase: "revoked" }),
    ).rejects.toThrow("ADVANCED_MACHINE_CHANGED");
    expect(f.native.releaseMutex).toHaveBeenCalledTimes(2);
  });
});
describe("consumer runtime two-slot receipt binding", () => {
  it("keeps the original slot by default and ignores a valid retired machine's capacity state", async () => {
    const f = fixture(),
      identity = consumerCapacityIdentity({
        bootIdentity: "e".repeat(64),
        host: hostIdentity,
        gpu: advancedGpu,
        manifestDigest: "b".repeat(64),
        modelDigest: MODEL.sha256,
        fixtureDigest: "c".repeat(64),
      });
    const options = {
      native: f.native,
      record: f.enrollment,
      identity,
      readReceipt: vi.fn(async () => Buffer.alloc(0)),
      now: fleetNow,
    };
    expect((await consumerFleetRuntimeSlots(options)).workerIds).toEqual([
      f.enrollment.workerId,
    ]);
    f.vault.set(
      "capacity",
      Buffer.from(
        JSON.stringify({
          version: 1,
          machineId: randomUUID(),
          authority: "c".repeat(64),
          selectedWorkers: 2,
          secondWorkerId: randomUUID(),
          receipt: null,
        }),
      ),
    );
    expect((await consumerFleetRuntimeSlots(options)).workerIds).toEqual([
      f.enrollment.workerId,
    ]);
    expect(options.readReceipt).not.toHaveBeenCalled();
  });
  it("activates only stable distinct slot IDs with an unexpired hash/SID/hardware/manifest/model/fixture-bound receipt", async () => {
    const f = fixture(),
      identity = consumerCapacityIdentity({
        bootIdentity: "e".repeat(64),
        host: hostIdentity,
        gpu: advancedGpu,
        manifestDigest: "b".repeat(64),
        modelDigest: MODEL.sha256,
        fixtureDigest: "c".repeat(64),
      });
    const measurements = parseCapacityBenchmarkReport(consumerCapacityRaw(), {
      provider: "directml",
      expectedUserSid: fleetSid,
      fixtureDigest: "c".repeat(64),
      warmupRuns: 1,
      measuredRuns: 3,
    });
    const receipt = createConsumerFleetCapacityReceipt(
        f.enrollment,
        identity,
        measurements,
        fleetNow,
      ),
      bytes = Buffer.from(JSON.stringify(receipt)),
      second = randomUUID();
    f.vault.set(
      "capacity",
      Buffer.from(
        JSON.stringify({
          version: 1,
          machineId: f.enrollment.machineId,
          authority: fleetRecordAuthority(f.enrollment),
          selectedWorkers: 2,
          secondWorkerId: second,
          receipt: {
            relativePath: `prepare\\results\\${randomUUID()}.capacity.json`,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        }),
      ),
    );
    const options = {
      native: f.native,
      record: f.enrollment,
      identity,
      readReceipt: vi.fn(async () => bytes),
      now: fleetNow,
    };
    expect((await consumerFleetRuntimeSlots(options)).workerIds).toEqual([
      f.enrollment.workerId,
      second,
    ]);
    expect(
      (await consumerFleetRuntimeSlots(options)).validatedMaxWorkersPerGpu,
    ).toBe(2);
    for (const altered of [
      { ...identity, modelDigest: "e".repeat(64) },
      { ...identity, releaseManifestDigest: "e".repeat(64) },
      { ...identity, fixtureDigest: "e".repeat(64) },
      { ...identity, hostDigest: "e".repeat(64) },
    ])
      expect(
        (await consumerFleetRuntimeSlots({ ...options, identity: altered }))
          .workerIds,
      ).toEqual([f.enrollment.workerId]);
    expect(
      (
        await consumerFleetRuntimeSlots({
          ...options,
          now: fleetNow + 8 * 86400000,
        })
      ).validatedMaxWorkersPerGpu,
    ).toBe(1);
    expect(
      (
        await consumerFleetRuntimeSlots({
          ...options,
          readReceipt: async () => Buffer.from("changed"),
        })
      ).validatedMaxWorkersPerGpu,
    ).toBe(1);
  });
  it("refuses malformed capacity state instead of inventing slot authority", async () => {
    const f = fixture();
    f.vault.set(
      "capacity",
      Buffer.from(
        JSON.stringify({
          selectedWorkers: 2,
          machineId: f.enrollment.machineId,
        }),
      ),
    );
    await expect(
      readConsumerFleetCapacity(f.native, f.enrollment),
    ).rejects.toThrow("ADVANCED_CAPACITY_INVALID");
  });
});
