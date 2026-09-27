import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { WorkerHintClient } from "../src/runtime/worker-hint-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class FakeSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  serverClose(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
      throw new DOMException("invalid code", "InvalidAccessError");
    if (this.readyState >= WebSocket.CLOSING) return;
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

async function unitFixture(onHint: () => void = vi.fn()) {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const ticket = vi.fn(async () => ({
    socketUrl: "wss://api.example.invalid/worker/hints/socket",
    ticket: "t".repeat(43),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  }));
  const client = new WorkerHintClient({ hintTicket: ticket }, onHint, {
    random: () => 0.5,
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  cleanup.push(() => client.stop());
  client.start();
  await vi.advanceTimersByTimeAsync(0);
  return { client, sockets, ticket };
}

describe("worker hint client", () => {
  it("rejects null using a close code accepted by the real native client", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(async () => {
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const onHint = vi.fn();
    const client = new WorkerHintClient(
      {
        hintTicket: async () => ({
          socketUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
          ticket: "t".repeat(43),
          expiresAt: new Date(Date.now() + 30000).toISOString(),
        }),
      },
      onHint,
    );
    cleanup.push(() => client.stop());
    const connected = once(sockets, "connection");
    client.start();
    const [peer] = await connected;
    const closed = once(peer, "close");
    peer.send("null");
    const [code] = await closed;
    expect(code).toBe(4000);
    expect(onHint).not.toHaveBeenCalled();
  });

  it("cancels a handshake before obtaining another ticket", async () => {
    const f = await unitFixture();
    const socket = f.sockets[0]!;
    vi.spyOn(socket, "close").mockImplementation(() => {
      socket.readyState = WebSocket.CLOSING;
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(socket.readyState).toBe(WebSocket.CLOSING);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.ticket).toHaveBeenCalledOnce();
    socket.serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.ticket).toHaveBeenCalledTimes(2);
  });

  it.each([
    "null",
    "[]",
    "42",
    "true",
    "{",
    "{}",
    '{"type":{"toString":0},"revision":1,"sentAt":"2026-09-27T00:00:00Z"}',
  ])("closes malformed hint %s without throwing", async (raw) => {
    const f = await unitFixture();
    const socket = f.sockets[0]!;
    socket.open();
    socket.message(raw);
    expect(socket.closes).toEqual([{ code: 4000, reason: "invalid hint" }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.sockets).toHaveLength(2);
  });

  it("closes an erroring transport before reconnecting", async () => {
    const f = await unitFixture();
    const socket = f.sockets[0]!;
    socket.open();
    socket.dispatchEvent(new Event("error"));
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(socket.closes).toEqual([{ code: 4000, reason: "socket error" }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.sockets).toHaveLength(2);
  });

  it("keeps one opened socket beyond the handshake deadline", async () => {
    const fixture = await unitFixture();
    fixture.client.start();
    fixture.sockets[0]!.open();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(fixture.ticket).toHaveBeenCalledOnce();
    expect(fixture.sockets).toHaveLength(1);
    expect(fixture.sockets[0]!.readyState).toBe(WebSocket.OPEN);
    expect(fixture.sockets[0]!.closes).toEqual([]);
  });

  it("backs off repeated short connections instead of reconnecting in a tight loop", async () => {
    const fixture = await unitFixture();
    fixture.sockets[0]!.open();
    fixture.sockets[0]!.serverClose();

    await vi.advanceTimersByTimeAsync(999);
    expect(fixture.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.sockets).toHaveLength(2);

    fixture.sockets[1]!.open();
    fixture.sockets[1]!.serverClose();
    await vi.advanceTimersByTimeAsync(1_799);
    expect(fixture.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.sockets).toHaveLength(3);
  });

  it("isolates a failing wake listener from the worker transport", async () => {
    const fixture = await unitFixture(() => {
      throw new Error("wake failed");
    });
    const socket = fixture.sockets[0]!;
    socket.open();
    socket.message(
      JSON.stringify({
        type: "work_available",
        revision: 1,
        sentAt: new Date().toISOString(),
      }),
    );

    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(socket.closes).toEqual([]);
    expect(fixture.ticket).toHaveBeenCalledOnce();
  });

  it("does not start when its owner is already stopped", async () => {
    vi.useFakeTimers();
    const ticket = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const client = new WorkerHintClient({ hintTicket: ticket }, vi.fn());
    const stopped = AbortSignal.abort();

    client.start(stopped);
    await vi.advanceTimersByTimeAsync(0);

    expect(ticket).not.toHaveBeenCalled();
    await client.stop();
  });

  it("does not create a socket when a pending ticket resolves after stop", async () => {
    let resolveTicket!: (ticket: {
      socketUrl: string;
      ticket: string;
      expiresAt: string;
    }) => void;
    const pending = new Promise<{
      socketUrl: string;
      ticket: string;
      expiresAt: string;
    }>((resolve) => {
      resolveTicket = resolve;
    });
    const socket = vi.fn();
    const client = new WorkerHintClient(
      { hintTicket: () => pending },
      vi.fn(),
      { socket },
    );
    client.start();
    const stopped = client.stop();
    resolveTicket({
      socketUrl: "wss://api.example.invalid",
      ticket: "unused",
      expiresAt: new Date().toISOString(),
    });
    await stopped;
    expect(socket).not.toHaveBeenCalled();
  });

  it("wakes reconciliation for a valid raw websocket hint", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(async () => {
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as AddressInfo).port;
    const hinted = vi.fn();
    const ticket = "t".repeat(43);
    let upgradeUrl: string | undefined;
    let protocols: string | undefined;
    const client = new WorkerHintClient(
      {
        hintTicket: async () => ({
          socketUrl: `ws://127.0.0.1:${port}`,
          ticket,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }),
      },
      hinted,
    );
    cleanup.push(() => client.stop());
    sockets.once("connection", (socket, request) => {
      upgradeUrl = request.url;
      protocols = request.headers["sec-websocket-protocol"];
      socket.send(
        JSON.stringify({
          type: "work_available",
          revision: 1,
          sentAt: new Date().toISOString(),
        }),
      );
    });
    client.start();

    await vi.waitFor(() => expect(hinted).toHaveBeenCalledOnce());
    expect(upgradeUrl).toBe("/");
    expect(protocols).toBe(`musicmute.worker-hint.v1, ticket.${ticket}`);
  });
});
