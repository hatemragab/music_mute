import { beforeEach, expect, it, vi } from "vitest";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { parseQualificationEvidence } from "../../worker/src/enrollment/report-builder.js";
import type { HostContext } from "../src/main/host-context.js";
import { StorePreparationOperations } from "../src/main/prepare/store-operations.js";
import {
  STORE_MODEL_READY_KEY,
  parseStoreModelReady,
  type StorePreparationBinding,
} from "../src/main/prepare/store-model-ready.js";
import { PREPARATION_FIXTURE } from "../src/main/prepare/fixture.js";
import {
  PrepareController,
  PrepareFailure,
  type PrepareJournal,
} from "../src/main/prepare/controller.js";
import { DesktopPreparationLifecycle } from "../src/main/prepare/desktop-lifecycle.js";
import { PREPARE_STAGES } from "../src/shared/prepare-contracts.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { sid, bootIdentity, gpu, receipt } from "./fixtures/prepare.js";

// These tests exercise controller sequencing with explicit synthetic ports.
// The production private-brand/OS factory is not replaced in product code and
// no test result establishes Store, process, Job or GPU authority.
const state = vi.hoisted(() => ({
  native: {} as object,
  authority: {} as object,
  code: {} as object,
  binding: undefined as unknown,
  readiness: null as unknown,
  qualification: undefined as unknown,
  fingerprint: undefined as unknown,
  pending: false,
  failCleanup: false,
  workerPresent: true,
  sessionPresent: false,
  openSession: vi.fn(async () => {}),
  probeSession: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  recoverSession: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  write: vi.fn(async (_scope: string, _key: string, _bytes: Buffer) => {}),
  remove: vi.fn(async () => {}),
  model: vi.fn(async () => {}),
  launch: vi.fn(async (_input: unknown) => ({ requestId: "synthetic" })),
  cancel: vi.fn(async () => {}),
  mutation: vi.fn(async () => {}),
  closeCode: vi.fn(async () => {}),
  recoverCode: vi.fn(async () => {}),
  result: vi.fn<() => Promise<unknown>>(),
  openCode: vi.fn<() => Promise<object>>(),
}));
vi.mock("../src/main/browser/store-native.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/main/browser/store-native.js")
    >();
  return {
    ...actual,
    StoreNativeAuthority: class {
      async openWorkerCode() {
        return state.openCode();
      }
      creatorProof() {
        return {};
      }
      async inspectWorker() {
        return {
          version: 1,
          state: state.workerPresent ? "installed" : "missing",
        };
      }
    },
    storeAuthorityForDataNative: (native: object) =>
      native === state.native ? state.authority : undefined,
    StoreWorkerCodeAuthority: class {
      assertDataNative(native: object) {
        if (native !== state.native)
          throw new Error("SYNTHETIC_NATIVE_MISMATCH");
      }
      async preparationBinding() {
        return structuredClone(state.binding);
      }
      async revalidate() {}
      async close() {
        await state.closeCode();
      }
      async recoverClose() {
        await state.recoverCode();
      }
    },
  };
});
vi.mock("../src/main/session/store-session-client.js", () => ({
  StoreSessionClient: class {
    static async open() {
      await state.openSession();
      return new this();
    }
    static async tryOpen() {
      await state.probeSession();
      return state.sessionPresent ? new this() : undefined;
    }
    assertCodeAuthority(code: object) {
      if (code !== state.code) throw new Error("SYNTHETIC_CODE_MISMATCH");
    }
    async launchPrepare(input: unknown) {
      state.pending = true;
      return state.launch(input);
    }
    async awaitPrepareResult() {
      return state.result();
    }
    async cancelPrepare() {
      await state.cancel();
      if (state.failCleanup) throw new Error("SYNTHETIC_JOB_GPU_ACK_LOST");
      state.pending = false;
      return {};
    }
    cleanupPending() {
      return state.pending;
    }
    async recoverCleanup() {
      if (state.pending) await this.cancelPrepare();
    }
    async close() {
      await this.recoverCleanup();
      await state.closeSession();
    }
    async recoverClose() {
      await this.recoverCleanup();
      await state.recoverSession();
    }
  },
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  statfs: async () => ({ bavail: BigInt(10 * 1024 ** 3), bsize: 1n }),
}));
vi.mock("../src/main/prepare/store-model.js", () => ({
  prepareStoreModel: (...args: unknown[]) => state.model(...(args as [])),
}));
vi.mock("../src/main/prepare/store-readiness.js", () => ({
  readStoreReadiness: async () => state.readiness,
}));
vi.mock("../src/main/prepare/private-files.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/main/prepare/private-files.js")
  >()),
  verifyPrivateFile: async (_host: unknown, relative: string) => ({
    sha256: relative.startsWith("models\\")
      ? MODEL.sha256
      : PREPARATION_FIXTURE.sha256,
    fingerprint: state.fingerprint,
  }),
}));
function binding(): StorePreparationBinding {
  const p = STORE_PRODUCTS.worker,
    fullName = `${p.identityName}_0.1.3.2_x64__${p.publisherId}`;
  return {
    package: {
      identityName: p.identityName,
      publisher: p.publisher,
      publisherId: p.publisherId,
      familyName: p.familyName,
      fullName,
      packageVersion: "0.1.3.2",
      architecture: "x64",
      signatureKind: 3,
      healthy: true,
      current: true,
      installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
    },
    inventorySha256: "c".repeat(64),
    runtimeManifestSha256: "b".repeat(64),
    sid,
    bootIdentity,
    recipeDigests: {
      "kim-vocals-v2": "0".repeat(64),
      "kim-vocals-v2-trim": "1".repeat(64),
    },
  };
}
async function fixture() {
  const host = {
    native: state.native,
    identity: { sid, sessionId: 1 },
    personalRoot: "C:\\SyntheticPrivate",
    storeAuthority: state.authority,
    prepareLease: async () => ({ release: state.release }),
  } as unknown as HostContext;
  const operations = await StorePreparationOperations.open(host, {
    assertMutation: state.mutation,
    registerBrowser: async () => true,
    verifyBrowser: async () => true,
  });
  const signal = new AbortController().signal,
    target = await operations.target(signal);
  return { operations, host, signal, target };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.sessionPresent = false;
  state.native = {
    vaultWrite: state.write,
    vaultDelete: state.remove,
    enumerateGpus: async () => [gpu],
  };
  state.code = { close: state.closeCode };
  state.authority = {};
  state.workerPresent = true;
  state.binding = binding();
  state.fingerprint = receipt().modelFingerprint;
  state.pending = false;
  state.failCleanup = false;
  state.readiness = null;
  const raw = receipt().qualification,
    evidence = parseQualificationEvidence(raw, {
      runtimeProfile: "windows-user",
      expectedUserSid: sid,
      expectedFixtureDigest: PREPARATION_FIXTURE.sha256,
    });
  state.qualification = { result: { bootIdentity, raw }, evidence };
  state.result.mockReset().mockImplementation(async () => state.qualification);
  state.openCode.mockReset().mockImplementation(async () => state.code);
});
it("runs mutable model and unchanged qualification stages without an archive or legacy Ready marker (synthetic ports)", async () => {
  const { operations, target, signal } = await fixture(),
    lease = await operations.lock(target);
  expect(lease).not.toBeNull();
  await operations.perform("runtime", target, signal, () => {});
  expect(state.mutation).not.toHaveBeenCalled();
  await operations.perform("model", target, signal, () => {});
  await operations.perform("gpu", target, signal, () => {});
  await operations.perform("activate", target, signal, () => {});
  expect(state.model).toHaveBeenCalledOnce();
  expect(state.launch).toHaveBeenCalledOnce();
  expect(state.cancel).toHaveBeenCalledOnce();
  expect(state.write).toHaveBeenCalledOnce();
  const [scope, key, bytes] = state.write.mock.calls[0]!;
  expect([scope, key]).toEqual(["account", STORE_MODEL_READY_KEY]);
  expect(parseStoreModelReady(bytes, binding()).receipt.distribution).toBe(
    "microsoft-store",
  );
  expect(JSON.parse(bytes.toString())).not.toHaveProperty("archiveSha256");
  await lease!.release();
  expect(state.release).toHaveBeenCalledOnce();
});
it("keeps readonly cached readiness free of model transfer, activation and qualification (synthetic ports)", async () => {
  const { operations, target, signal } = await fixture();
  state.readiness = { synthetic: true };
  expect(await operations.cachedReady(target, signal)).toBe(true);
  expect(await operations.browserReady(target, signal)).toBe(true);
  expect(state.model).not.toHaveBeenCalled();
  expect(state.launch).not.toHaveBeenCalled();
  expect(state.write).not.toHaveBeenCalled();
  expect(state.mutation).not.toHaveBeenCalled();
});
it("retains the original preparation lease and refuses Ready when actual cleanup acknowledgement is uncertain (synthetic ports)", async () => {
  const { operations, target, signal } = await fixture(),
    lease = await operations.lock(target);
  state.failCleanup = true;
  await expect(
    operations.perform("gpu", target, signal, () => {}),
  ).rejects.toThrow("QUALIFICATION_CLEANUP_UNCONFIRMED");
  expect(operations.cleanupPending()).toBe(true);
  await expect(lease!.release()).rejects.toThrow(
    "QUALIFICATION_CLEANUP_UNCONFIRMED",
  );
  await expect(
    operations.perform("activate", target, signal, () => {}),
  ).rejects.toThrow("GPU_UNSUPPORTED");
  expect(state.release).not.toHaveBeenCalled();
  expect(state.write).not.toHaveBeenCalled();
  state.failCleanup = false;
  await operations.recoverCleanup();
  await lease!.release();
  expect(state.release).toHaveBeenCalledOnce();
});
it("denies code generation changes before a receipt can be written (synthetic ports)", async () => {
  const { operations, target, signal } = await fixture(),
    lease = await operations.lock(target);
  await operations.perform("gpu", target, signal, () => {});
  state.binding = { ...binding(), inventorySha256: "d".repeat(64) };
  await expect(
    operations.perform("activate", target, signal, () => {}),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(state.write).not.toHaveBeenCalled();
  await lease!.release();
});
it("requires the living mutation fence and cannot start a second qualification while cleanup is pending (synthetic ports)", async () => {
  const { operations, target, signal } = await fixture();
  await expect(
    operations.perform("model", target, signal, () => {}),
  ).rejects.toThrow("BUSY");
  await operations.lock(target);
  state.mutation.mockRejectedValueOnce(new PrepareFailure("BUSY"));
  await expect(
    operations.perform("gpu", target, signal, () => {}),
  ).rejects.toThrow("BUSY");
  expect(state.launch).not.toHaveBeenCalled();
});
it("tries another qualified GPU only after the failed candidate's exact cleanup, preserving both recipes (synthetic ports)", async () => {
  const { operations, host, target, signal } = await fixture();
  const other = {
    ...gpu,
    deviceIndex: 4,
    luid: "0000000000000043",
    dedicatedVideoMemoryBytes: 2 ** 30,
  };
  Object.assign(host.native, { enumerateGpus: async () => [gpu, other] });
  state.result.mockRejectedValueOnce(new PrepareFailure("GPU_UNSUPPORTED"));
  await operations.lock(target);
  await operations.perform("gpu", target, signal, () => {});
  expect(state.launch).toHaveBeenCalledTimes(2);
  expect(state.cancel).toHaveBeenCalledTimes(2);
  const first = state.launch.mock.calls[0]![0] as {
      gpu: typeof gpu;
      binding: StorePreparationBinding;
      fixture: unknown;
    },
    second = state.launch.mock.calls[1]![0] as typeof first;
  expect([first.gpu.deviceIndex, second.gpu.deviceIndex]).toEqual([4, 3]);
  expect(state.cancel.mock.invocationCallOrder[0]).toBeLessThan(
    state.launch.mock.invocationCallOrder[1]!,
  );
  expect(second.binding.recipeDigests).toEqual(binding().recipeDigests);
  expect(second.fixture).toEqual({ kind: "fixed" });
});
it("never tries the next candidate when retirement of the first GPU attempt is uncertain (synthetic ports)", async () => {
  const { operations, host, target, signal } = await fixture();
  Object.assign(host.native, {
    enumerateGpus: async () => [
      gpu,
      { ...gpu, deviceIndex: 4, luid: "0000000000000043" },
    ],
  });
  state.result.mockRejectedValueOnce(new PrepareFailure("GPU_UNSUPPORTED"));
  state.failCleanup = true;
  await operations.lock(target);
  await expect(
    operations.perform("gpu", target, signal, () => {}),
  ).rejects.toThrow("QUALIFICATION_CLEANUP_UNCONFIRMED");
  expect(state.launch).toHaveBeenCalledOnce();
  expect(operations.cleanupPending()).toBe(true);
});
it("keeps GUI data usable when Worker is absent and acquires code only after actual installed discovery (synthetic ports)", async () => {
  state.workerPresent = false;
  const host = {
      native: state.native,
      identity: { sid, sessionId: 1 },
      storeAuthority: state.authority,
    } as unknown as HostContext,
    options = {
      assertMutation: state.mutation,
      registerBrowser: async () => true,
      verifyBrowser: async () => true,
    },
    operations = await StorePreparationOperations.open(host, options),
    signal = new AbortController().signal;
  expect(state.openCode).not.toHaveBeenCalled();
  await expect(operations.target(signal)).rejects.toThrow(
    "NATIVE_HELPER_UNAVAILABLE",
  );
  expect(state.openCode).not.toHaveBeenCalled();
  expect(state.closeCode).not.toHaveBeenCalled();
  state.workerPresent = true;
  await operations.target(signal);
  expect(state.openCode).toHaveBeenCalledOnce();
  expect(state.model).not.toHaveBeenCalled();
  expect(state.launch).not.toHaveBeenCalled();
});
it("passive actual absence never activates or poisons a later explicitly activated borrowed client (synthetic ports)", async () => {
  const { operations, signal } = await fixture();
  await expect(
    operations.controlSession(signal, { launchIfAbsent: false }),
  ).resolves.toBeUndefined();
  expect(state.probeSession).toHaveBeenCalledOnce();
  expect(state.openSession).not.toHaveBeenCalled();
  const owner = await operations.controlSession(signal),
    borrowed = await operations.controlSession(signal, {
      launchIfAbsent: false,
    });
  expect(owner).toBe(borrowed);
  expect(await operations.maintenanceSession(signal)).toBe(owner);
  expect(state.openSession).toHaveBeenCalledOnce();
  expect(state.closeSession).not.toHaveBeenCalled();
  expect(state.model).not.toHaveBeenCalled();
  expect(state.launch).not.toHaveBeenCalled();
  await operations.close();
  expect(state.closeSession).toHaveBeenCalledOnce();
});
it("retains the original rejected passive bind instead of treating it as absence or activating a second owner (synthetic ports)", async () => {
  const { operations, signal } = await fixture(),
    failure = new Error("SYNTHETIC_BIND_ACK_UNKNOWN");
  state.sessionPresent = true;
  state.probeSession.mockRejectedValueOnce(failure);
  await expect(
    operations.controlSession(signal, { launchIfAbsent: false }),
  ).rejects.toBe(failure);
  await expect(operations.controlSession(signal)).rejects.toBe(failure);
  await expect(operations.close()).rejects.toBe(failure);
  expect(state.probeSession).toHaveBeenCalledOnce();
  expect(state.openSession).not.toHaveBeenCalled();
  expect(state.closeCode).not.toHaveBeenCalled();
});
it("retries the same failed Session cleanup before releasing code and serializes concurrent shutdown callers (synthetic ports)", async () => {
  const { operations, signal } = await fixture();
  await operations.controlSession(signal);
  const failure = new Error("SYNTHETIC_CLOSE_ACK_LOST");
  state.closeSession.mockRejectedValueOnce(failure);
  const original = operations.close();
  expect(operations.close()).toBe(original);
  await expect(original).rejects.toBe(failure);
  expect(state.closeCode).not.toHaveBeenCalled();
  state.recoverSession.mockRejectedValueOnce(failure);
  const retry = operations.close();
  expect(retry).not.toBe(original);
  expect(operations.close()).toBe(retry);
  await expect(retry).rejects.toBe(failure);
  expect(state.closeCode).not.toHaveBeenCalled();
  await expect(operations.close()).resolves.toBeUndefined();
  expect(state.openSession).toHaveBeenCalledOnce();
  expect(state.closeSession).toHaveBeenCalledOnce();
  expect(state.recoverSession).toHaveBeenCalledTimes(2);
  expect(state.closeCode).toHaveBeenCalledOnce();
  await expect(original).rejects.toBe(failure);
});
it("recovers only the originally acquired code owner after its close reply is lost (synthetic ports)", async () => {
  const { operations } = await fixture(),
    failure = new Error("SYNTHETIC_CODE_CLOSE_ACK_LOST");
  state.closeCode.mockRejectedValueOnce(failure);
  const original = operations.close();
  await expect(original).rejects.toBe(failure);
  await expect(operations.close()).resolves.toBeUndefined();
  expect(state.closeCode).toHaveBeenCalledOnce();
  expect(state.recoverCode).toHaveBeenCalledOnce();
  expect(state.openCode).toHaveBeenCalledOnce();
  await expect(original).rejects.toBe(failure);
});

it("reuses only an existing private fresh qualification after current exact evidence validates", async () => {
  const { operations, target, signal } = await fixture(),
    lease = await operations.lock(target);
  await operations.perform("gpu", target, signal, () => {});
  const current = state.qualification as { evidence: unknown };
  state.readiness = { binding: binding(), evidence: current.evidence };
  await operations.perform("gpu", target, signal, () => {});
  expect(state.launch).toHaveBeenCalledOnce();
  state.readiness = { binding: binding(), evidence: {} };
  await operations.perform("gpu", target, signal, () => {});
  expect(state.launch).toHaveBeenCalledTimes(2);
  await lease!.release();
});
it("a reflected Ready receipt without this private qualification cannot skip a new actual qualification", async () => {
  const { operations, target, signal } = await fixture(),
    lease = await operations.lock(target);
  state.readiness = {
    binding: binding(),
    evidence: (state.qualification as { evidence: unknown }).evidence,
  };
  await operations.perform("gpu", target, signal, () => {});
  expect(state.launch).toHaveBeenCalledOnce();
  await lease!.release();
});
it("after approved repair settlement the genuine existing controller completes its own journal and Ready view without repeating GPU work", async () => {
  const { operations, target, signal } = await fixture(),
    repairLease = await operations.lock(target),
    events: string[] = [];
  await operations.requalifyInstalled(signal);
  state.readiness = {
    binding: binding(),
    evidence: (state.qualification as { evidence: unknown }).evidence,
  };
  await repairLease!.release();
  events.push("repair-lease-released", "repair-maintenance-settled");
  let journal: PrepareJournal = {
    version: 1,
    transaction: "00000000-0000-4000-8000-000000000001",
    target: "f".repeat(64),
    sid,
    state: "complete",
    completed: [...PREPARE_STAGES],
  };
  const originalJournal = structuredClone(journal),
    controller = new PrepareController(operations, {
      read: async () => journal,
      write: async (value) => {
        journal = structuredClone(value);
        events.push(`journal:${journal.state}:${journal.completed.length}`);
      },
    }),
    lifecycle = new DesktopPreparationLifecycle();
  lifecycle.suppressAutomatic();
  expect(
    lifecycle.startAutomatic(
      {
        current: () => true,
        start: () => controller.start(),
        cancel: () => controller.cancel(),
        settle: async () => {},
        rebind: [],
        ready: () => {},
        failed: () => {},
        setup: () => {},
      },
      () => true,
    ),
  ).toBeNull();
  const ready = vi.fn(),
    task = controller.start();
  await lifecycle.observe(task, {
    current: () => true,
    start: () => controller.start(),
    cancel: () => controller.cancel(),
    settle: async (original) => {
      expect(original).toBe(task);
      await original;
      events.push("prepare-maintenance-settled");
    },
    rebind: [],
    ready,
    failed: () => {},
    setup: () => {},
  });
  expect(controller.view().state).toBe("ready");
  expect(journal.target).toBe(target.identity);
  expect(journal.state).toBe("complete");
  expect(journal.completed).toEqual(PREPARE_STAGES);
  expect(originalJournal.target).toBe("f".repeat(64));
  expect(state.launch).toHaveBeenCalledOnce();
  expect(ready).toHaveBeenCalledOnce();
  expect(events[0]).toBe("repair-lease-released");
  expect(events[1]).toBe("repair-maintenance-settled");
  expect(events.at(-1)).toBe("prepare-maintenance-settled");
  expect(state.release).toHaveBeenCalledTimes(2);
});

it("the follow-on controller cannot publish a complete journal or Ready view when current Store readiness fails its final check", async () => {
  const { operations, target } = await fixture();
  let journal: PrepareJournal | null = null;
  const controller = new PrepareController(operations, {
    read: async () => journal,
    write: async (value) => {
      journal = structuredClone(value);
    },
  });
  const view = await controller.start();
  expect(view.state).toBe("error");
  expect(view.errorCode).toBe("INTEGRITY_INVALID");
  expect(journal).toMatchObject({ target: target.identity, state: "failed" });
  expect(state.release).toHaveBeenCalledOnce();
});
