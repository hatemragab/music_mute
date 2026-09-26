import { RealtimeClient } from "../realtime/client";
import { ApiError } from "../api/api-client";
import { toWireCase as toWire } from "../api/wire-case";

/** Synthetic server for unit/UI fixtures, excluded from the production bundle. */
export function realtimeFixture(
  read: (
    resource: string,
    params: Record<string, string>,
  ) => unknown | Promise<unknown>,
) {
  const sockets: FixtureSocket[] = [];
  class FixtureSocket {
    readyState: number = WebSocket.OPEN;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    subscriptions = new Map<
      string,
      { resource: string; params: Record<string, string>; sequence: number }
    >();
    constructor() {
      queueMicrotask(() =>
        this.frame({
          type: "ready",
          stream_id: "fixture",
          protocol_version: 1,
        }),
      );
    }
    frame(value: unknown) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
    send(raw: string) {
      const command = JSON.parse(raw);
      if (command.type === "subscribe") {
        this.subscriptions.set(command.subscription_id, {
          resource: command.resource,
          params: command.params,
          sequence: 0,
        });
        void this.publish(command.subscription_id);
      } else if (command.type === "unsubscribe")
        this.subscriptions.delete(command.subscription_id);
      else if (command.type === "resync")
        void this.publish(command.subscription_id);
    }
    async publish(id: string) {
      const subscription = this.subscriptions.get(id);
      if (!subscription) return;
      try {
        const data = await read(subscription.resource, subscription.params);
        this.frame({
          type: "snapshot",
          stream_id: "fixture",
          protocol_version: 1,
          subscription_id: id,
          sequence: ++subscription.sequence,
          data: toWire(data),
        });
      } catch (error) {
        this.frame({
          type: "subscription_error",
          stream_id: "fixture",
          subscription_id: id,
          status: error instanceof ApiError ? error.status : 503,
          code: error instanceof ApiError ? error.code : "SERVICE_UNAVAILABLE",
        });
      }
    }
    close() {
      this.readyState = WebSocket.CLOSED;
    }
  }
  const client = new RealtimeClient({
    origin: "https://api.example.com",
    ticket: async () => ({
      path: "/realtime/socket",
      protocol: "musicmute.realtime.v1",
      ticket: "a".repeat(43),
      expiresAt: "2099-01-01T00:00:00Z",
    }),
    socket: () => {
      const socket = new FixtureSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return {
    client,
    publish: async () => {
      for (const socket of sockets)
        for (const id of socket.subscriptions.keys()) await socket.publish(id);
    },
  };
}
