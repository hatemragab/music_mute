import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConsumerOwnedProcess } from "../../worker/src/platform/windows/consumer-native.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
import {
  createSessionGpuAdmission,
  createFleetPersonalAdmission,
} from "../src/main/admission/session-admission.js";
import type {
  SessionRuntimeContext,
  SessionChildContext,
} from "../src/main/session/context.js";
import type { PersonalAgentClient } from "../src/main/personal/session-port.js";
import { personalGpu as gpu, personalPeer } from "./personal-fixtures.js";

const boundary = vi.hoisted(() => ({
  fleet: vi.fn(),
  open: vi.fn(),
  readFleetGpu: vi.fn(),
}));
vi.mock("../src/main/fleet/store-session-port.js", () => ({
  openStoreFleetSessionPort: boundary.open,
}));
vi.mock("../src/main/admission/current-gpu.js", () => ({
  readCurrentFleetGpu: boundary.readFleetGpu,
  readCurrentPersonalGpu: vi.fn(),
}));
beforeEach(() => {
  vi.restoreAllMocks();
  boundary.fleet.mockReset();
  boundary.open.mockReset().mockReturnValue({ command: boundary.fleet });
  boundary.readFleetGpu.mockReset().mockResolvedValue(gpu);
});
afterEach(() => vi.restoreAllMocks());

// Business routing fixtures only. No Store package, Job, physical guard,
// qualified GPU or valid private issuer is created by these spies.
function issuerFixture() {
  const issuer = Object.create(StoreNodeIssuer.prototype) as StoreNodeIssuer,
    generation = "e".repeat(64),
    owner: ConsumerOwnedProcess = {
      role: "fleet",
      nonce: "a".repeat(64),
      identity: { ...personalPeer, pid: 200 },
    };
  Object.defineProperty(issuer, "inventorySha256", { value: generation });
  vi.spyOn(StoreNodeIssuer.prototype, "assertNative").mockImplementation(
    (native) => native,
  );
  vi.spyOn(StoreNodeIssuer.prototype, "nodeRole", "get").mockReturnValue(
    "session-agent",
  );
  vi.spyOn(StoreNodeIssuer.prototype, "owner", "get").mockReturnValue(owner);
  return { issuer, generation, owner };
}

it("routes Fleet guard, idle proof, release and priority fencing through the genuine Store port selector", async () => {
  const { issuer, generation, owner } = issuerFixture(),
    stored = new Map<string, Buffer>(),
    native = {
      identity: vi.fn(async () => personalPeer),
      enumerateGpus: vi.fn(async () => [gpu]),
      vaultRead: vi.fn(
        async (_scope: string, key: string) => stored.get(key) ?? null,
      ),
      vaultWrite: vi.fn(async (_scope: string, key: string, bytes: Buffer) => {
        stored.set(key, Buffer.from(bytes));
      }),
      ownedTreeExited: vi.fn(async () => false),
      legacyWorkerConflict: vi.fn(async () => false),
      close: vi.fn(async () => {}),
    },
    context = {
      distribution: "microsoft-store",
      storeIssuer: issuer,
      native,
      configuration: { release: generation },
      openNative: async () => native,
      verifyOwnedPeer: vi.fn(async () => {}),
    } as unknown as SessionRuntimeContext;
  boundary.fleet.mockImplementation(async (_owner, input) => ({
    idle: true,
    held: input.action === "guard_acquire",
    guardNonce: input.action === "guard_acquire" ? "b".repeat(64) : null,
  }));
  const admission = await createSessionGpuAdmission(context, {
    gpu,
    personal: {
      command: vi.fn(async () => ({ ok: true })),
    } as unknown as PersonalAgentClient,
    currentOwner: (role) => (role === "fleet" ? owner : undefined),
    certificateEvents: () => () => {},
  });
  const requestId = randomUUID(),
    base = {
      version: 1,
      kind: "gpu-admission",
      requestId,
      generation: randomUUID(),
      ownerReceipt: owner,
      gpuIdentity: gpu,
    },
    reply = JSON.parse(
      (
        await admission.dispatch(
          Buffer.from(JSON.stringify({ ...base, action: "request_fleet" })),
          owner.identity,
        )
      ).toString(),
    );
  expect(reply.leaseNonce).toMatch(/^[a-f0-9]{64}$/u);
  await admission.dispatch(
    Buffer.from(
      JSON.stringify({
        ...base,
        action: "fleet_yielded",
        leaseNonce: reply.leaseNonce,
      }),
    ),
    owner.identity,
  );
  await admission.close();
  const actions = boundary.fleet.mock.calls.map((call) => call[1].action);
  expect(actions).toContain("guard_acquire");
  expect(actions).toContain("inference_proof");
  expect(actions).toContain("guard_release");
  expect(actions).toContain("admission_pending");
  expect(boundary.open).toHaveBeenCalledWith(context);
  for (const call of boundary.fleet.mock.calls) expect(call[0]).toEqual(owner);
  expect(
    native.vaultRead.mock.calls.some((call) => call[1] === "fleet_ticket"),
  ).toBe(false);
});

it("reads Fleet GPU readiness using the actual Store inventory generation and issuer", async () => {
  const { issuer, generation, owner } = issuerFixture(),
    native = {},
    context = {
      distribution: "microsoft-store",
      storeIssuer: issuer,
      native,
      role: "fleet",
      ownershipNonce: owner.nonce,
      ownerIdentity: owner.identity,
      releaseRoot: "C:\\WindowsApps\\WorkerPackage\\worker",
    } as unknown as SessionChildContext,
    control = vi
      .spyOn(StoreNodeIssuer.prototype, "requestControl")
      .mockImplementation(async (_target, payload) => {
        const input = JSON.parse(Buffer.from(payload).toString());
        return Buffer.from(
          JSON.stringify({
            version: 1,
            kind: "gpu-admission",
            requestId: input.requestId,
            ok: true,
            ...(input.action === "request_fleet"
              ? { leaseNonce: "c".repeat(64), gpuLuid: gpu.luid }
              : { released: true }),
          }),
        );
      }),
    admission = createFleetPersonalAdmission(context);
  await admission.start(() => {});
  expect(boundary.readFleetGpu).toHaveBeenCalledWith(
    native,
    generation,
    issuer,
  );
  expect(control.mock.calls[0]![0]).toBe("session");
  expect(admission.pending()).toBe(false);
  await admission.stop();
  await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(2));
});
