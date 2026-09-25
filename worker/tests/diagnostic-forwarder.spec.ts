import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  DiagnosticSpool,
  clearDiagnosticHistory,
} from "../src/runtime/diagnostic-spool.js";
import { DiagnosticForwarder } from "../src/runtime/diagnostic-forwarder.js";
import { WorkerControlPlaneClient } from "../src/runtime/control-plane-client.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-forwarder-"));
  roots.push(root);
  const spool = new DiagnosticSpool(root);
  await spool.initialize();
  spool.record({ kind: "attempt-failed", code: "SEPARATOR_FAILED" });
  await spool.flush();
  return {
    path: join(root, "delivery.json"),
    spool,
    identity: { sessionId: randomUUID(), incarnation: randomUUID() },
  };
}
it("replays the exact durable batch after a lost acknowledgement and new session", async () => {
  const f = await fixture();
  const batches: unknown[] = [];
  const first = new DiagnosticForwarder(
    f.path,
    f.spool,
    {
      appendDiagnosticLogs: async (batch) => {
        batches.push(batch);
        throw new Error("lost ack");
      },
    },
    f.identity,
  );
  await expect(first.pump()).rejects.toThrow("lost ack");
  const pending = JSON.parse(await readFile(f.path, "utf8"));
  expect(pending.remoteAcknowledged).toBe(0);
  expect(pending.pending.lines.length).toBeGreaterThan(0);
  f.spool.record({ kind: "started" });
  await f.spool.flush();
  const resumed = new DiagnosticForwarder(
    f.path,
    f.spool,
    {
      appendDiagnosticLogs: async (batch) => {
        batches.push(batch);
        return { acknowledgedSequence: batch.sequenceEnd, replayed: true };
      },
    },
    { sessionId: randomUUID(), incarnation: randomUUID() },
  );
  await resumed.pump();
  const prior = batches[0] as {
    lines: string[];
    sequenceStart: number;
    sequenceEnd: number;
  };
  expect(batches[1]).toMatchObject({
    lines: prior.lines,
    sequenceStart: prior.sequenceStart,
    sequenceEnd: prior.sequenceEnd,
  });
  await resumed.pump();
  expect(batches).toHaveLength(3);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({
    localAcknowledged: 2,
    pending: null,
  });
});
it("initializes a missing outbox from the backend cursor and pins uncertain delivery", async () => {
  const f = await fixture();
  const cursor = vi.fn(async () => 70);
  const send = vi.fn(async () => {
    throw new Error("ack lost");
  });
  const first = new DiagnosticForwarder(
    f.path,
    f.spool,
    { appendDiagnosticLogs: send, diagnosticLogCursor: cursor },
    f.identity,
  );
  await expect(first.pump()).rejects.toThrow("ack lost");
  const state = JSON.parse(await readFile(f.path, "utf8"));
  expect(state.remoteAcknowledged).toBe(70);
  expect(state.pending.sequenceStart).toBe(71);
  const replay = vi.fn(
    async (
      batch: Parameters<WorkerControlPlaneClient["appendDiagnosticLogs"]>[0],
    ) => ({ acknowledgedSequence: batch.sequenceEnd, replayed: true }),
  );
  const resumed = new DiagnosticForwarder(
    f.path,
    f.spool,
    { appendDiagnosticLogs: replay, diagnosticLogCursor: cursor },
    f.identity,
  );
  await resumed.pump();
  expect(cursor).toHaveBeenCalledOnce();
  expect(replay.mock.calls[0]![0]).toMatchObject({
    sequenceStart: 71,
    lines: state.pending.lines,
  });
});

it("does not publish a batch when remote cursor reconciliation fails", async () => {
  const f = await fixture();
  const send = vi.fn();
  const forwarding = new DiagnosticForwarder(
    f.path,
    f.spool,
    {
      appendDiagnosticLogs: send,
      diagnosticLogCursor: async () => {
        throw new Error("offline");
      },
    },
    f.identity,
  );
  await expect(forwarding.pump()).rejects.toThrow("offline");
  expect(send).not.toHaveBeenCalled();
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains the pending batch after a mismatched acknowledgement", async () => {
  const f = await fixture();
  const forwarding = new DiagnosticForwarder(
    f.path,
    f.spool,
    {
      appendDiagnosticLogs: async () => ({
        acknowledgedSequence: 999,
        replayed: false,
      }),
    },
    f.identity,
  );
  await expect(forwarding.pump()).rejects.toThrow("does not match");
  expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({
    remoteAcknowledged: 0,
    pending: expect.any(Object),
  });
});

it.each([false, true])(
  "reconciles a replacement spool without remote sequence reuse (lost ack=%s)",
  async (loseAcknowledgement) => {
    const f = await fixture();
    const send = vi.fn(
      async (
        batch: Parameters<WorkerControlPlaneClient["appendDiagnosticLogs"]>[0],
      ) => {
        if (loseAcknowledgement && send.mock.calls.length === 1)
          throw new Error("lost acknowledgement");
        return {
          acknowledgedSequence: batch.sequenceEnd,
          replayed: send.mock.calls.length === 2 && loseAcknowledgement,
        };
      },
    );
    const first = new DiagnosticForwarder(
      f.path,
      f.spool,
      { appendDiagnosticLogs: send },
      f.identity,
    );
    if (loseAcknowledgement)
      await expect(first.pump()).rejects.toThrow("lost acknowledgement");
    else await first.pump();
    const previous = send.mock.calls[0]![0];
    const replacementRoot = await mkdtemp(join(tmpdir(), "replacement-spool-"));
    roots.push(replacementRoot);
    const replacement = new DiagnosticSpool(replacementRoot);
    await replacement.initialize();
    replacement.record({ kind: "started" });
    await replacement.flush();
    const current = await replacement.deliveryRecords(0);
    const resumed = new DiagnosticForwarder(
      f.path,
      replacement,
      { appendDiagnosticLogs: send },
      f.identity,
    );
    if (loseAcknowledgement) {
      await resumed.pump();
      expect(send.mock.calls[1]![0]).toEqual(previous);
    }
    await resumed.pump();
    const latest = send.mock.calls.at(-1)![0];
    expect(latest.sequenceStart).toBe(previous.sequenceEnd + 1);
    expect(latest.lines[0]).toContain(`${current.streamId}:1:`);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({
      streamId: current.streamId,
      localAcknowledged: 1,
      remoteAcknowledged: latest.sequenceEnd,
      pending: null,
    });
    const calls = send.mock.calls.length;
    await resumed.pump();
    expect(send).toHaveBeenCalledTimes(calls);
  },
);
it("preserves exact pending delivery across local history clearing without reusing sequences", async () => {
  const f = await fixture();
  const first = new DiagnosticForwarder(
    f.path,
    f.spool,
    {
      appendDiagnosticLogs: async () => {
        throw new Error("ack lost");
      },
    },
    f.identity,
  );
  await expect(first.pump()).rejects.toThrow("ack lost");
  const before = JSON.parse(await readFile(f.path, "utf8"));
  await clearDiagnosticHistory(join(f.path, ".."));
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(before);
  f.spool.record({ kind: "started" });
  await f.spool.flush();
  const batches: Array<{
    sequenceStart: number;
    sequenceEnd: number;
    lines: string[];
  }> = [];
  const resumed = new DiagnosticForwarder(
    f.path,
    f.spool,
    {
      appendDiagnosticLogs: async (batch) => {
        batches.push(batch);
        return {
          acknowledgedSequence: batch.sequenceEnd,
          replayed: batches.length === 1,
        };
      },
    },
    { sessionId: randomUUID(), incarnation: randomUUID() },
  );
  await resumed.pump();
  await resumed.pump();
  expect(batches).toHaveLength(2);
  expect(batches[0]).toMatchObject({
    sequenceStart: before.pending.sequenceStart,
    sequenceEnd: before.pending.sequenceEnd,
    lines: before.pending.lines,
  });
  expect(batches[1]!.sequenceStart).toBe(batches[0]!.sequenceEnd + 1);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({
    pending: null,
    localAcknowledged: 2,
  });
});
it("splits large records losslessly into bounded backend lines", async () => {
  const f = await fixture();
  const streamId = randomUUID();
  const record = {
    schemaVersion: 1 as const,
    streamId,
    sequence: 1,
    recordedAt: new Date().toISOString(),
    event: { detail: "unicode-ص".repeat(500) },
  };
  let received: string[] = [];
  const forwarding = new DiagnosticForwarder(
    f.path,
    { deliveryRecords: async () => ({ streamId, records: [record] }) },
    {
      appendDiagnosticLogs: async (batch) => {
        received = batch.lines;
        return { acknowledgedSequence: batch.sequenceEnd, replayed: false };
      },
    },
    f.identity,
  );
  await forwarding.pump();
  expect(received.length).toBeGreaterThan(1);
  expect(received.every((line) => line.length <= 1000)).toBe(true);
  expect(
    received.map((line) => line.slice(line.indexOf(" ") + 1)).join(""),
  ).toBe(JSON.stringify(record));
});
it("shares in-flight work and aborts transport on stop without advancing the cursor", async () => {
  const f = await fixture();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const send = vi.fn(async (_batch, signal?: AbortSignal) => {
    entered();
    return new Promise<{ acknowledgedSequence: number; replayed: boolean }>(
      (_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
      },
    );
  });
  const forwarding = new DiagnosticForwarder(
    f.path,
    f.spool,
    { appendDiagnosticLogs: send },
    f.identity,
  );
  const running = forwarding.pump();
  expect(forwarding.pump()).toBe(running);
  await ready;
  forwarding.stop();
  await expect(running).rejects.toThrow();
  expect(send).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({
    remoteAcknowledged: 0,
  });
});
it.each([0, 70, -1, 1.5, Number.MAX_SAFE_INTEGER, null])(
  "validates remote diagnostic cursor %s on the authenticated route",
  async (cursor) => {
    const f = await fixture();
    const client = new WorkerControlPlaneClient({
      baseUrl: "https://backend.example/",
      credential: "x".repeat(43),
      fetch: async (url, init) => {
        const parsed = new URL(String(url));
        expect(parsed.pathname).toBe("/worker/logs/cursor");
        expect(parsed.searchParams.get("session_id")).toBe(
          f.identity.sessionId,
        );
        expect(parsed.searchParams.get("incarnation")).toBe(
          f.identity.incarnation,
        );
        expect(init?.method).toBe("GET");
        return new Response(JSON.stringify({ acknowledged_sequence: cursor }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = client.diagnosticLogCursor(
      f.identity.sessionId,
      f.identity.incarnation,
    );
    if (cursor === 0 || cursor === 70)
      await expect(result).resolves.toBe(cursor);
    else await expect(result).rejects.toThrow("Diagnostic cursor is invalid");
  },
);

it("requires an exact backend acknowledgement on the authenticated log route", async () => {
  const f = await fixture();
  const transport = vi.fn(async (url, options) => {
    expect(String(url)).toBe("https://backend.example/worker/logs");
    expect(JSON.parse(options!.body as string).lines).toEqual(["safe event"]);
    return new Response(
      JSON.stringify({ acknowledged_sequence: 2, replayed: false }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const client = new WorkerControlPlaneClient({
    baseUrl: "https://backend.example/",
    credential: "a".repeat(43),
    fetch: transport as typeof fetch,
    maxAttempts: 1,
  });
  await expect(
    client.appendDiagnosticLogs({
      ...f.identity,
      sequenceStart: 1,
      sequenceEnd: 1,
      lines: ["safe event"],
    }),
  ).rejects.toThrow("does not match");
});
