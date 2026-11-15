import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeUpdate } from "../src/main/realtime/user-realtime.js";
import { AccountUsageController } from "../src/main/usage/account-usage.js";
import {
  realtimeFixture,
  processingPolicy,
  processingUsage,
  ownerA,
  ownerB,
  json,
} from "./realtime-fixtures.js";

afterEach(() => vi.useRealTimers());

describe("Windows session-owned realtime adapter", () => {
  it("releases a cloud lease without closing the account socket or unrelated watches", async () => {
    const h = realtimeFixture(),
      rows: RealtimeUpdate[] = [];
    h.controller.watch("jobs", { limit: "20" }, (value) => rows.push(value));
    h.setOwner(ownerA);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1));
    const socket = h.sockets[0]!;
    socket.ready();
    const lease = h.controller.cloudLease(ownerA),
      listener = vi.fn();
    lease.start();
    lease.watch("job", { id: "a".repeat(24) }, listener);
    socket.snapshot("s2", { status: "processing" });
    expect(listener).toHaveBeenLastCalledWith({
      data: { status: "processing" },
    });
    lease.stop();
    lease.stop();
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.controls().at(-1)).toEqual({
      type: "unsubscribe",
      subscription_id: "s2",
    });
    socket.snapshot("s1", { items: [], next_cursor: null });
    expect(rows.at(-1)?.live).toBe(true);
    expect(h.factory).toHaveBeenCalledOnce();
    expect(() => lease.start()).toThrow("CANCELLED");
    h.controller.dispose();
  });
  it("fences cloud lease reads and notifications after the account generation changes", async () => {
    const h = realtimeFixture();
    h.setOwner(ownerA);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1));
    const socket = h.sockets[0]!;
    socket.ready();
    const lease = h.controller.cloudLease(ownerA),
      read = lease.read("job", { id: "a".repeat(24) });
    const rejected = expect(read).rejects.toThrow();
    h.setOwner(ownerB);
    await rejected;
    expect(() => lease.watch("jobs", { limit: "20" }, () => {})).toThrow();
    await expect(lease.read("job", { id: "a".repeat(24) })).rejects.toThrow();
    lease.stop();
    h.controller.dispose();
  });
  it("uses one shared ticket/socket, waits for snapshots, and distinguishes authentication from Library readiness", async () => {
    const h = realtimeFixture();
    const usage = new AccountUsageController({ realtime: h.controller });
    const rows: RealtimeUpdate[] = [];
    h.controller.watch("jobs", { limit: "20" }, (value) => rows.push(value));
    h.setOwner(ownerA);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1));
    const socket = h.sockets[0]!;
    expect(h.controller.status()).toMatchObject({
      authenticated: true,
      libraryReady: false,
    });
    socket.ready();
    socket.snapshot("s1", processingUsage());
    socket.snapshot("s2", processingPolicy());
    expect(usage.view().usageState).toBe("current");
    expect(usage.view().policyState).toBe("current");
    expect(h.controller.status().libraryReady).toBe(false);
    socket.snapshot("s3", { items: [], next_cursor: null });
    expect(h.controller.status().libraryReady).toBe(true);
    expect(rows.at(-1)?.live).toBe(true);
    expect(h.factory).toHaveBeenCalledOnce();
    expect(h.calls[0]?.init.method).toBe("POST");
    expect(h.calls[0]?.url).not.toContain("synthetic");
    expect(h.factory.mock.calls[0]?.[1]).toEqual([
      "musicmute.realtime.v1",
      `ticket.${"t".repeat(43)}`,
    ]);
    usage.dispose();
    h.controller.dispose();
  });
  it("reconnects with a fresh ticket, hides stale per-job ranks, and rejects old-socket callbacks", async () => {
    vi.useFakeTimers();
    const h = realtimeFixture();
    const updates: RealtimeUpdate[] = [];
    h.controller.watch("job", { id: "a".repeat(24) }, (value) =>
      updates.push(value),
    );
    h.setOwner(ownerA);
    await vi.advanceTimersByTimeAsync(1);
    const first = h.sockets[0]!;
    first.ready();
    first.snapshot("s1", {
      status: "queued",
      queue_position: 2,
      queue: {
        state: "waiting",
        position: 2,
        jobs_ahead: 1,
        reason: null,
        scope: "recipe",
        as_of: "2026-10-09T00:00:00.000Z",
      },
    });
    const oldHandler = first.onmessage;
    first.closed();
    expect(updates.at(-1)?.live).toBe(false);
    expect(
      (
        updates.at(-1)!.data as {
          queue: { position: number | null };
          queue_position: number | null;
        }
      ).queue.position,
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(1300);
    expect(h.sockets).toHaveLength(2);
    expect(h.calls).toHaveLength(2);
    expect(h.calls.every((call) => call.init.method === "POST")).toBe(true);
    const second = h.sockets[1]!;
    second.ready("stream-b");
    second.snapshot("s1", { status: "processing" }, 1, "stream-b");
    oldHandler?.call(
      first as unknown as WebSocket,
      {
        data: JSON.stringify({
          type: "snapshot",
          protocol_version: 1,
          stream_id: "stream-a",
          subscription_id: "s1",
          sequence: 99,
          data: { private: "old-owner-data" },
        }),
      } as MessageEvent,
    );
    expect(updates.at(-1)?.data).toEqual({ status: "processing" });
    h.controller.dispose();
  });
  it("resyncs sequence gaps without GET reads and rejects duplicates/foreign streams", async () => {
    const h = realtimeFixture();
    const updates: RealtimeUpdate[] = [];
    h.controller.watch("import", { id: "a".repeat(24) }, (value) =>
      updates.push(value),
    );
    h.setOwner(ownerA);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1));
    const socket = h.sockets[0]!;
    socket.ready();
    socket.snapshot("s1", { status: "running" });
    socket.snapshot("s1", { status: "duplicate" });
    socket.snapshot("s1", { status: "foreign" }, 2, "wrong-stream");
    socket.snapshot("s1", { status: "gap" }, 3);
    expect(socket.controls().at(-1)).toEqual({
      type: "resync",
      subscription_id: "s1",
    });
    expect(updates.at(-1)?.live).toBe(false);
    socket.snapshot("s1", { status: "done" }, 4);
    expect(updates.at(-1)?.data).toEqual({ status: "done" });
    expect(h.calls).toHaveLength(1);
    h.controller.dispose();
  });
  it("clears old-owner state immediately and stops after permission/session rejection", async () => {
    const h = realtimeFixture();
    const updates: RealtimeUpdate[] = [];
    h.controller.watch("worker_registration", {}, (value) =>
      updates.push(value),
    );
    h.setOwner(ownerA);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(1));
    h.sockets[0]!.ready();
    h.sockets[0]!.snapshot("s1", { worker_registration_allowed: true });
    h.setOwner(ownerB);
    expect(updates.at(-1)?.data).toBeNull();
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    h.sockets[1]!.ready("stream-b");
    h.sockets[1]!.frame({
      type: "subscription_error",
      stream_id: "stream-b",
      subscription_id: "s1",
      status: 403,
      code: "UNAUTHENTICATED",
    });
    expect(h.rejected).toHaveBeenCalledWith("UNAUTHENTICATED", ownerB);
    expect(updates.at(-1)?.data).toBeNull();
    expect(h.controller.status().state).toBe("stopped");
    h.controller.dispose();
  });
  it("expires malformed/old tickets and late initial snapshots through bounded reconnect, never live HTTP polling", async () => {
    vi.useFakeTimers();
    const h = realtimeFixture();
    h.fetcher.mockResolvedValueOnce(
      json({
        path: "/realtime/socket",
        protocol: "musicmute.realtime.v1",
        ticket: "t".repeat(43),
        expires_at: new Date(Date.now() - 1).toISOString(),
      }),
    );
    h.controller.watch("usage", {}, () => {});
    h.setOwner(ownerA);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1300);
    expect(h.sockets).toHaveLength(1);
    h.sockets[0]!.ready();
    await vi.advanceTimersByTimeAsync(17000);
    expect(h.sockets[0]!.close).toHaveBeenCalled();
    expect(
      h.calls.every(
        (call) =>
          call.url.endsWith("/realtime-tickets") && call.init.method === "POST",
      ),
    ).toBe(true);
    h.controller.dispose();
  });
  it("sends pong and performs only explicit app-open checkouts for public/build policy", async () => {
    vi.useFakeTimers();
    const h = realtimeFixture();
    h.setOwner(ownerA);
    await vi.advanceTimersByTimeAsync(1);
    const socket = h.sockets[0]!;
    socket.ready();
    socket.frame({ type: "ping", server_time: "2026-10-09T00:00:00.000Z" });
    expect(socket.controls().at(-1)).toEqual({ type: "pong" });
    await h.controller.checkoutPolicy();
    await h.controller.checkoutAppPolicy();
    expect(h.calls.filter((call) => call.init.method === "GET")).toHaveLength(
      2,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls.filter((call) => call.init.method === "GET")).toHaveLength(
      2,
    );
    h.controller.dispose();
  });
});
