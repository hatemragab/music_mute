import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountRealtimeClient,
  type AccountSocket,
  type AccountTransport,
  type AccountSnapshot,
} from "../src/companion/account-realtime.js";
import {
  DesktopApiError,
  type AccountScope,
} from "../src/companion/account-api.js";

const scope: AccountScope = {
  firebase_uid: "owner-a",
  session_generation: "38b8e310-4805-42f2-b065-447b031c542e",
};
const id = "0123456789abcdef01234567";
class Socket implements AccountSocket {
  readyState = 1 as const;
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  send = vi.fn();
  close = vi.fn();
  frame(value: unknown) {
    this.onmessage?.call(
      this as unknown as WebSocket,
      { data: JSON.stringify(value) } as MessageEvent,
    );
  }
  closed(code = 1006) {
    this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent);
  }
  controls(): Record<string, unknown>[] {
    return this.send.mock.calls.map(
      ([value]) => JSON.parse(value as string) as Record<string, unknown>,
    );
  }
}
function harness() {
  let current = true;
  const request = vi
    .fn<AccountTransport["request"]>()
    .mockImplementation(async (_scope, path, method) => {
      expect(path).toBe("/realtime-tickets");
      expect(method).toBe("POST");
      return {
        path: "/realtime/socket",
        protocol: "musicmute.realtime.v1",
        ticket: "a".repeat(43),
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      };
    });
  const api: AccountTransport = {
    origin: "https://api.music-mute.com",
    request,
    assertCurrent(candidate) {
      if (
        !current ||
        candidate.firebase_uid !== scope.firebase_uid ||
        candidate.session_generation !== scope.session_generation
      )
        throw new DesktopApiError("ACCOUNT_CHANGED");
    },
  };
  const sockets: Socket[] = [];
  const factory = vi.fn((_url: string, _protocols: string[]) => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  });
  const client = new AccountRealtimeClient({ api, scope, socket: factory });
  const values: AccountSnapshot[] = [];
  const off = client.watch("job", { id }, (value) => values.push(value));
  client.start();
  return {
    client,
    request,
    factory,
    sockets,
    values,
    off,
    changeOwner() {
      current = false;
    },
  };
}
const ready = (socket: Socket, stream = "stream-a") =>
  socket.frame({ type: "ready", protocol_version: 1, stream_id: stream });
const snapshot = (
  socket: Socket,
  sequence: number,
  data: unknown,
  stream = "stream-a",
  subscription = "s1",
) =>
  socket.frame({
    type: "snapshot",
    protocol_version: 1,
    stream_id: stream,
    subscription_id: subscription,
    sequence,
    data,
  });
afterEach(() => {
  vi.useRealTimers();
});
describe("portable account raw realtime", () => {
  it("keeps tickets in subprotocols and delivers full snapshots with zero GET polling", async () => {
    const h = harness();
    await Promise.resolve();
    expect(h.factory).toHaveBeenCalledWith(
      "wss://api.music-mute.com/realtime/socket",
      ["musicmute.realtime.v1", `ticket.${"a".repeat(43)}`],
    );
    ready(h.sockets[0]!);
    snapshot(h.sockets[0]!, 1, { status: "processing" });
    expect(h.sockets[0]!.controls()[0]).toEqual({
      type: "subscribe",
      subscription_id: "s1",
      resource: "job",
      params: { id },
    });
    expect(h.values).toEqual([{ data: { status: "processing" } }]);
    expect(h.client.getState()).toBe("live");
    expect(h.request).toHaveBeenCalledTimes(1);
    h.client.close();
  });
  it("ignores stale streams and duplicates, requests resync on a gap and fences older gap frames", async () => {
    const h = harness();
    await Promise.resolve();
    const socket = h.sockets[0]!;
    ready(socket);
    snapshot(socket, 1, { revision: 1 });
    snapshot(socket, 1, { revision: 999 });
    snapshot(socket, 2, { revision: 999 }, "old-stream");
    snapshot(socket, 3, { revision: 3 });
    snapshot(socket, 2, { revision: 2 });
    expect(h.values).toEqual([{ data: { revision: 1 } }]);
    expect(h.client.getState()).toBe("reconnecting");
    expect(socket.controls().at(-1)).toEqual({
      type: "resync",
      subscription_id: "s1",
    });
    snapshot(socket, 4, { revision: 4 });
    expect(h.values.at(-1)).toEqual({ data: { revision: 4 } });
    expect(h.client.getState()).toBe("live");
    h.client.close();
  });
  it("reconnects with a fresh ticket/full subscription and cannot accept old socket callbacks", async () => {
    vi.useFakeTimers();
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    const old = h.sockets[0]!;
    ready(old);
    snapshot(old, 1, { revision: 1 });
    const oldHandler = old.onmessage;
    old.closed();
    expect(h.client.getState()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.request).toHaveBeenCalledTimes(2);
    const next = h.sockets[1]!;
    ready(next, "stream-b");
    oldHandler?.call(
      old as unknown as WebSocket,
      {
        data: JSON.stringify({
          type: "snapshot",
          protocol_version: 1,
          stream_id: "stream-a",
          subscription_id: "s1",
          sequence: 2,
          data: { private: "late" },
        }),
      } as MessageEvent,
    );
    expect(h.values).toHaveLength(1);
    snapshot(next, 1, { revision: 2 }, "stream-b");
    expect(h.values.at(-1)).toEqual({ data: { revision: 2 } });
    h.client.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears owner snapshots and stops before delivery on account change", async () => {
    const h = harness();
    await Promise.resolve();
    const socket = h.sockets[0]!;
    ready(socket);
    snapshot(socket, 1, { revision: 1 });
    h.changeOwner();
    snapshot(socket, 2, { private: "owner-a" });
    expect(h.values.at(-1)?.error?.code).toBe("ACCOUNT_CHANGED");
    expect(h.values.filter((value) => value.data)).toHaveLength(1);
    expect(h.client.getState()).toBe("stopped");
    expect(socket.close).toHaveBeenCalledOnce();
    h.client.close();
  });
  it("fences a switch made by one listener before another sees the same private snapshot", async () => {
    const h = harness();
    await Promise.resolve();
    const socket = h.sockets[0]!;
    ready(socket);
    const second = vi.fn();
    h.client.watch("job", { id }, () => h.changeOwner());
    h.client.watch("job", { id }, second);
    snapshot(socket, 1, { private: "owner-a" });
    expect(
      second.mock.calls.every(
        ([value]) => value.error?.code === "ACCOUNT_CHANGED",
      ),
    ).toBe(true);
    expect(h.client.getState()).toBe("stopped");
    h.client.close();
  });
  it.each(["ready", "subscription", "heartbeat"])(
    "enforces the %s deadline without HTTP status reads",
    async (kind) => {
      vi.useFakeTimers();
      const h = harness();
      await vi.advanceTimersByTimeAsync(0);
      const socket = h.sockets[0]!;
      if (kind !== "ready") ready(socket);
      if (kind === "heartbeat") snapshot(socket, 1, {});
      await vi.advanceTimersByTimeAsync(
        kind === "ready" ? 10_000 : kind === "subscription" ? 15_000 : 65_000,
      );
      expect(socket.close).toHaveBeenCalledOnce();
      expect(h.client.getState()).toBe("reconnecting");
      expect(h.request).toHaveBeenCalledTimes(1);
      h.client.close();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("answers server heartbeats and surfaces definitive access loss", async () => {
    const h = harness();
    await Promise.resolve();
    const socket = h.sockets[0]!;
    ready(socket);
    socket.frame({ type: "ping" });
    expect(socket.controls().at(-1)).toEqual({ type: "pong" });
    socket.frame({
      type: "subscription_error",
      stream_id: "stream-a",
      subscription_id: "s1",
      status: 403,
      code: "ACCOUNT_RESTRICTED",
    });
    expect(h.values.at(-1)?.error?.code).toBe("ACCOUNT_RESTRICTED");
    expect(h.client.getState()).toBe("stopped");
    h.client.close();
  });
  it("read is bounded/cancellable and unsubscribes its live resource", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.off();
    const abort = new AbortController();
    const read = h.client.read("usage", {}, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    ready(h.sockets[0]!);
    abort.abort();
    await expect(read).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.sockets[0]!.controls().at(-1)?.type).toBe("unsubscribe");
    h.client.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
