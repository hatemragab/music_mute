import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { WorkerHintClient } from "../src/runtime/worker-hint-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation();
});

describe("worker hint client", () => {
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
    const client = new WorkerHintClient(
      {
        hintTicket: async () => ({
          socketUrl: `ws://127.0.0.1:${port}`,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }),
      },
      hinted,
    );
    cleanup.push(() => client.stop());
    sockets.once("connection", (socket) => {
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
  });
});
