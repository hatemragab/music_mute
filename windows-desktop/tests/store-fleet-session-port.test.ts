import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ControlPlaneError,
  WorkerControlPlaneClient,
} from "../../worker/src/runtime/control-plane-client.js";
import type { ConsumerOwnedProcess } from "../../worker/src/platform/windows/consumer-native.js";
import { StoreRuntimeContext } from "../src/main/session/store-runtime-context.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
import { VaultFleetStore } from "../src/main/fleet/store.js";
import { openStoreFleetSessionPort } from "../src/main/fleet/store-session-port.js";
import {
  parseFleetChildCommand,
  parseFleetChildReply,
} from "../src/main/fleet/channel.js";
import { record, fleetSid } from "./fleet-fixtures.js";

const boundary = vi.hoisted(() => ({ active: vi.fn(), removed: vi.fn() }));
vi.mock("../src/main/fleet/store-active-runtime.js", () => ({
  readStoreFleetRuntimeIdentity: boundary.active,
}));
vi.mock("../src/main/fleet/advanced/removal-marker.js", () => ({
  consumerFleetRemoved: boundary.removed,
}));
beforeEach(() => {
  vi.restoreAllMocks();
  boundary.active.mockReset();
  boundary.removed.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

// Synthetic business boundaries only. Spies do not create an installed Store
// context, a Creator-owned Job, a GPU grant or successful native execution.
function fixture() {
  const enrollment = record(),
    issuer = Object.create(StoreNodeIssuer.prototype) as StoreNodeIssuer,
    native = { identity: vi.fn(async () => ({ sid: fleetSid })) },
    binding = {
      inventorySha256: enrollment.prepared.release,
      runtimeManifestSha256: enrollment.prepared.manifestDigest,
      sid: fleetSid,
      bootIdentity: enrollment.prepared.bootIdentity,
    },
    context = {
      native,
      storeIssuer: issuer,
      binding,
      distribution: "microsoft-store",
      generation: enrollment.prepared.release,
      configuration: { release: enrollment.prepared.release },
    } as unknown as StoreRuntimeContext,
    owner: ConsumerOwnedProcess = {
      role: "fleet",
      nonce: "f".repeat(64),
      identity: {
        sid: fleetSid,
        sessionId: 1,
        pid: 700,
        creationTime: "133900000000000000",
      },
    };
  Object.defineProperty(issuer, "inventorySha256", {
    value: context.generation,
  });
  vi.spyOn(StoreRuntimeContext.prototype, "assertNative").mockImplementation(
    function (this: StoreRuntimeContext, value) {
      if (this !== context || (value as unknown) !== native)
        throw new Error("DENIED");
    },
  );
  vi.spyOn(StoreNodeIssuer.prototype, "nodeRole", "get").mockReturnValue(
    "session-agent",
  );
  vi.spyOn(StoreNodeIssuer.prototype, "assertNative").mockImplementation(
    function (this: StoreNodeIssuer, value) {
      if (this !== issuer || (value as unknown) !== native)
        throw new Error("DENIED");
      return value;
    },
  );
  const codeView = vi
      .spyOn(StoreNodeIssuer.prototype, "codeView")
      .mockResolvedValue({ binding } as Awaited<
        ReturnType<StoreNodeIssuer["codeView"]>
      >),
    peer = vi
      .spyOn(StoreRuntimeContext.prototype, "verifyOwnedPeer")
      .mockResolvedValue(),
    request = vi
      .spyOn(StoreNodeIssuer.prototype, "requestControl")
      .mockImplementation(async (_target, payload) => {
        const command = parseFleetChildCommand(payload);
        return Buffer.from(
          JSON.stringify({
            version: 1,
            requestId: command.requestId,
            ok: true,
            code: null,
            data: { idle: true, held: false, guardNonce: null },
          }),
        );
      }),
    read = vi
      .spyOn(VaultFleetStore.prototype, "read")
      .mockResolvedValue(enrollment),
    status = vi
      .spyOn(WorkerControlPlaneClient.prototype, "machineStatus")
      .mockResolvedValue({ machineId: enrollment.machineId } as Awaited<
        ReturnType<WorkerControlPlaneClient["machineStatus"]>
      >);
  boundary.active.mockResolvedValue({
    release: context.generation,
    storeBinding: structuredClone(binding),
  });
  return {
    context,
    issuer,
    native,
    owner,
    binding,
    enrollment,
    codeView,
    peer,
    request,
    read,
    status,
    port: openStoreFleetSessionPort(context),
  };
}

it("rejects a forged context before invoking its native or issuer getters", () => {
  const getter = vi.fn(),
    value = Object.create(StoreRuntimeContext.prototype);
  Object.defineProperty(value, "native", { get: getter });
  Object.defineProperty(value, "storeIssuer", { get: getter });
  expect(() => openStoreFleetSessionPort(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const native = { identity: vi.fn() },
    forged = Object.assign(Object.create(StoreRuntimeContext.prototype), {
      native,
    });
  expect(() => openStoreFleetSessionPort(forged)).toThrow();
  expect(native.identity).not.toHaveBeenCalled();
});

it("uses the actual Store owned channel and verifies the original peer on both sides", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  expect(
    await f.port.command(f.owner, { action: "inference_proof" }, signal),
  ).toEqual({ idle: true, held: false, guardNonce: null });
  expect(f.peer).toHaveBeenNthCalledWith(1, f.owner, f.owner.identity);
  expect(f.peer).toHaveBeenNthCalledWith(2, f.owner, f.owner.identity);
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.request.mock.calls[0]![0]).toBe("fleet");
  expect(f.request.mock.calls[0]![3]).toEqual(f.owner);
  expect(f.request.mock.calls[0]![3]).not.toBe(f.owner);
  expect(parseFleetChildCommand(f.request.mock.calls[0]![1]).action).toBe(
    "inference_proof",
  );
  expect(f.read).not.toHaveBeenCalled();
});

it("denies a replaced tree after a successful reply and never replays the command", async () => {
  const f = fixture();
  f.peer
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("STALE_OWNER"));
  await expect(
    f.port.command(f.owner, { action: "stop" }, new AbortController().signal),
  ).rejects.toThrow("STALE_OWNER");
  expect(f.request).toHaveBeenCalledOnce();
});

it("retains the original owner across caller mutation during a request", async () => {
  const f = fixture(),
    original = structuredClone(f.owner);
  f.request.mockImplementation(async (_target, payload) => {
    f.owner.nonce = "9".repeat(64);
    f.owner.identity.pid = 900;
    const command = parseFleetChildCommand(payload);
    return Buffer.from(
      JSON.stringify({
        version: 1,
        requestId: command.requestId,
        ok: true,
        code: null,
      }),
    );
  });
  await f.port.command(
    f.owner,
    { action: "reconcile" },
    new AbortController().signal,
  );
  expect(f.peer).toHaveBeenNthCalledWith(1, original, original.identity);
  expect(f.peer).toHaveBeenNthCalledWith(2, original, original.identity);
  expect(f.request.mock.calls[0]![3]).toEqual(original);
});

it("does not invoke owner getters or accept missing birth before request effects", async () => {
  const f = fixture(),
    getter = vi.fn(),
    owner = { ...f.owner };
  Object.defineProperty(owner, "identity", { enumerable: true, get: getter });
  await expect(
    f.port.command(
      owner,
      { action: "reconcile" },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  await expect(
    f.port.command(
      { ...f.owner, identity: { ...f.owner.identity, creationTime: "0" } },
      { action: "reconcile" },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});

it("rejects command accessors and hidden serialization fields before request effects", async () => {
  const f = fixture(),
    getter = vi.fn(() => "reconcile"),
    signal = new AbortController().signal,
    accessor = {};
  Object.defineProperty(accessor, "action", { enumerable: true, get: getter });
  const toJSON = vi.fn(() => ({ action: "reconcile" }));
  const scalarJSON = vi.fn(() => "reconcile"),
    intentJSON = vi.fn(() => "paused");
  for (const input of [
    accessor,
    { action: "reconcile", extra: undefined },
    { action: "reconcile", [Symbol("hidden")]: true },
    { action: "reconcile", toJSON },
    { action: { toJSON: scalarJSON } },
    { action: "intent", intent: { toJSON: intentJSON } },
  ])
    await expect(
      f.port.command(
        f.owner,
        input as Parameters<typeof f.port.command>[1],
        signal,
      ),
    ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(toJSON).not.toHaveBeenCalled();
  expect(scalarJSON).not.toHaveBeenCalled();
  expect(intentJSON).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});

it.each(["foreign-role", "aborted", "changed-code", "invalid-command"])(
  "denies %s before Store request effects",
  async (scenario) => {
    const f = fixture(),
      controller = new AbortController();
    let owner = f.owner,
      input = { action: "reconcile" } as Parameters<typeof f.port.command>[1];
    if (scenario === "foreign-role") owner = { ...owner, role: "personal" };
    if (scenario === "aborted") controller.abort();
    if (scenario === "changed-code")
      f.codeView.mockResolvedValue({
        binding: { ...f.binding, bootIdentity: "9".repeat(64) },
      } as Awaited<ReturnType<StoreNodeIssuer["codeView"]>>);
    if (scenario === "invalid-command")
      input = { action: "guard_acquire", gpuLuid: "invalid" };
    await expect(
      f.port.command(owner, input, controller.signal),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  },
);

it("preserves explicit Store qualification plus independent backend approval", async () => {
  const f = fixture();
  expect(await f.port.eligibility()).toEqual({
    enrolled: true,
    approved: true,
    prepared: true,
  });
  expect(boundary.active).toHaveBeenCalledWith(
    f.issuer,
    f.enrollment,
    expect.any(AbortSignal),
  );
  expect(f.status).toHaveBeenCalledOnce();
});

it.each(["missing", "incomplete", "removed"])(
  "does not launch or query backend for %s enrollment",
  async (scenario) => {
    const f = fixture();
    if (scenario === "missing") f.read.mockResolvedValue(null);
    if (scenario === "incomplete") f.read.mockResolvedValue(record("reported"));
    if (scenario === "removed") boundary.removed.mockResolvedValue(true);
    expect(await f.port.eligibility()).toEqual({
      enrolled: false,
      approved: false,
      prepared: false,
    });
    expect(boundary.active).not.toHaveBeenCalled();
    expect(f.status).not.toHaveBeenCalled();
  },
);

it.each(["release", "binding", "unqualified"])(
  "keeps %s state unprepared despite backend approval",
  async (scenario) => {
    const f = fixture();
    if (scenario === "release")
      boundary.active.mockResolvedValue({
        release: "9".repeat(64),
        storeBinding: f.binding,
      });
    if (scenario === "binding")
      boundary.active.mockResolvedValue({
        release: f.context.generation,
        storeBinding: { ...f.binding, bootIdentity: "9".repeat(64) },
      });
    if (scenario === "unqualified")
      boundary.active.mockRejectedValue(new Error("FLEET_PREPARE_REQUIRED"));
    expect(await f.port.eligibility()).toEqual({
      enrolled: true,
      approved: true,
      prepared: false,
    });
  },
);

it.each([
  ["WORKER_UNAUTHENTICATED", 401, true, false],
  ["WORKER_FORBIDDEN", 403, true, false],
  ["WORKER_MACHINE_DELETED", 404, true, false],
  ["WORKER_DEPENDENCY_UNAVAILABLE", 503, true, true],
  ["WORKER_CONFLICT", 409, false, false],
] as const)(
  "preserves backend denial/transient policy for %s",
  async (code, status, retryable, approved) => {
    const f = fixture();
    f.status.mockRejectedValue(new ControlPlaneError(code, status, retryable));
    expect(await f.port.eligibility()).toEqual({
      enrolled: true,
      approved,
      prepared: true,
    });
  },
);

it("rejects code replacement during backend observation", async () => {
  const f = fixture();
  f.status.mockImplementation(async () => {
    f.codeView.mockResolvedValue({
      binding: { ...f.binding, inventorySha256: "9".repeat(64) },
    } as Awaited<ReturnType<StoreNodeIssuer["codeView"]>>);
    return { machineId: f.enrollment.machineId } as Awaited<
      ReturnType<WorkerControlPlaneClient["machineStatus"]>
    >;
  });
  await expect(f.port.eligibility()).rejects.toThrow(
    "STORE_SESSION_CONTEXT_DENIED",
  );
});

it.each(["replaced-enrollment", "removed", "changed-active"])(
  "denies stale positive eligibility after %s during backend observation",
  async (scenario) => {
    const f = fixture();
    f.status.mockImplementation(async () => {
      if (scenario === "replaced-enrollment")
        f.read.mockResolvedValue({ ...f.enrollment, phase: "revoked" });
      if (scenario === "removed") boundary.removed.mockResolvedValue(true);
      if (scenario === "changed-active")
        boundary.active.mockResolvedValue({
          release: f.context.generation,
          storeBinding: { ...f.binding, bootIdentity: "9".repeat(64) },
        });
      return { machineId: f.enrollment.machineId } as Awaited<
        ReturnType<WorkerControlPlaneClient["machineStatus"]>
      >;
    });
    expect(await f.port.eligibility()).toEqual(
      scenario === "changed-active"
        ? { enrolled: true, approved: true, prepared: false }
        : { enrolled: false, approved: false, prepared: false },
    );
  },
);

it("maps reconcile, saved intent, stop and sleep to the same owned channel", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  await f.port.reconcile(f.owner, signal);
  await f.port.setIntent(f.owner, "paused", signal);
  await f.port.gracefulStop(f.owner, signal);
  await f.port.pauseForSleep(f.owner, signal);
  expect(
    f.request.mock.calls.map((call) => parseFleetChildCommand(call[1]).action),
  ).toEqual(["reconcile", "intent", "stop", "sleep"]);
});

it("rejects malformed, duplicate, mismatched, unbound or foreign-error replies", () => {
  const requestId = randomUUID(),
    valid = { version: 1, requestId, ok: true, code: null },
    encode = (value: unknown) => Buffer.from(JSON.stringify(value));
  expect(parseFleetChildReply(encode(valid), requestId)).toBeUndefined();
  for (const value of [
    { ...valid, requestId: randomUUID() },
    { ...valid, code: "FLEET_CONTROL_UNAVAILABLE" },
    { ...valid, extra: true },
    { ...valid, data: { idle: true, held: true, guardNonce: null } },
    {
      ...valid,
      data: { idle: true, held: false, guardNonce: null, extra: true },
    },
    { ...valid, ok: false, code: "PRIVATE_ERROR" },
  ])
    expect(() => parseFleetChildReply(encode(value), requestId)).toThrow();
  expect(() =>
    parseFleetChildReply(
      Buffer.from(
        JSON.stringify(valid).replace('"version":1', '"version":1,"version":1'),
      ),
      requestId,
    ),
  ).toThrow("FLEET_CHANNEL_INVALID");
  expect(() =>
    parseFleetChildReply(
      Buffer.from(`\ufeff${JSON.stringify(valid)}`),
      requestId,
    ),
  ).toThrow("FLEET_CHANNEL_INVALID");
  expect(() =>
    parseFleetChildReply(Buffer.from([0xff, 0xff]), requestId),
  ).toThrow("FLEET_CHANNEL_INVALID");
  expect(() =>
    parseFleetChildReply(
      encode({ ...valid, ok: false, code: "FLEET_GPU_BUSY" }),
      requestId,
    ),
  ).toThrow("FLEET_GPU_BUSY");
});
