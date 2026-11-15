import { expect, it, vi } from "vitest";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import type { HostContext } from "../src/main/host-context.js";
import type { StorePreparationOperations } from "../src/main/prepare/store-operations.js";
import type { StorePrepareMaintenance } from "../src/main/prepare/store-maintenance.js";
import { record } from "./fleet-fixtures.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import {
  fleetRecordAuthority,
  type FleetEnrollmentRecord,
} from "../src/main/fleet/store.js";

// Real coordinator with synthetic receiving/module boundaries. These fixtures
// cannot prove Store identity, native Job cleanup, GPU, or device requalification.
const boundary = vi.hoisted(() => {
  class Operations {
    #host: object;
    targetImpl = vi.fn();
    lockImpl = vi.fn();
    recover = vi.fn();
    pending = false;
    constructor(host: object) {
      this.#host = host;
    }
    assertHost(host: object) {
      if (host !== this.#host) throw Error("FOREIGN_HOST");
    }
    target(...args: unknown[]) {
      return this.targetImpl(...args);
    }
    lock(...args: unknown[]) {
      return this.lockImpl(...args);
    }
    cleanupPending() {
      return this.pending;
    }
    recoverCleanup() {
      return this.recover();
    }
  }
  class Maintenance {
    #host: object;
    begin = vi.fn();
    finish = vi.fn();
    recover = vi.fn();
    recoverMutationImpl = vi.fn();
    pending = false;
    constructor(host: object) {
      this.#host = host;
    }
    assertHost(host: object) {
      if (host !== this.#host) throw Error("FOREIGN_HOST");
    }
    beforeMutation(...args: unknown[]) {
      return this.begin(...args);
    }
    settle(...args: unknown[]) {
      return this.finish(...args);
    }
    cleanupPending() {
      return this.pending;
    }
    recoverCleanup() {
      return this.recover();
    }
    recoverMutation() {
      return this.recoverMutationImpl();
    }
    ownsReservation() {
      return this.pending;
    }
  }
  class Authority {
    creatorProof() {
      return Reflect.get(this, "proof");
    }
  }
  return {
    Operations,
    Maintenance,
    Authority,
    current: vi.fn(),
    qualify: vi.fn(),
    legacyQualify: vi.fn(),
  };
});
vi.mock("../src/main/prepare/store-operations.js", () => ({
  StorePreparationOperations: boundary.Operations,
}));
vi.mock("../src/main/prepare/store-maintenance.js", () => ({
  StorePrepareMaintenance: boundary.Maintenance,
}));
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreNativeAuthority: boundary.Authority,
}));
vi.mock("../src/main/fleet/store-active-runtime.js", () => ({
  readStoreFleetRuntimeIdentityForGui: boundary.current,
}));
vi.mock("../src/main/fleet/store-update-preparation.js", () => ({
  refreshApprovedStoreFleetRuntime: boundary.qualify,
  repairApprovedLegacyStoreFleetRuntime: boundary.legacyQualify,
}));
import {
  StoreFleetRecovery,
  inspectStoreFleetRecovery,
} from "../src/main/fleet/store-recovery.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  boundary.current.mockReset();
  boundary.qualify.mockReset();
  boundary.legacyQualify.mockReset();
  const old = record(),
    product = STORE_PRODUCTS.worker,
    fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`;
  let enrollment: FleetEnrollmentRecord | null = {
    ...old,
    prepared: {
      ...old.prepared,
      distribution: "microsoft-store",
      archiveDigest: null,
      modelDigest: MODEL.sha256,
      report: {
        ...old.prepared.report,
        runtime: { ...old.prepared.report.runtime, modelDigest: MODEL.sha256 },
      },
      storeBinding: {
        package: {
          identityName: product.identityName,
          publisher: product.publisher,
          publisherId: product.publisherId,
          familyName: product.familyName,
          fullName,
          packageVersion: "0.1.3.2",
          architecture: "x64",
          signatureKind: 3,
          healthy: true,
          current: true,
          installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
        },
        inventorySha256: old.prepared.release,
        runtimeManifestSha256: old.prepared.manifestDigest,
        sid: old.sid,
        bootIdentity: old.prepared.bootIdentity!,
        recipeDigests: {
          "kim-vocals-v2": "0".repeat(64),
          "kim-vocals-v2-trim": "1".repeat(64),
        },
      },
    },
  };
  const gui = {
      sid: old.sid,
      sessionId: 1,
      pid: process.pid,
      creationTime: "1337133713371337",
    },
    helper = { ...gui, pid: 42 },
    rows = new Map<string, Buffer>(),
    events: string[] = [],
    authority = Object.assign(new boundary.Authority(), { proof: { gui } }),
    native = {
      vaultRead: vi.fn(async (_scope: string, key: string) =>
        key === "enrollment"
          ? Buffer.from(JSON.stringify(enrollment))
          : rows.get(key)
            ? Buffer.from(rows.get(key)!)
            : null,
      ),
      vaultWrite: vi.fn(async (_scope: string, key: string, bytes: Buffer) => {
        rows.set(key, Buffer.from(bytes));
      }),
      vaultDelete: vi.fn(async (_scope: string, key: string) => {
        events.push(`delete:${key}`);
        rows.delete(key);
      }),
      acquireMutex: vi.fn(async (scope: string) => ({
        scope,
        identity: helper,
      })),
      releaseMutex: vi.fn(async () => {}),
    },
    host = {
      identity: helper,
      native,
      storeAuthority: authority,
      processIdentity: vi.fn(async (pid: number) =>
        pid === process.pid ? gui : undefined,
      ),
    } as unknown as HostContext,
    operations = new boundary.Operations(host),
    maintenance = new boundary.Maintenance(host),
    rebind = vi.fn(async () => {
      events.push("rebind");
    }),
    setup = vi.fn(async () => {
      events.push("setup-release");
    }),
    mutation = vi.fn(async () => {
      events.push("mutation-release");
    });
  // The store's real parser is exercised by the native vault fixture.
  native.vaultRead.mockImplementation(async (_scope: string, key: string) =>
    key === "enrollment"
      ? enrollment
        ? Buffer.from(JSON.stringify(enrollment))
        : null
      : rows.get(key)
        ? Buffer.from(rows.get(key)!)
        : null,
  );
  operations.targetImpl.mockResolvedValue({
    sid: old.sid,
    identity: "c".repeat(64),
  });
  operations.lockImpl.mockResolvedValue({ release: setup });
  maintenance.begin.mockResolvedValue({ release: mutation });
  maintenance.finish.mockImplementation(
    async (task: Promise<unknown>, bind: () => Promise<void>) => {
      await task.catch(() => {});
      events.push("end-resume");
      await bind();
    },
  );
  boundary.current
    .mockRejectedValueOnce(Error("FLEET_PREPARE_REQUIRED"))
    .mockResolvedValue({});
  boundary.qualify.mockResolvedValue({});
  const recovery = StoreFleetRecovery.open(
    host,
    operations as unknown as StorePreparationOperations,
    { maintenance: maintenance as unknown as StorePrepareMaintenance, rebind },
  );
  return {
    recovery,
    host,
    rows,
    events,
    operations,
    maintenance,
    native,
    rebind,
    setup,
    mutation,
    setRecord: (value: FleetEnrollmentRecord | null) => {
      enrollment = value;
    },
    enrollment: enrollment!,
  };
}
it("drains/qualifies under original owners, releases Prepare before end/resume, and clears the journal after rebind", async () => {
  const f = fixture();
  await expect(f.recovery.run(new AbortController().signal)).resolves.toBe(
    "requalified",
  );
  expect(f.events).toEqual([
    "setup-release",
    "mutation-release",
    "end-resume",
    "rebind",
    "delete:requalification",
  ]);
  expect(boundary.qualify).toHaveBeenCalledOnce();
  expect(f.recovery.activity()).toEqual({ busy: false, idle: true });
  await expect(inspectStoreFleetRecovery(f.host)).resolves.toEqual({
    recoveryRequired: false,
    invalidState: false,
  });
});
it("retains a lost end acknowledgement and retries only the same task and leases", async () => {
  const f = fixture(),
    failure = Error("LOST_END_ACK");
  f.maintenance.finish.mockRejectedValueOnce(failure);
  await expect(f.recovery.run(new AbortController().signal)).rejects.toBe(
    failure,
  );
  expect(f.recovery.activity().busy).toBe(true);
  expect(f.rows.has("requalification")).toBe(true);
  await expect(f.recovery.close()).rejects.toThrow(
    "FLEET_REQUALIFICATION_RECOVERY_REQUIRED",
  );
  // A closed class intentionally cannot recover; use the original live class
  // in the separate retry case below, never a recreated authority from JSON.
});
it("explicit recovery joins the same failed settlement without replaying qualification", async () => {
  const f = fixture();
  f.rebind.mockRejectedValueOnce(Error("REBIND_FAILED"));
  await expect(f.recovery.run(new AbortController().signal)).rejects.toThrow(
    "REBIND_FAILED",
  );
  await expect(f.recovery.run(new AbortController().signal)).resolves.toBe(
    "requalified",
  );
  expect(boundary.qualify).toHaveBeenCalledOnce();
  expect(f.operations.lockImpl).toHaveBeenCalledOnce();
  expect(f.setup).toHaveBeenCalledOnce();
  expect(f.mutation).toHaveBeenCalledOnce();
  expect(f.rebind).toHaveBeenCalledTimes(2);
});
it("keeps a pending settlement joined and refuses another concurrent run", async () => {
  const f = fixture(),
    waiting = deferred<void>();
  f.setup.mockImplementation(async () => waiting.promise);
  const run = f.recovery.run(new AbortController().signal);
  await vi.waitFor(() => expect(f.setup).toHaveBeenCalledOnce());
  await expect(f.recovery.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_BUSY",
  );
  expect(f.maintenance.finish).not.toHaveBeenCalled();
  waiting.resolve();
  await expect(run).resolves.toBe("requalified");
});
it("rejects a changed enrollment during retained cleanup and never accepts a forged factory owner", async () => {
  const f = fixture();
  f.rebind.mockRejectedValueOnce(Error("REBIND_FAILED"));
  await expect(f.recovery.run(new AbortController().signal)).rejects.toThrow();
  f.setRecord({ ...f.enrollment, machineCredential: "n".repeat(43) });
  await expect(f.recovery.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_RECOVERY_REQUIRED",
  );
  expect(boundary.qualify).toHaveBeenCalledOnce();
  expect(() =>
    StoreFleetRecovery.prototype.authorizesRebind.call(
      Object.create(StoreFleetRecovery.prototype),
    ),
  ).toThrow();
  expect(() =>
    StoreFleetRecovery.open(f.host, {} as StorePreparationOperations, {
      maintenance: f.maintenance as unknown as StorePrepareMaintenance,
      rebind: f.rebind,
    }),
  ).toThrow();
});
it("read-only startup rejects legacy journals, BOMs, duplicate keys and foreign SID", async () => {
  const f = fixture();
  for (const bytes of [
    Buffer.from('{"version":1}'),
    Buffer.from("\uFEFF{}"),
    Buffer.from('{"version":2,"version":2}'),
    Buffer.from('{"sid":"S-1-5-18"}'),
  ]) {
    f.rows.set("requalification", bytes);
    await expect(inspectStoreFleetRecovery(f.host)).resolves.toEqual({
      recoveryRequired: true,
      invalidState: true,
    });
  }
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
  expect(f.native.vaultDelete).not.toHaveBeenCalled();
});
it("does not clear a previous journal when the actual Prepare lock was never acquired", async () => {
  const f = fixture();
  f.operations.lockImpl.mockResolvedValue(null);
  await expect(f.recovery.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_BUSY",
  );
  expect(f.maintenance.begin).not.toHaveBeenCalled();
  expect(f.maintenance.finish).not.toHaveBeenCalled();
  expect(f.native.vaultDelete).not.toHaveBeenCalled();
});

function legacyEnrollment(f: ReturnType<typeof fixture>) {
  const {
    distribution: _distribution,
    storeBinding: _binding,
    ...prepared
  } = f.enrollment.prepared;
  return {
    ...f.enrollment,
    prepared: { ...prepared, archiveDigest: "a".repeat(64) },
  } as FleetEnrollmentRecord;
}
it("startup cannot qualify an old enrollment; only the explicit Repair method admits its original owner", async () => {
  const f = fixture(),
    legacy = legacyEnrollment(f),
    immutable = JSON.stringify(legacy);
  f.setRecord(legacy);
  await expect(f.recovery.run(new AbortController().signal)).rejects.toThrow(
    "FLEET_REQUALIFICATION_RECOVERY_REQUIRED",
  );
  expect(f.operations.lockImpl).not.toHaveBeenCalled();
  expect(boundary.qualify).not.toHaveBeenCalled();
  expect(boundary.legacyQualify).not.toHaveBeenCalled();
  await expect(
    f.recovery.repair(
      new AbortController().signal,
      fleetRecordAuthority(legacyEnrollment(f)),
    ),
  ).resolves.toBe("requalified");
  expect(boundary.legacyQualify).toHaveBeenCalledOnce();
  expect(boundary.qualify).not.toHaveBeenCalled();
  expect(JSON.stringify(legacy)).toBe(immutable);
  expect(
    f.native.vaultWrite.mock.calls.every(
      (call) => call[1] === "requalification",
    ),
  ).toBe(true);
});
it("explicit old-enrollment cleanup retry retains the same task, leases and failed rebind without repeating qualification", async () => {
  const f = fixture();
  f.setRecord(legacyEnrollment(f));
  boundary.current.mockReset().mockResolvedValue({});
  f.rebind.mockRejectedValueOnce(Error("REBIND_FAILED"));
  await expect(
    f.recovery.repair(
      new AbortController().signal,
      fleetRecordAuthority(legacyEnrollment(f)),
    ),
  ).rejects.toThrow("REBIND_FAILED");
  const originalTask = f.maintenance.finish.mock.calls[0]![0];
  await expect(
    f.recovery.repair(
      new AbortController().signal,
      fleetRecordAuthority(legacyEnrollment(f)),
    ),
  ).resolves.toBe("requalified");
  expect(f.maintenance.finish.mock.calls[1]![0]).toBe(originalTask);
  expect(boundary.legacyQualify).toHaveBeenCalledOnce();
  expect(f.operations.lockImpl).toHaveBeenCalledOnce();
  expect(f.setup).toHaveBeenCalledOnce();
  expect(f.mutation).toHaveBeenCalledOnce();
});
it("rejects explicit old-enrollment repair for an existing Store record or forged coordinator before qualification", async () => {
  const f = fixture();
  await expect(
    f.recovery.repair(
      new AbortController().signal,
      fleetRecordAuthority(legacyEnrollment(f)),
    ),
  ).rejects.toThrow("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
  expect(() =>
    StoreFleetRecovery.prototype.repair.call(
      Object.create(StoreFleetRecovery.prototype),
      new AbortController().signal,
      fleetRecordAuthority(f.enrollment),
    ),
  ).toThrow();
  expect(boundary.legacyQualify).not.toHaveBeenCalled();
  expect(f.operations.lockImpl).not.toHaveBeenCalled();
});

it("rejects a changed explicit original-approval selection before creating any repair owner", async () => {
  const f = fixture();
  f.setRecord(legacyEnrollment(f));
  await expect(
    f.recovery.repair(new AbortController().signal, "f".repeat(64)),
  ).rejects.toThrow("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
  expect(f.operations.lockImpl).not.toHaveBeenCalled();
  expect(boundary.legacyQualify).not.toHaveBeenCalled();
});
