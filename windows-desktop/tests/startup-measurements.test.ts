import { expect, it, vi } from "vitest";
import {
  LocalStartupMeasurements,
  parseEngineStartupTimings,
  type StartupMeasurementStore,
} from "../src/main/prepare/startup-measurements.js";
function fixture() {
  let bytes: Buffer | null = null,
    monotonic = 10,
    wall = Date.parse("2026-10-09T00:00:00Z");
  const store: StartupMeasurementStore = {
    exclusive: async (work) => work(),
    read: async () => (bytes ? Buffer.from(bytes) : null),
    write: vi.fn(async (value) => {
      bytes = Buffer.from(value);
    }),
  };
  const clock = { monotonic: () => monotonic, wall: () => wall };
  return {
    store,
    clock,
    recorder: new LocalStartupMeasurements(store, clock),
    setMono: (next: number) => {
      monotonic = next;
    },
    setWall: (next: number) => {
      wall = next;
    },
    setBytes: (next: Buffer) => {
      bytes = Buffer.from(next);
    },
    bytes: () => bytes,
    rows: () => JSON.parse(bytes!.toString()).records,
  };
}
it("separates actual phases, uses monotonic duration and records failed/cancelled outcomes once", async () => {
  const f = fixture();
  const app = f.recorder.begin("app-bootstrap");
  f.setMono(31);
  f.setWall(Date.parse("2026-10-09T03:00:00Z"));
  app.complete();
  app.failed();
  const attach = f.recorder.begin("controller-attach");
  f.setMono(36);
  attach.failed();
  attach.complete();
  const check = f.recorder.begin("status-check");
  f.setMono(39);
  check.cancelled();
  await f.recorder.flush();
  expect(
    f
      .rows()
      .map((row: { phase: string; durationMs: number; outcome: string }) => [
        row.phase,
        row.durationMs,
        row.outcome,
      ]),
  ).toEqual([
    ["app-bootstrap", 21, "completed"],
    ["controller-attach", 5, "failed"],
    ["status-check", 3, "cancelled"],
  ]);
  expect(f.bytes()!.toString()).not.toMatch(
    /sid|uid|request|path|token|video|owner/iu,
  );
});
it("pre-host buffering, persistence and retention are bounded independently of launch count", async () => {
  const f = fixture(),
    recorder = new LocalStartupMeasurements(undefined, f.clock);
  for (let index = 0; index < 80; index++)
    recorder.recordDuration("status-check", index, "completed");
  expect(recorder.view()).toHaveLength(32);
  await recorder.flush();
  expect(f.bytes()).toBeNull();
  recorder.attach(f.store);
  await recorder.flush();
  expect(f.rows()).toHaveLength(32);
  expect(f.rows()[0].durationMs).toBe(48);
  expect(f.bytes()!.length).toBeLessThan(16384);
  f.setWall(Date.parse("2026-10-17T00:00:00Z"));
  recorder.recordDuration("controller-attach", 3, "failed");
  await recorder.flush();
  expect(f.rows()).toHaveLength(1);
});
it("corrupt/unknown/private persisted fields do not silently reset old diagnostic records", async () => {
  const f = fixture();
  const original = Buffer.from(
    JSON.stringify({
      version: 1,
      records: [
        {
          phase: "status-check",
          outcome: "completed",
          durationMs: 4,
          origin: "node",
          observedAt: "2026-10-09T00:00:00Z",
          path: "C:\\private\\secret",
        },
      ],
    }),
  );
  f.setBytes(original);
  f.recorder.recordDuration("app-bootstrap", 5, "completed");
  await expect(f.recorder.flush()).rejects.toThrow(
    "STARTUP_MEASUREMENT_INVALID",
  );
  expect(f.bytes()).toEqual(original);
  expect(f.store.write).not.toHaveBeenCalled();
});
it("held persistence retains subsequent accepted measurements and serializes flush", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.store.write;
  f.store.write = vi.fn(async (bytes) => {
    await gate;
    await write(bytes);
  });
  f.recorder.recordDuration("app-bootstrap", 1, "completed");
  const first = f.recorder.flush();
  await Promise.resolve();
  f.recorder.recordDuration("controller-attach", 2, "failed");
  expect(f.recorder.flush()).toBe(first);
  release();
  await first;
  expect(f.rows().map((row: { phase: string }) => row.phase)).toEqual([
    "app-bootstrap",
    "controller-attach",
  ]);
});
it("failed storage leaves bounded local samples for an explicit later flush rather than inventing a persisted success", async () => {
  const f = fixture();
  const write = f.store.write;
  f.store.write = vi
    .fn()
    .mockRejectedValueOnce(new Error("METADATA_BUSY"))
    .mockImplementation(write);
  f.recorder.recordDuration("first-inference", 120, "completed", "engine", {
    releaseSha256: "a".repeat(64),
    modelSha256: "b".repeat(64),
  });
  await expect(f.recorder.flush()).rejects.toThrow("METADATA_BUSY");
  expect(f.bytes()).toBeNull();
  expect(f.recorder.view()).toHaveLength(1);
  await f.recorder.flush();
  expect(f.rows()).toHaveLength(1);
});
it("only exact finite bounded engine seconds become model/inference measurements; absent remains absent", () => {
  expect(parseEngineStartupTimings(undefined)).toBeNull();
  expect(
    parseEngineStartupTimings({
      modelLoadSeconds: 4.25,
      firstInferenceSeconds: 0.12,
    }),
  ).toEqual({ modelLoadSeconds: 4.25, firstInferenceSeconds: 0.12 });
  for (const value of [
    null,
    { modelLoadSeconds: 1 },
    { modelLoadSeconds: 1, firstInferenceSeconds: 1, path: "private" },
    { modelLoadSeconds: 1, firstInferenceSeconds: Infinity },
    { modelLoadSeconds: 1, firstInferenceSeconds: "1" },
    { modelLoadSeconds: -1, firstInferenceSeconds: 1 },
    { modelLoadSeconds: 1, firstInferenceSeconds: 3601 },
  ])
    expect(() => parseEngineStartupTimings(value)).toThrow(
      "STARTUP_MEASUREMENT_INVALID",
    );
});
it("a committed write with lost ACK can be retried without duplicating its local measurement", async () => {
  const f = fixture();
  const original = f.store.write;
  let lost = true;
  f.store.write = async (bytes) => {
    await original(bytes);
    if (lost) {
      lost = false;
      throw new Error("lost ACK");
    }
  };
  f.recorder.recordDuration("first-inference", 12.5, "completed", "engine");
  await expect(f.recorder.flush()).rejects.toThrow("lost ACK");
  expect(f.rows()).toHaveLength(1);
  await f.recorder.flush();
  expect(f.rows()).toHaveLength(1);
});
