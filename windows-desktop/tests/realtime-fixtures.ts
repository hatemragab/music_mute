import { vi } from "vitest";
import { UserRealtimeController } from "../src/main/realtime/user-realtime.js";
import type { AccountSocket } from "../../chrome-extension/src/companion/account-realtime.js";
import type { AccountSessionScope } from "../src/main/account/account-controller.js";

const installationId = "d7ea7de6-52e9-4b96-8834-3b517941bdb0";
export const ownerA = {
  firebaseUid: "owner-a",
  generation: "38b8e310-4805-42f2-b065-447b031c542e",
};
export const ownerB = {
  firebaseUid: "owner-b",
  generation: "cd6ccad8-ecbb-4f02-99a7-5e26e26b9545",
};
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
  ready(stream = "stream-a") {
    this.frame({ type: "ready", protocol_version: 1, stream_id: stream });
  }
  snapshot(id: string, data: unknown, sequence = 1, stream = "stream-a") {
    this.frame({
      type: "snapshot",
      protocol_version: 1,
      stream_id: stream,
      subscription_id: id,
      sequence,
      data,
    });
  }
  controls() {
    return this.send.mock.calls.map(
      ([value]) => JSON.parse(value as string) as Record<string, unknown>,
    );
  }
  closed(code = 1006) {
    this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent);
  }
}
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
export function processingPolicy(revision = 1) {
  return {
    schema_version: 2,
    revision,
    accept_new_jobs: true,
    checked_at: "2026-10-09T00:00:00.000Z",
    limits: { max_duration_seconds: 1200, max_prepared_audio_bytes: 50000000 },
    link_import_enabled: true,
    link_import_disabled_countries: [],
    visitor_country: null,
    link_import_visible: true,
    link_import_reason: "allowed",
    link_import_policy_revision: revision,
  };
}
export function processingUsage() {
  return {
    schema_version: 2,
    processing: {
      used_seconds: 100,
      reserved_seconds: 20,
      released_seconds: 10,
      remaining_seconds: 880,
      limit_seconds: 1000,
    },
    period: { next_reset_at: "2026-11-01T00:00:00.000Z" },
    availability: { status: "available", reason: null },
  };
}
export function realtimeFixture() {
  let scope: AccountSessionScope | null = null;
  const sockets: Socket[] = [];
  const account = {
    sessionScope: () => scope,
    assertScope: (candidate: AccountSessionScope) => {
      if (
        !scope ||
        candidate.generation !== scope.generation ||
        candidate.firebaseUid !== scope.firebaseUid
      )
        throw new Error("SESSION_CHANGED");
    },
    authorization: vi.fn(async () => "synthetic-firebase-bearer"),
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/realtime-tickets"))
      return json(
        {
          path: "/realtime/socket",
          protocol: "musicmute.realtime.v1",
          ticket: "t".repeat(43),
          expires_at: new Date(Date.now() + 30000).toISOString(),
        },
        201,
      );
    if (url.includes("/processing-policy")) return json(processingPolicy());
    return json({
      require_verified_email: false,
      platforms: { windows: { minimum_build: null } },
    });
  });
  const factory = vi.fn((_url: string, _protocols: string[]) => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  });
  const rejected = vi.fn();
  const controller = new UserRealtimeController({
    origin: "https://api.example.test",
    installationId,
    account,
    fetch: fetcher,
    socket: factory,
    onAuthenticationRequired: rejected,
  });
  return {
    controller,
    sockets,
    factory,
    fetcher,
    account,
    calls,
    rejected,
    setOwner: (next: AccountSessionScope | null) => {
      scope = next;
      controller.setScope(next);
    },
    ownerA,
    ownerB,
  };
}
