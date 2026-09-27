import { afterEach, expect, test, vi } from "vitest";
import { RealtimeClient } from "./client";

class Socket {
  readyState = 1;
  onmessage: ((value: { data: string }) => void) | null = null;
  onclose: ((value: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  close() {
    this.readyState = 3;
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  frame(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  ready(stream = "one") {
    this.frame({ type: "ready", stream_id: stream, protocol_version: 1 });
  }
  snapshot(sequence: number, data: unknown, stream = "one") {
    this.frame({
      type: "snapshot",
      protocol_version: 1,
      stream_id: stream,
      subscription_id: "s1",
      sequence,
      data,
    });
  }
}
const clients: RealtimeClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const ticket = {
  ticket: "a".repeat(43),
  path: "/realtime/socket",
  protocol: "musicmute.realtime.v1",
  expiresAt: "2099-01-01T00:00:00Z",
};
async function fixture(grant = vi.fn(async () => ticket)) {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const factory = vi.fn(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const client = new RealtimeClient({
    origin: "https://api.example.com",
    ticket: grant,
    socket: factory,
  });
  clients.push(client);
  client.start();
  await Promise.resolve();
  return { client, sockets, factory, grant };
}

test("uses one shared subscription, receives pushes and never repeats a ticket while live", async () => {
  const f = await fixture();
  const updates = vi.fn();
  const off = f.client.watch("jobs", {}, updates);
  const second = f.client.watch("jobs", {}, vi.fn());
  const socket = f.sockets[0];
  socket.ready();
  expect(f.factory.mock.calls[0]).toEqual([
    "wss://api.example.com/realtime/socket",
    [ticket.protocol, `ticket.${ticket.ticket}`],
  ]);
  expect(socket.sent).toHaveLength(1);
  socket.snapshot(1, { items: [], next_cursor: null });
  socket.snapshot(2, {
    items: [{ display_name: "Updated" }],
    next_cursor: null,
  });
  expect(updates).toHaveBeenLastCalledWith({
    data: { items: [{ displayName: "Updated" }], nextCursor: null },
  });
  await vi.advanceTimersByTimeAsync(30_000);
  socket.frame({ type: "ping" });
  await vi.advanceTimersByTimeAsync(30_000);
  socket.frame({ type: "ping" });
  expect(f.grant).toHaveBeenCalledOnce();
  expect(
    socket.sent.filter((frame) => frame.type === "subscribe"),
  ).toHaveLength(1);
  off();
  expect(socket.sent.at(-1)?.type).not.toBe("unsubscribe");
  second();
  expect(socket.sent.at(-1)?.type).toBe("unsubscribe");
});
test("keeps one socket alive while the browser tab is hidden", async () => {
  const f = await fixture();
  const socket = f.sockets[0];
  socket.ready();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");

  document.dispatchEvent(new Event("visibilitychange"));
  f.client.start();
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(120_000);

  expect(document.visibilityState).toBe("hidden");
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(f.grant).toHaveBeenCalledOnce();
  expect(f.factory).toHaveBeenCalledOnce();

  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(30_000);
  socket.frame({ type: "ping" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(f.factory).toHaveBeenCalledOnce();
});
test("does not expire a pending subscription while the tab is hidden", async () => {
  const f = await fixture();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const listener = vi.fn();
  f.client.watch("jobs", {}, listener);
  document.dispatchEvent(new Event("visibilitychange"));
  const socket = f.sockets[0];
  socket.ready();

  await vi.advanceTimersByTimeAsync(120_000);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(f.factory).toHaveBeenCalledOnce();

  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(5_000);
  socket.snapshot(1, { items: [], next_cursor: null });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(listener).toHaveBeenCalledOnce();
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(f.factory).toHaveBeenCalledOnce();
});
test("isolates a failing listener from the shared socket", async () => {
  const f = await fixture();
  const reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const healthy = vi.fn();
  f.client.watch("jobs", {}, () => {
    throw new Error("view failed");
  });
  f.client.watch("jobs", {}, healthy);
  const socket = f.sockets[0];
  socket.ready();
  socket.snapshot(1, { items: [], next_cursor: null });

  expect(reported).toHaveBeenCalledWith("Realtime listener failed");
  expect(healthy).toHaveBeenCalledWith({
    data: { items: [], nextCursor: null },
  });
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(f.factory).toHaveBeenCalledOnce();
});
test("ignores duplicates and old streams and resynchronizes a sequence gap", async () => {
  const f = await fixture();
  const listener = vi.fn();
  f.client.watch("job", { id: "fixture" }, listener);
  const socket = f.sockets[0];
  socket.ready();
  socket.snapshot(1, { status: "queued" });
  socket.snapshot(1, { status: "ready" });
  socket.snapshot(2, {}, "old");
  expect(listener).toHaveBeenCalledOnce();
  socket.snapshot(3, { status: "ready" });
  expect(socket.sent.at(-1)?.type).toBe("resync");
  socket.snapshot(4, { status: "ready" });
  expect(listener).toHaveBeenCalledTimes(2);
});
test("reconnect gets a fresh ticket and full snapshot, fencing the old connection", async () => {
  const f = await fixture();
  const listener = vi.fn();
  f.client.watch("jobs", {}, listener);
  const old = f.sockets[0];
  old.ready();
  old.snapshot(1, {});
  const stale = old.onmessage;
  old.onclose?.({ code: 1013 });
  expect(f.client.getState()).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.grant).toHaveBeenCalledTimes(2);
  const next = f.sockets[1];
  next.ready("two");
  stale?.({
    data: JSON.stringify({
      type: "snapshot",
      protocol_version: 1,
      stream_id: "one",
      subscription_id: "s1",
      sequence: 2,
      data: { private: "old" },
    }),
  });
  expect(listener).toHaveBeenCalledOnce();
  next.snapshot(1, { items: [] }, "two");
  expect(f.client.getState()).toBe("live");
});
test("tab return does not expire a definitive subscription error", async () => {
  const f = await fixture();
  f.client.watch("job", { id: "missing" }, vi.fn());
  const socket = f.sockets[0];
  socket.ready();
  socket.frame({
    type: "subscription_error",
    stream_id: "one",
    subscription_id: "s1",
    status: 404,
    code: "NOT_FOUND",
  });
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(11_000);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(f.factory).toHaveBeenCalledOnce();
  expect(f.grant).toHaveBeenCalledOnce();
});

test("logout during ticket issuance never opens a socket", async () => {
  let resolve!: (value: typeof ticket) => void;
  const f = await fixture(
    vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
  );
  f.client.stop();
  resolve(ticket);
  await Promise.resolve();
  expect(f.factory).not.toHaveBeenCalled();
});
