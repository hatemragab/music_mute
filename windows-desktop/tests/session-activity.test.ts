import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createSessionDispatcher,
  SessionClient,
} from "../src/main/session/control.js";
import type { SessionSupervisor } from "../src/main/session/supervisor.js";
import type { PersonalAgentClient } from "../src/main/personal/session-port.js";
import type {
  ConsumerOwnedProcess,
  WindowsConsumerNative,
} from "../../worker/src/platform/windows/consumer-native.js";
import type { SessionSnapshot } from "../src/shared/session-contracts.js";
const peer = {
    pid: 20,
    creationTime: "133700000000002",
    sid: "S-1-5-21-1-2-3-1001",
    sessionId: 2,
  },
  owner: ConsumerOwnedProcess = {
    role: "personal",
    nonce: "a".repeat(64),
    identity: { ...peer, pid: 40 },
  },
  snapshot: SessionSnapshot = {
    version: 1,
    instance_id: randomUUID(),
    release: "b".repeat(64),
    revision: 2,
    phase: "running",
    fleet: { intent: "paused", phase: "stopped", problem: null },
    personal: { owners: 1, phase: "stopped", problem: null },
    startup: "registered",
    maintenance: { transaction: randomUUID(), phase: "idle" },
  };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
it("real session activity client fills one closed wake and server authenticates the actual owned Job before querying maintenance", async () => {
  const verify = vi.fn(async () => {}),
    refresh = vi.fn(async () => snapshot),
    dispatcher = createSessionDispatcher(
      { refreshMaintenance: refresh } as unknown as SessionSupervisor,
      {} as PersonalAgentClient,
      { dispatch: vi.fn() },
      undefined,
      undefined,
      verify,
    ),
    client = new SessionClient({} as WindowsConsumerNative);
  const exchange = vi
    .spyOn(client, "exchange")
    .mockImplementation((payload) => dispatcher.dispatch(payload, peer));
  expect(await client.notifyPersonalActivity(owner)).toEqual(snapshot);
  expect(verify).toHaveBeenCalledExactlyOnceWith(owner, peer);
  expect(refresh).toHaveBeenCalledExactlyOnceWith(owner);
  const request = JSON.parse(
    Buffer.from(exchange.mock.calls[0]![0]).toString(),
  );
  expect(Object.keys(request).sort()).toEqual([
    "kind",
    "ownerReceipt",
    "request_id",
    "version",
  ]);
  expect(request.kind).toBe("personal-activity");
});
it("ordinary signed-user peer or caller-supplied idle/version/owner claims cannot advance maintenance", async () => {
  const verify = vi.fn(async () => {
      throw new Error("GPU_OWNER_DENIED");
    }),
    refresh = vi.fn(async () => snapshot),
    dispatcher = createSessionDispatcher(
      { refreshMaintenance: refresh } as unknown as SessionSupervisor,
      {} as PersonalAgentClient,
      { dispatch: vi.fn() },
      undefined,
      undefined,
      verify,
    ),
    request = {
      version: 1,
      kind: "personal-activity",
      request_id: randomUUID(),
      ownerReceipt: owner,
    };
  await expect(dispatcher.dispatch(encode(request), peer)).rejects.toThrow(
    "GPU_OWNER_DENIED",
  );
  expect(refresh).not.toHaveBeenCalled();
  for (const bad of [
    { ...request, idle: true },
    { ...request, version: 2 },
    { ...request, ownerReceipt: { ...owner, role: "fleet" } },
    {
      ...request,
      ownerReceipt: {
        ...owner,
        identity: { ...peer, pid: 40, extra: "private" },
      },
    },
  ])
    await expect(dispatcher.dispatch(encode(bad), peer)).rejects.toThrow(
      "PEER_DENIED",
    );
  await expect(
    dispatcher.dispatch(
      Buffer.from(
        JSON.stringify(request).replace(
          '"version":1',
          '"version":1,"version":1',
        ),
      ),
      peer,
    ),
  ).rejects.toThrow("INVALID_JSON");
  expect(verify).toHaveBeenCalledOnce();
});
it("activity client rejects altered reply identity/raw extras rather than accepting a fabricated idle snapshot", async () => {
  const client = new SessionClient({} as WindowsConsumerNative);
  vi.spyOn(client, "exchange").mockResolvedValue(
    encode({
      version: 1,
      request_id: randomUUID(),
      ok: true,
      snapshot,
      private: "secret",
    }),
  );
  await expect(client.notifyPersonalActivity(owner)).rejects.toThrow(
    "SESSION_UNAVAILABLE",
  );
  await expect(
    client.notifyPersonalActivity({ ...owner, role: "fleet" }),
  ).rejects.toThrow("PEER_DENIED");
});
