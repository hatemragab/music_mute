import { test } from "node:test";
import assert from "node:assert/strict";
import { processObserver } from "./process-observer.mjs";
import { settings } from "./cli.mjs";
import { boundedEvent } from "./redact.mjs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("owned process diagnostics retain safe metadata, not arbitrary fatal text", async () => {
  const records = [];
  const observer = processObserver({
    endpoint: "http://127.0.0.1",
    key: "private",
    transport: async (_url, options) => {
      records.push(JSON.parse(options.body));
      return new Response();
    },
  });
  observer.emit("stderr", "fatal SECRET_CREDENTIAL_UNSTRUCTURED");
  queueMicrotask(() => observer.emit("stderr", "second record"));
  await observer.close();
  assert.equal(records.length, 2);
  assert.doesNotMatch(JSON.stringify(records), /SECRET_CREDENTIAL/);
  assert.equal(records[0].level, "error");
  assert.equal(observer.stats.pending, 0);
});
test("process sink pressure and failures stay bounded and observable", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const observer = processObserver({
    endpoint: "http://127.0.0.1",
    key: "private",
    transport: async () => {
      await gate;
      throw Error("sink error");
    },
  });
  for (let i = 0; i < 100; i++) observer.emit("stdout", "noise");
  observer.emit("stderr", "fatal");
  assert.ok(observer.stats.pending <= 65);
  assert.ok(observer.stats.dropped > 0);
  release();
  await observer.close();
  assert.ok(observer.stats.failed > 0);
  assert.equal(observer.stats.pending, 0);
});
test("simultaneous cold launches reuse exactly one private source-key configuration", async (t) => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "musicmute-settings-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const results = await Promise.all(
    Array.from({ length: 8 }, () => settings(root)),
  );
  for (const result of results) assert.deepEqual(result.keys, results[0].keys);
});
test("oversized metadata fallback retains the mandatory searchable envelope", () => {
  const record = boundedEvent({
    source: "backend",
    instanceId: "api",
    captureId: "capture",
    requestId: "request",
    userId: null,
    ...Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        "field" + index,
        "a".repeat(1000),
      ]),
    ),
  });
  assert.equal(record.source, "backend");
  assert.equal(record.instanceId, "api");
  assert.equal(record.requestId, "request");
  assert.equal(record.payloadOmitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 65536);
});
