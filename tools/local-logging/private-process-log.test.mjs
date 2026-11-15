import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPrivateProcessLog,
  MAX_PRIVATE_LOG_LINE_BYTES,
  importantProcessLogLine,
} from "./private-process-log.mjs";
import { RotatingJsonlWriter } from "./log-retention.mjs";

async function fixture(t) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "private-process-log-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const policy = {
  maxBytes: 1,
  maxArchives: 2,
  maxAgeMs: 86400000,
  rotateAfterMs: 86400000,
};

test("owned process logs rotate privately and bound their archives without touching unrelated files", async (t) => {
  const root = await fixture(t),
    file = join(root, "process.log");
  const log = await createPrivateProcessLog(file, { policy });
  await writeFile(join(root, "unrelated.log"), "preserve");
  for (let i = 0; i < 8; i++) log.append(`record-${i}\n`);
  await log.close();
  const archives = (await readdir(join(root, "archives"))).filter((name) =>
    name.endsWith(".jsonl"),
  );
  assert.equal(archives.length, 2);
  assert.equal(await readFile(file, "utf8"), "record-7\n");
  assert.equal(await readFile(join(root, "unrelated.log"), "utf8"), "preserve");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const status = JSON.parse(await readFile(`${file}.status.json`, "utf8"));
  assert.equal(status.writtenRecords, 8);
  assert.equal(status.closed, true);
});

test("owned native input archives remain unread until collector acknowledgement and new diagnostics are rejected", async (t) => {
  const root = await fixture(t),
    file = join(root, "centrifugo-server.log");
  const log = await createPrivateProcessLog(file, {
    input: true,
    policy: { ...policy, maxArchives: 1 },
  });
  for (let i = 0; i < 4; i++)
    log.append(JSON.stringify({ message: `retained-${i}` }) + "\n");
  await log.close();
  assert.equal(log.stats().writtenRecords, 3);
  assert.equal(log.stats().failedRecords, 1);
  assert.equal(
    (await readdir(join(root, "archives"))).filter((name) =>
      name.endsWith(".jsonl"),
    ).length,
    2,
  );
});

test("native line envelopes omit whole oversized content and preserve split UTF8", async (t) => {
  const root = await fixture(t),
    file = join(root, "process.log");
  const log = await createPrivateProcessLog(file);
  const utf = Buffer.from("سليم\n");
  log.append(utf.subarray(0, 1));
  log.append(utf.subarray(1));
  log.append("x".repeat(MAX_PRIVATE_LOG_LINE_BYTES + 1) + "\n");
  await log.close();
  const captured = await readFile(file, "utf8");
  assert.ok(captured.startsWith("سليم\n"));
  assert.equal(log.stats().omittedRecords, 1);
  assert.ok(captured.length < 1000);
});

test("structured native severity is authoritative and plain diagnostics do not treat every stderr line as an error", () => {
  assert.equal(
    importantProcessLogLine(
      '{"level":"info","message":"a handled error label"}',
    ),
    false,
  );
  assert.equal(
    importantProcessLogLine('{"level":"warn","message":"synthetic warning"}'),
    true,
  );
  assert.equal(
    importantProcessLogLine('{"s":"E","msg":"synthetic Mongo error"}'),
    true,
  );
  assert.equal(importantProcessLogLine("normal compiler progress\n"), false);
  assert.equal(
    importantProcessLogLine("Warning: synthetic native warning\n"),
    true,
  );
  assert.equal(
    importantProcessLogLine("Error: synthetic native error\n"),
    true,
  );
});

test("native important failures retain reserved queue capacity and evict queued noise without evicting the in-flight line", async (t) => {
  const file = join(await fixture(t), "native.log");
  const originalWrite = RotatingJsonlWriter.prototype.write;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  t.mock.method(RotatingJsonlWriter.prototype, "write", async function (line) {
    if (first) {
      first = false;
      await gate;
    }
    return originalWrite.call(this, line);
  });
  const log = await createPrivateProcessLog(file, {
    maxPendingBytes: 130,
    importantReserveBytes: 550,
  });
  log.append("inflight-normal\n");
  log.append(`queued-normal${"x".repeat(86)}\n`);
  log.append('{"level":"warn","message":"important-one"}\n');
  log.append('{"level":"error","message":"important-two"}\n');
  log.append('{"level":"warn","message":"important-over-capacity"}\n');
  assert.ok(log.stats().pendingBytes <= 680);
  assert.ok(log.stats().evictedRecords > 0);
  assert.equal(log.stats().importantDroppedRecords, 1);
  release();
  await log.close();
  const captured = await readFile(file, "utf8");
  assert.ok(captured.startsWith("inflight-normal\n"));
  assert.doesNotMatch(captured, /queued-normal|important-over-capacity/);
  assert.equal(log.stats().importantWrittenRecords, 2);
  assert.equal(log.stats().importantPendingRecords, 0);
});

test("a native warning survives a transient partial append and carries explicit uncertainty on its automatic retry", async (t) => {
  const file = join(await fixture(t), "native.log");
  const originalOpen = RotatingJsonlWriter.prototype.open;
  let armed = true;
  t.mock.method(RotatingJsonlWriter.prototype, "open", async function () {
    await originalOpen.call(this);
    if (armed && this.file === file) {
      armed = false;
      const append = this.handle.writeFile.bind(this.handle);
      this.handle.writeFile = async () => {
        await append('{"torn":');
        throw Object.assign(new Error("private disk detail"), {
          code: "ENOSPC",
        });
      };
    }
    return this;
  });
  const log = await createPrivateProcessLog(file, {
    input: true,
    retryBackoffMs: 1,
    importantRetryWindowMs: 1000,
  });
  log.append('{"level":"warn","message":"retained-important"}\n');
  await log.close();
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines[0], '{"torn":');
  const value = JSON.parse(lines[1]);
  assert.equal(value.message, "retained-important");
  assert.equal(value.logDeliveryAttempt, 2);
  assert.equal(value.logPreviousWriteOutcome, "uncertain");
  assert.match(value.logRecordId, /^[a-f0-9]{32}$/);
  assert.equal(log.stats().importantWrittenRecords, 1);
  assert.equal(log.stats().importantUncertainRecords, 1);
  assert.equal(log.stats().importantFailedRecords, 0);
  assert.equal(log.stats().retriedRecords, 1);
});

test("a fully appended native error with rejected acknowledgement replays with the same record identity", async (t) => {
  const file = join(await fixture(t), "native.log");
  const originalOpen = RotatingJsonlWriter.prototype.open;
  let armed = true;
  t.mock.method(RotatingJsonlWriter.prototype, "open", async function () {
    await originalOpen.call(this);
    if (armed && this.file === file) {
      armed = false;
      const append = this.handle.writeFile.bind(this.handle);
      this.handle.writeFile = async (line) => {
        await append(line);
        throw Object.assign(new Error("private acknowledgement detail"), {
          code: "EIO",
        });
      };
    }
    return this;
  });
  const log = await createPrivateProcessLog(file, {
    input: true,
    retryBackoffMs: 1,
    importantRetryWindowMs: 1000,
  });
  log.append(
    '{"level":"error","message":"ambiguous-important","data":{"operation":"retained"}}\n',
  );
  await log.close();
  const values = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(values.length, 2);
  assert.equal(values[0].logRecordId, values[1].logRecordId);
  assert.deepEqual(
    values.map((value) => value.logDeliveryAttempt),
    [1, 2],
  );
  assert.equal(values[1].logPreviousWriteOutcome, "uncertain");
  for (const value of values) {
    assert.equal(value.data.operation, "retained");
    assert.equal(value.data.logDelivery.logRecordId, value.logRecordId);
    assert.equal(
      value.data.logDelivery.logDeliveryAttempt,
      value.logDeliveryAttempt,
    );
    assert.equal(
      value.data.logDelivery.logPreviousWriteOutcome,
      value.logPreviousWriteOutcome,
    );
  }
  assert.equal(log.stats().importantFailedRecords, 0);
});

test("persistent native important storage failure reaches its finite retry deadline and reports important loss", async (t) => {
  const file = join(await fixture(t), "native.log");
  t.mock.method(RotatingJsonlWriter.prototype, "write", async () => {
    throw Object.assign(new Error("private persistent failure"), {
      code: "ENOSPC",
      logWriteOutcome: "not_written",
      logBytesWritten: 0,
    });
  });
  const log = await createPrivateProcessLog(file, {
    input: true,
    retryBackoffMs: 2,
    importantRetryWindowMs: 12,
  });
  log.append('{"level":"warn","message":"expired-important"}\n');
  await log.close();
  assert.equal(log.stats().importantFailedRecords, 1);
  assert.equal(log.stats().failedRecords, 1);
  assert.equal(log.stats().importantPendingRecords, 0);
  assert.equal(log.stats().pendingBytes, 0);
  assert.equal(log.stats().importantUncertainRecords, 0);
});
