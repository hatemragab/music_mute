import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BackendLogStore, LogStoreError } from "../src/log-store.js";
import type { SearchLogsInput } from "../src/types.js";

const time = "2026-10-16T12:00:00.000Z";
const http = (fields: Record<string, unknown> = {}) => ({
  timestamp: time,
  source: "backend",
  event: "http_request",
  level: "info",
  requestId: "request-a",
  userId: "actor-a",
  method: "POST",
  route: "/messages",
  status: 200,
  durationMs: 12,
  aborted: false,
  ...fields,
});
const publication = (fields: Record<string, unknown> = {}) => ({
  timestamp: time,
  source: "backend",
  event: "realtime_publication",
  level: "warn",
  requestId: "request-a",
  userId: "actor-a",
  actorUserId: "actor-a",
  recipientUserId: "recipient-a",
  publicationId: "publication-a",
  eventType: "message_new",
  channel: "inbox:user#recipient-a",
  attempt: 1,
  result: "failure",
  status: 200,
  durationMs: 15,
  pts: 5,
  ...fields,
});
const lines = (records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";

async function fixture(t: TestContext, contents?: string | Buffer) {
  // Resolve platform temp aliases before testing the deliberate no-symlink policy.
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "backend-log-store-"),
  );
  t.after(async () => {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, "capture.jsonl");
  if (contents !== undefined) await writeFile(file, contents, { mode: 0o600 });
  return { directory, file };
}

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof LogStoreError);
    assert.equal(error.code, code);
    assert.doesNotMatch(
      error.message,
      /capture\.jsonl|backend-log-store-|\bat \w|\/Users\//,
    );
    return true;
  };
}

test("missing capture is empty, explicit, and never created", async (t) => {
  const { directory, file } = await fixture(t);
  const store = new BackendLogStore(
    join(directory, "missing-parent", "capture.jsonl"),
  );
  const result = await store.searchLogs();
  assert.equal(result.available, false);
  assert.deepEqual(result.records, []);
  assert.equal(result.coverage.snapshotBytes, 0);
  assert.match(result.warnings.join(" "), /never creates/);
  await assert.rejects(lstat(file), { code: "ENOENT" });
  await assert.rejects(lstat(join(directory, "missing-parent")), {
    code: "ENOENT",
  });
});

test("metadata is recent first, and payloads require opt in", async (t) => {
  const payload = { text: "synthetic 😀 message", authorization: "[REDACTED]" };
  const { file } = await fixture(
    t,
    lines([
      http({ requestId: "old", requestBody: payload }),
      http({ requestId: "new", requestBody: payload }),
    ]),
  );
  const store = new BackendLogStore(file);
  const result = await store.searchLogs();
  assert.deepEqual(
    result.records.map((row) => row.requestId),
    ["new", "old"],
  );
  assert.equal(result.records[0].payload, undefined);
  assert.equal(JSON.stringify(result).includes("synthetic"), false);
  assert.equal(result.coverage.partial, false);
  const detailed = await store.searchLogs({ includePayloads: true });
  assert.deepEqual(detailed.records[0].payload, { requestBody: payload });
});

test("leading and standalone blank lines terminate without duplicating or looping records", async (t) => {
  const { file } = await fixture(t, "\n" + lines([http()]));
  const store = new BackendLogStore(file);
  assert.equal((await store.searchLogs()).records.length, 1);
  assert.equal(
    (await store.searchLogs({ requestId: "no-match" })).records.length,
    0,
  );
  assert.equal((await store.errorSummary()).totalFailures, 0);
  await writeFile(file, "\n");
  assert.equal((await store.searchLogs()).records.length, 0);
  assert.equal((await store.errorSummary()).coverage.scannedFromByte, 0);
  await writeFile(file, "");
  assert.equal((await store.searchLogs()).coverage.partial, false);
});

test("all filters are exact while free text is a literal case insensitive substring", async (t) => {
  const row = publication({ data: { text: "Literal .* [Example] Ω" } });
  const { file } = await fixture(
    t,
    lines([row, http({ requestId: "other", userId: "actor-b" })]),
  );
  const store = new BackendLogStore(file);
  const filters: SearchLogsInput = {
    requestId: "request-a",
    userId: "actor-a",
    recipientUserId: "recipient-a",
    event: "realtime_publication",
    eventType: "message_new",
    level: "warn",
    status: 200,
    query: ".* [EXAMPLE] ω",
    from: time,
    to: time,
  };
  assert.equal((await store.searchLogs(filters)).records.length, 1);
  for (const [key, value] of Object.entries({
    requestId: "request",
    userId: "actor",
    recipientUserId: "recipient",
    eventType: "message",
    status: 201,
    query: "^Literal",
    level: "error",
  })) {
    assert.equal(
      (await store.searchLogs({ ...filters, [key]: value })).records.length,
      0,
      key,
    );
  }
  assert.equal(
    (await store.searchLogs({ method: "POST", route: "/messages" })).records
      .length,
    1,
  );
  assert.equal((await store.searchLogs({ method: "GET" })).records.length, 0);
  assert.equal(
    (await store.searchLogs({ route: "/message" })).records.length,
    0,
  );
  assert.equal(
    (await store.searchLogs({ from: "2026-10-16T12:00:00.001Z" })).records
      .length,
    0,
  );
  assert.equal(
    (await store.searchLogs({ to: "2026-10-16T11:59:59.999Z" })).records.length,
    0,
  );
});

test("invalid arguments are rejected before reading and never echoed", async (t) => {
  const { file } = await fixture(t);
  const store = new BackendLogStore(file);
  for (const args of [
    { file: "/private/untrusted" },
    { query: "" },
    { query: "x".repeat(501) },
    { requestId: "line\nbreak" },
    { status: 0 },
    { status: 600 },
    { status: 400.5 },
    { limit: 0 },
    { limit: 201 },
    { limit: NaN },
    { includePayloads: "true" },
    { event: "" },
    { method: "post" },
    { level: "fatal" },
    { from: "yesterday" },
    { from: "2026-02-30T00:00:00Z" },
    { from: "2026-10-17T00:00:00Z", to: time },
  ]) {
    await assert.rejects(
      store.searchLogs(args as SearchLogsInput),
      hasCode("INVALID_ARGUMENT"),
    );
  }
  await assert.rejects(
    store.traceRequest({ requestId: "" }),
    hasCode("INVALID_ARGUMENT"),
  );
  await assert.rejects(
    store.errorSummary({ limit: 101 }),
    hasCode("INVALID_ARGUMENT"),
  );
  assert.throws(
    () => new BackendLogStore(file, { maxScanBytes: Infinity }),
    hasCode("INVALID_ARGUMENT"),
  );
  assert.throws(
    () => new BackendLogStore(file, { maxResultBytes: 100 }),
    hasCode("INVALID_ARGUMENT"),
  );
});

test("safe reads preserve bytes, inode, permissions, and modification time", async (t) => {
  const { directory, file } = await fixture(t, lines([http()]));
  await chmod(file, 0o440);
  await chmod(directory, 0o500);
  const before = await lstat(file);
  const parentBefore = await lstat(directory);
  const bytes = await readFile(file);
  assert.equal(
    (await new BackendLogStore(file).searchLogs()).records.length,
    1,
  );
  const after = await lstat(file);
  const parentAfter = await lstat(directory);
  assert.deepEqual(await readFile(file), bytes);
  for (const key of ["ino", "mode", "mtimeMs", "size"] as const)
    assert.equal(after[key], before[key]);
  assert.equal(parentAfter.mode, parentBefore.mode);
});

test("symlink leaves, symlink ancestors, hard links, directories, and unreadable captures are rejected", async (t) => {
  const { directory, file } = await fixture(t, lines([http()]));
  const alias = join(directory, "alias.jsonl");
  await symlink(file, alias);
  await assert.rejects(
    new BackendLogStore(alias).searchLogs(),
    hasCode("CAPTURE_UNAVAILABLE"),
  );
  const actual = join(directory, "actual");
  await mkdir(actual);
  await writeFile(join(actual, "inside.jsonl"), lines([http()]));
  await symlink(actual, join(directory, "alias-dir"));
  await assert.rejects(
    new BackendLogStore(
      join(directory, "alias-dir", "inside.jsonl"),
    ).searchLogs(),
    hasCode("CAPTURE_UNAVAILABLE"),
  );
  const hard = join(directory, "hard.jsonl");
  await link(file, hard);
  await assert.rejects(
    new BackendLogStore(file).searchLogs(),
    hasCode("CAPTURE_UNAVAILABLE"),
  );
  await assert.rejects(
    new BackendLogStore(directory).searchLogs(),
    hasCode("CAPTURE_UNAVAILABLE"),
  );
  const noRead = join(directory, "no-read.jsonl");
  await writeFile(noRead, lines([http()]), { mode: 0o000 });
  await assert.rejects(
    new BackendLogStore(noRead).searchLogs(),
    hasCode("CAPTURE_UNAVAILABLE"),
  );
});

test("malformed, invalid UTF8, wrong-shape and oversized lines are skipped with explicit counters", async (t) => {
  const good = lines([http()]);
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"invalid":"'),
    Buffer.from([0xff]),
    Buffer.from('"}\n'),
  ]);
  const content = Buffer.concat([
    Buffer.from(
      "not json\nnull\n[]\n" + JSON.stringify({ source: "other" }) + "\n",
    ),
    invalidUtf8,
    Buffer.from("x".repeat(1200) + "\n" + good),
  ]);
  const { file } = await fixture(t, content);
  const result = await new BackendLogStore(file, {
    maxRecordBytes: 1000,
  }).searchLogs();
  assert.equal(result.records.length, 1);
  assert.equal(result.coverage.malformedLines, 2);
  assert.equal(result.coverage.invalidRecords, 3);
  assert.equal(result.coverage.oversizedLines, 1);
  assert.equal(result.coverage.partial, true);
});

test("trailing append fragments are ignored until newline completion", async (t) => {
  const second = JSON.stringify(
    http({ requestId: "append", requestBody: { text: "日本語 😀" } }),
  );
  const { file } = await fixture(t, lines([http()]) + second.slice(0, -3));
  const store = new BackendLogStore(file);
  const initial = await store.searchLogs();
  assert.equal(initial.records.length, 1);
  assert.equal(initial.coverage.incompleteTrailingLine, true);
  assert.ok(initial.coverage.skippedBoundaryBytes > 0);
  await appendFile(file, second.slice(-3) + "\n");
  const finished = await store.searchLogs();
  assert.equal(finished.records.length, 2);
  assert.equal(finished.coverage.incompleteTrailingLine, false);
  assert.equal(finished.records[0].requestId, "append");
});

test("signed cursors page an immutable snapshot, permit appends and do not repeat records", async (t) => {
  const { file } = await fixture(
    t,
    lines(
      Array.from({ length: 6 }, (_, index) =>
        http({ requestId: `id-${index}` }),
      ),
    ),
  );
  const store = new BackendLogStore(file);
  let page = await store.searchLogs({ limit: 2 });
  const ids = page.records.map((row) => row.requestId);
  const originalSize = page.coverage.snapshotBytes;
  assert.ok(page.nextCursor && page.nextCursor.length <= 512);
  await appendFile(file, lines([http({ requestId: "new-append" })]));
  while (page.nextCursor) {
    page = await store.searchLogs({ limit: 2, cursor: page.nextCursor });
    ids.push(...page.records.map((row) => row.requestId));
    assert.equal(page.coverage.snapshotBytes, originalSize);
  }
  assert.deepEqual(ids, ["id-5", "id-4", "id-3", "id-2", "id-1", "id-0"]);
  assert.equal((await store.searchLogs()).records[0].requestId, "new-append");
});

test("cursors reject changed filters, operations, signatures, process keys, rotation and truncation", async (t) => {
  const original = lines([
    http({ requestId: "old" }),
    http({ requestId: "new" }),
  ]);
  const { directory, file } = await fixture(t, original);
  const store = new BackendLogStore(file);
  const cursor = (await store.searchLogs({ limit: 1 })).nextCursor!;
  await assert.rejects(
    store.searchLogs({ limit: 2, cursor }),
    hasCode("INVALID_CURSOR"),
  );
  await assert.rejects(
    store.traceRequest({ requestId: "old", limit: 1, cursor }),
    hasCode("INVALID_CURSOR"),
  );
  await assert.rejects(
    store.searchLogs({
      limit: 1,
      cursor: cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A"),
    }),
    hasCode("INVALID_CURSOR"),
  );
  await assert.rejects(
    new BackendLogStore(file).searchLogs({ limit: 1, cursor }),
    hasCode("INVALID_CURSOR"),
  );
  await writeFile(file, lines([http()]));
  await assert.rejects(
    store.searchLogs({ limit: 1, cursor }),
    hasCode("INVALID_CURSOR"),
  );
  await writeFile(file, original);
  const fresh = (await store.searchLogs({ limit: 1 })).nextCursor!;
  await rename(file, join(directory, "archived.jsonl"));
  await writeFile(file, original);
  await assert.rejects(
    store.searchLogs({ limit: 1, cursor: fresh }),
    hasCode("INVALID_CURSOR"),
  );
});

test("same inode snapshot rewriting is detected at the fenced boundary", async (t) => {
  const { file } = await fixture(
    t,
    lines([http({ requestId: "one" }), http({ requestId: "two" })]),
  );
  const store = new BackendLogStore(file);
  const cursor = (await store.searchLogs({ limit: 1 })).nextCursor!;
  const old = await readFile(file, "utf8");
  await writeFile(file, old.replace("one", "ONE"));
  await assert.rejects(
    store.searchLogs({ limit: 1, cursor }),
    hasCode("INVALID_CURSOR"),
  );
});

test("bounded windows preserve UTF8 records across page boundaries and expose partial coverage", async (t) => {
  const expected = Array.from({ length: 15 }, (_, index) => `id-${index}`);
  const { file } = await fixture(
    t,
    lines(
      expected.map((requestId) =>
        http({ requestId, requestBody: { text: "😀日本語".repeat(3) } }),
      ),
    ),
  );
  const store = new BackendLogStore(file, { maxScanBytes: 770 });
  let page = await store.searchLogs({ includePayloads: true, limit: 200 });
  assert.equal(page.coverage.partial, true);
  assert.ok(page.coverage.readBytes <= 771);
  const ids = page.records.map((row) => row.requestId);
  let pages = 1;
  while (page.nextCursor) {
    assert.ok(pages++ < 30, "cursor must progress");
    page = await store.searchLogs({
      includePayloads: true,
      limit: 200,
      cursor: page.nextCursor,
    });
    ids.push(...page.records.map((row) => row.requestId));
    assert.equal(page.coverage.malformedLines, 0);
  }
  assert.deepEqual(ids, expected.reverse());
});

test("a line larger than a scan window does not block older pages", async (t) => {
  const { file } = await fixture(
    t,
    lines([
      http({ requestId: "older" }),
      http({ requestId: "huge", requestBody: { text: "x".repeat(3000) } }),
      http({ requestId: "latest" }),
    ]),
  );
  const store = new BackendLogStore(file, {
    maxScanBytes: 500,
    maxRecordBytes: 400,
  });
  let page = await store.searchLogs();
  const ids = page.records.map((row) => row.requestId);
  let pages = 1,
    oversized = page.coverage.oversizedLines;
  while (page.nextCursor) {
    assert.ok(pages++ < 20);
    page = await store.searchLogs({ cursor: page.nextCursor });
    ids.push(...page.records.map((row) => row.requestId));
    oversized += page.coverage.oversizedLines;
  }
  assert.deepEqual(ids, ["latest", "older"]);
  assert.ok(oversized > 0);
});

test("payload omission and result byte pagination remain bounded without dropping metadata records", async (t) => {
  const { file } = await fixture(
    t,
    lines(
      Array.from({ length: 20 }, (_, index) =>
        http({
          requestId: `id-${index}`,
          route: "/" + "r".repeat(500),
          requestBody: { text: "x".repeat(index === 19 ? 20000 : 600) },
        }),
      ),
    ),
  );
  const store = new BackendLogStore(file, { maxResultBytes: 8192 });
  let page = await store.searchLogs({ includePayloads: true, limit: 200 });
  assert.equal(page.records[0].payloadOmitted, true);
  assert.ok(page.coverage.payloadsOmitted > 0);
  const ids = page.records.map((row) => row.requestId);
  let pages = 1;
  while (page.nextCursor) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    assert.ok(pages++ < 30);
    page = await store.searchLogs({
      includePayloads: true,
      limit: 200,
      cursor: page.nextCursor,
    });
    ids.push(...page.records.map((row) => row.requestId));
  }
  assert.deepEqual(
    ids,
    Array.from({ length: 20 }, (_, index) => `id-${19 - index}`),
  );
});

test("trace result budget includes UTF8 publication aggregates as well as records", async (t) => {
  const { file } = await fixture(
    t,
    lines(
      Array.from({ length: 24 }, (_, index) =>
        publication({
          publicationId: `publication-${index}`,
          actorUserId: "人".repeat(128),
          recipientUserId: "😀".repeat(64),
          eventType: "😀".repeat(64),
          channel: "通".repeat(256),
          data: { text: "payload".repeat(100) },
        }),
      ),
    ),
  );
  const store = new BackendLogStore(file, { maxResultBytes: 8192 });
  let page = await store.traceRequest({
    requestId: "request-a",
    limit: 200,
    includePayloads: true,
  });
  const ids = page.records.map((row) => row.publicationId);
  let pages = 1;
  while (page.nextCursor) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    assert.ok(page.coverage.metadataTruncated > 0);
    assert.ok(pages++ < 30);
    page = await store.traceRequest({
      requestId: "request-a",
      limit: 200,
      includePayloads: true,
      cursor: page.nextCursor,
    });
    ids.push(...page.records.map((row) => row.publicationId));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
  assert.equal(new Set(ids).size, 24);
});

test("escaped control metadata is bounded and cannot produce an unchanged continuation cursor", async (t) => {
  const control = "\u0001";
  const fields = Object.fromEntries(
    [
      "userId",
      "actorUserId",
      "recipientUserId",
      "publicationId",
      "method",
      "eventType",
      "result",
    ].map((key) => [key, control.repeat(128)]),
  );
  const { file } = await fixture(
    t,
    lines([
      http({ requestId: "older" }),
      http({
        ...fields,
        route: control.repeat(512),
        channel: control.repeat(256),
      }),
    ]),
  );
  const store = new BackendLogStore(file, { maxResultBytes: 8192 });
  const result = await store.searchLogs({ limit: 200 });
  assert.equal(result.records.length, 2);
  assert.equal(result.nextCursor, undefined);
  assert.ok(result.coverage.metadataTruncated > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
});

test("truncated publication labels retain separate raw retry identities", async (t) => {
  const a = "same-prefix".repeat(40) + "-a";
  const b = "same-prefix".repeat(40) + "-b";
  const { file } = await fixture(
    t,
    lines([
      publication({ publicationId: a }),
      publication({ publicationId: b }),
      publication({ publicationId: a, attempt: 2, result: "success" }),
    ]),
  );
  const result = await new BackendLogStore(file).traceRequest({
    requestId: "request-a",
  });
  assert.equal(result.publications.length, 2);
  assert.deepEqual(
    result.publications.map((group) => group.attempts).sort(),
    [1, 2],
  );
  assert.equal(
    result.publications.filter((group) => group.providerAccepted).length,
    1,
  );
  assert.ok(result.coverage.metadataTruncated > 0);
});

test("summary keeps different raw failure patterns distinct when displayed metadata is truncated", async (t) => {
  const prefix = "/" + "r".repeat(600);
  const { file } = await fixture(
    t,
    lines([
      http({ status: 500, route: prefix + "-a" }),
      http({ status: 500, route: prefix + "-b" }),
    ]),
  );
  const result = await new BackendLogStore(file).errorSummary();
  assert.equal(result.groups.length, 2);
  assert.equal(result.coverage.metadataTruncated, 2);
  assert.deepEqual(
    result.groups.map((group) => group.count),
    [1, 1],
  );
});

test("request traces are chronological and group all fanout retries without claiming client receipt", async (t) => {
  const { file } = await fixture(
    t,
    lines([
      publication({
        timestamp: "2026-10-16T12:00:03.000Z",
        attempt: 2,
        result: "success",
        level: "info",
      }),
      publication({ timestamp: "2026-10-16T12:00:01.000Z" }),
      http({ timestamp: "2026-10-16T12:00:04.000Z" }),
      publication({
        timestamp: "2026-10-16T12:00:02.000Z",
        publicationId: "publication-b",
        recipientUserId: "recipient-b",
      }),
      http({ requestId: "unrelated" }),
    ]),
  );
  const result = await new BackendLogStore(file).traceRequest({
    requestId: "request-a",
  });
  assert.equal(result.records.length, 4);
  assert.deepEqual(
    result.records.map((row) => row.timestamp),
    result.records.map((row) => row.timestamp).sort(),
  );
  assert.deepEqual(result.publications, [
    {
      publicationId: "publication-a",
      actorUserId: "actor-a",
      recipientUserId: "recipient-a",
      eventType: "message_new",
      attempts: 2,
      failedAttempts: 1,
      providerAccepted: true,
      clientReceiptObserved: false,
    },
    {
      publicationId: "publication-b",
      actorUserId: "actor-a",
      recipientUserId: "recipient-b",
      eventType: "message_new",
      attempts: 1,
      failedAttempts: 1,
      providerAccepted: false,
      clientReceiptObserved: false,
    },
  ]);
  assert.match(result.semantics, /not client receipt/);
  const partial = await new BackendLogStore(file).traceRequest({
    requestId: "request-a",
    limit: 1,
  });
  assert.equal(partial.coverage.partial, true);
  assert.ok(partial.nextCursor);
});

test("summary counts HTTP failures, overlapping aborts and provider failures even with HTTP 200", async (t) => {
  const { file } = await fixture(
    t,
    lines([
      http(),
      http({ status: 404, level: "warn" }),
      http({ status: 503, level: "error" }),
      http({ status: 503, aborted: true, level: "error" }),
      http({ status: 200, aborted: true, level: "error" }),
      publication(),
      publication({ attempt: 2 }),
      publication({ attempt: 3, result: "success", level: "info" }),
    ]),
  );
  const store = new BackendLogStore(file);
  const result = await store.errorSummary();
  assert.equal(result.totalFailures, 6);
  assert.equal(result.http4xx, 1);
  assert.equal(result.http5xx, 2);
  assert.equal(result.httpAborts, 2);
  assert.equal(result.realtimeFailedAttempts, 2);
  assert.equal(
    result.groups.find((group) => group.kind === "realtime_failure")?.count,
    2,
  );
  assert.equal(JSON.stringify(result).includes("responseBody"), false);
  assert.equal(
    (await store.errorSummary({ recipientUserId: "recipient-a" }))
      .totalFailures,
    2,
  );
  const bounded = await store.errorSummary({ limit: 1 });
  assert.equal(bounded.totalFailures, 6);
  assert.equal(bounded.groups.length, 1);
  assert.ok(bounded.groupsOmitted > 0);
});

test("summary windows have their own cursors and never imply whole-file totals", async (t) => {
  const { file } = await fixture(
    t,
    lines(
      Array.from({ length: 12 }, (_, index) =>
        publication({ publicationId: `p-${index}` }),
      ),
    ),
  );
  const store = new BackendLogStore(file, { maxScanBytes: 1200 });
  let page = await store.errorSummary();
  assert.equal(page.coverage.partial, true);
  assert.ok(page.totalFailures < 12);
  let total = page.totalFailures,
    pages = 1;
  while (page.nextCursor) {
    assert.ok(pages++ < 20);
    page = await store.errorSummary({ cursor: page.nextCursor });
    total += page.totalFailures;
  }
  assert.equal(total, 12);
});

test("all service sources and inspector metadata are projected without arbitrary payload fields", async (t) => {
  const sources = [
    "backend",
    "web-client",
    "redis",
    "mongodb",
    "macos",
    "collector",
  ];
  const records = sources.map((source) => ({
    ...http(),
    source,
    event: "operation",
    requestId: null,
    userId: null,
    instanceId: `${source}-a`,
    captureId: "capture-a",
    category: "database",
    name: "query.run",
    phase: "end",
    traceId: "t19",
    spanId: "s21",
    parentSpanId: "s20",
    roomId: "room-a",
    sessionGeneration: 3,
    seq: 367,
    durationMicros: 265300,
    origin: "server_log",
    component: "storage",
    operation: "query",
    result: "completed",
    data: { safeCount: 7, error: "private diagnostic detail" },
    arbitraryPrivateKey: "should-never-be-projected",
  }));
  const { file } = await fixture(t, lines(records));
  const store = new BackendLogStore(file);
  const page = await store.searchLogs();
  assert.equal(page.records.length, 6);
  assert.equal(page.coverage.partial, false);
  for (const source of sources) {
    const selected = await store.searchLogs({
      source: source as SearchLogsInput["source"],
      instanceId: `${source}-a`,
      captureId: "capture-a",
      category: "database",
      name: "query.run",
      phase: "end",
      traceId: "t19",
      roomId: "room-a",
      sessionGeneration: 3,
    });
    assert.equal(selected.records.length, 1);
    assert.equal(selected.records[0].source, source);
    assert.equal(selected.records[0].durationMicros, 265300);
    assert.equal(selected.records[0].parentSpanId, "s20");
    assert.equal(selected.records[0].payload, undefined);
  }
  assert.doesNotMatch(
    JSON.stringify(page),
    /private diagnostic detail|should-never-be-projected|arbitraryPrivateKey/,
  );
  const payloads = await store.searchLogs({
    source: "web-client",
    includePayloads: true,
  });
  assert.deepEqual(payloads.records[0].payload?.data, records[1].data);
  assert.doesNotMatch(
    JSON.stringify(payloads),
    /should-never-be-projected|arbitraryPrivateKey/,
  );
  for (const args of [
    { source: "web-client", instanceId: "web-client" },
    { captureId: "capture" },
    { sessionGeneration: 2 },
  ]) {
    assert.equal(
      (await store.searchLogs(args as SearchLogsInput)).records.length,
      0,
    );
  }
});

test("causal trace scopes reused IDs to source, instance, capture and session and paginates", async (t) => {
  const event = {
    ...http(),
    source: "web-client",
    event: "inspector",
    requestId: null,
    instanceId: "tab-a",
    captureId: "capture-a",
    sessionGeneration: 3,
    category: "realtime",
    name: "inbox.publication",
    traceId: "t19",
  };
  const { file } = await fixture(
    t,
    lines([
      { ...event, phase: "end", timestamp: "2026-10-16T12:00:02.000Z", seq: 2 },
      { ...event, phase: "begin", seq: 1 },
      { ...event, instanceId: "tab-b" },
      { ...event, captureId: "capture-b" },
      { ...event, sessionGeneration: 4 },
      { ...event, source: "backend" },
    ]),
  );
  const store = new BackendLogStore(file);
  const query = {
    source: "web-client" as const,
    instanceId: "tab-a",
    traceId: "t19",
    captureId: "capture-a",
    sessionGeneration: 3,
  };
  const trace = await store.traceEvents(query);
  assert.deepEqual(
    trace.records.map((row) => row.phase),
    ["begin", "end"],
  );
  assert.match(
    trace.semantics,
    /No associations or client delivery are inferred/,
  );
  const first = await store.traceEvents({ ...query, limit: 1 });
  assert.ok(first.nextCursor);
  const second = await store.traceEvents({
    ...query,
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.notEqual(first.records[0].seq, second.records[0].seq);
  await assert.rejects(
    store.traceEvents({
      ...query,
      instanceId: "tab-b",
      limit: 1,
      cursor: first.nextCursor,
    }),
    hasCode("INVALID_CURSOR"),
  );
  await assert.rejects(
    store.searchLogs({ ...query, limit: 1, cursor: first.nextCursor }),
    hasCode("INVALID_CURSOR"),
  );
});

test("request traces never group client reception or other server records as backend publication acceptance", async (t) => {
  const { file } = await fixture(
    t,
    lines([
      publication({ result: "success" }),
      publication({
        source: "web-client",
        result: "success",
        direction: "receive",
        requestId: null,
      }),
      publication({
        source: "web-client",
        result: "success",
        direction: "receive",
      }),
      publication({ source: "macos", result: "success" }),
      publication({ direction: "receive", result: "success" }),
      http({ source: "redis", event: "command", requestId: "request-a" }),
    ]),
  );
  const result = await new BackendLogStore(file).traceRequest({
    requestId: "request-a",
  });
  assert.equal(result.records.length, 5);
  assert.equal(result.publications.length, 1);
  assert.equal(result.publications[0].attempts, 1);
  assert.equal(result.publications[0].providerAccepted, true);
  assert.equal(result.publications[0].clientReceiptObserved, false);
});

test("generic warn/error/failed operations are counted once and grouped by source/category/name", async (t) => {
  const base = {
    ...http(),
    event: "service_log",
    requestId: null,
    userId: null,
    category: "database",
    name: "query",
    data: { error: "private error detail" },
  };
  const { file } = await fixture(
    t,
    lines([
      { ...base, source: "redis", level: "warn" },
      { ...base, source: "redis", level: "warn" },
      { ...base, source: "mongodb", level: "error", result: "failure" },
      { ...base, source: "web-client", level: "info", result: "failed" },
      { ...base, source: "macos", level: "info" },
      {
        ...base,
        source: "collector",
        level: "error",
        category: "capture",
        name: "gap",
      },
      publication(),
      http({ status: 500 }),
    ]),
  );
  const store = new BackendLogStore(file);
  const summary = await store.errorSummary();
  assert.equal(summary.totalFailures, 7);
  assert.equal(summary.genericFailures, 5);
  assert.equal(summary.http5xx, 1);
  assert.equal(summary.realtimeFailedAttempts, 1);
  assert.equal(
    summary.groups.find((group) => group.source === "redis")?.count,
    2,
  );
  assert.equal(
    summary.groups.find((group) => group.source === "collector")?.category,
    "capture",
  );
  assert.equal(
    (
      await store.errorSummary({
        source: "redis",
        category: "database",
        name: "query",
      })
    ).totalFailures,
    2,
  );
  assert.doesNotMatch(JSON.stringify(summary), /private error detail|"data":/);
});

test("unified capture rejects malformed envelopes with explicit partial coverage", async (t) => {
  const valid = {
    ...http(),
    source: "web-client",
    event: "inspector",
    requestId: null,
    userId: null,
  };
  const { file } = await fixture(
    t,
    lines([
      valid,
      { ...valid, source: "unknown" },
      { ...valid, event: "" },
      { ...valid, event: "x".repeat(129) },
      { ...valid, event: "bad\nevent" },
      { ...valid, level: "verbose" },
      { ...valid, timestamp: "yesterday" },
      { ...valid, requestId: {} },
      { ...valid, userId: undefined },
    ]) + "{incomplete",
  );
  const result = await new BackendLogStore(file).searchLogs();
  assert.equal(result.records.length, 1);
  assert.equal(result.coverage.invalidRecords, 8);
  assert.equal(result.coverage.incompleteTrailingLine, true);
  assert.equal(result.coverage.partial, true);
});

test("explicit summary counters distinguish warning-only diagnostics from errors and failed operations", async (t) => {
  const diagnostic = {
    ...http(),
    event: "service_log",
    source: "mongodb",
    requestId: null,
    userId: null,
  };
  const { file } = await fixture(
    t,
    lines([
      { ...diagnostic, level: "warn" },
      { ...diagnostic, level: "warn", result: "failure" },
      { ...diagnostic, level: "error", result: "failed" },
      { ...diagnostic, level: "error" },
      { ...diagnostic, level: "info", result: "failed" },
      http({ level: "error", status: 503, aborted: true }),
      http({ level: "warn", status: 200 }),
      publication(),
      publication({ level: "error", result: "success" }),
    ]),
  );
  const summary = await new BackendLogStore(file).errorSummary();
  assert.equal(summary.warningRecords, 4);
  assert.equal(summary.errorRecords, 4);
  assert.equal(summary.failedOperations, 5);
  assert.equal(summary.warningOnlyRecords, 2);
  assert.equal(summary.totalErrorsAndFailedOperations, 7);
  // Legacy counts retain their historical meaning, including generic warnings.
  assert.equal(summary.totalFailures, 7);
  assert.equal(summary.genericFailures, 5);
  assert.match(summary.semantics, /must not be added together/);
  const warnings = await new BackendLogStore(file).errorSummary({
    source: "mongodb",
  });
  assert.equal(warnings.warningRecords, 2);
  assert.equal(warnings.warningOnlyRecords, 1);
  assert.equal(warnings.failedOperations, 3);
  assert.equal(warnings.totalErrorsAndFailedOperations, 4);
});

test("safe producer timing, native codes and metric metadata are readable without payload opt-in", async (t) => {
  const { file } = await fixture(
    t,
    lines([
      {
        ...http(),
        source: "mongodb",
        event: "service_log",
        sourceTimestamp: "2026-10-16T15:00:00+03:00",
        timestampSource: "service",
        receivedAt: "2026-10-16T12:00:01.123456Z",
        collectedAt: "2026-10-16T12:00:02Z",
        sourceEventCode: "22430",
        data: { secret: "private query" },
      },
      {
        ...http(),
        source: "web-client",
        event: "client_inspector",
        category: "inspector",
        name: "metric.queue.pending",
        metricName: "queue.pending",
        metricValue: 8,
        metricGroup: "gauges",
        data: { private: "private metric payload" },
      },
    ]),
  );
  const store = new BackendLogStore(file);
  const page = await store.searchLogs();
  const native = page.records.find((record) => record.source === "mongodb")!;
  assert.equal(native.sourceTimestamp, time);
  assert.equal(native.receivedAt, "2026-10-16T12:00:01.123456Z");
  assert.equal(native.collectedAt, "2026-10-16T12:00:02.000Z");
  assert.equal(native.timestampSource, "service");
  assert.equal(native.sourceEventCode, "22430");
  const metric = page.records.find((record) => record.source === "web-client")!;
  assert.equal(metric.metricName, "queue.pending");
  assert.equal(metric.metricValue, 8);
  assert.equal(metric.metricGroup, "gauges");
  assert.equal(
    (
      await store.searchLogs({
        metricName: "queue.pending",
        metricGroup: "gauges",
      })
    ).records.length,
    1,
  );
  assert.equal(
    (
      await store.errorSummary({
        sourceEventCode: "22430",
        timestampSource: "service",
      })
    ).coverage.scannedRecords,
    2,
  );
  assert.doesNotMatch(
    JSON.stringify(page),
    /private query|private metric payload/,
  );
});

test("malformed timing, unsafe native codes and arbitrary payload metric fields are not promoted", async (t) => {
  const { file } = await fixture(
    t,
    lines([
      {
        ...http(),
        source: "web-client",
        event: "client_inspector",
        category: "inspector",
        metricName: "unsafe metric=secret",
        metricValue: 1,
        metricGroup: "gauges",
        sourceTimestamp: "yesterday",
        receivedAt: "secret",
        collectedAt: "2026-10-16",
        timestampSource: "untrusted",
        sourceEventCode: "secret/token",
        data: { metricName: "should.never.promote", metricValue: 42 },
      },
      {
        ...http(),
        source: "backend",
        metricName: "not.flutter",
        metricValue: 7,
        metricGroup: "gauges",
      },
    ]),
  );
  const page = await new BackendLogStore(file).searchLogs();
  for (const record of page.records) {
    for (const key of [
      "sourceTimestamp",
      "receivedAt",
      "collectedAt",
      "timestampSource",
      "sourceEventCode",
      "metricName",
      "metricValue",
      "metricGroup",
    ])
      assert.equal(
        (record as unknown as Record<string, unknown>)[key],
        undefined,
      );
  }
  assert.doesNotMatch(
    JSON.stringify(page),
    /secret|should.never.promote|not.flutter/,
  );
});

test("fifty-row pages read only bounded backward blocks and preserve all 1200 records", async (t) => {
  const expected = Array.from({ length: 1200 }, (_, index) => `lazy-${index}`);
  const { file } = await fixture(
    t,
    lines(
      expected.map((requestId) =>
        http({ requestId, responseBody: { text: "x".repeat(600) } }),
      ),
    ),
  );
  const store = new BackendLogStore(file);
  let page = await store.searchLogs({ limit: 50 });
  const ids: string[] = [];
  do {
    assert.ok(
      page.coverage.readBytes <= 128 * 1024,
      "dense fifty-row page cannot eagerly read the capture",
    );
    ids.push(...page.records.map((row) => row.requestId!));
    if (!page.nextCursor) break;
    page = await store.searchLogs({ limit: 50, cursor: page.nextCursor });
    // eslint-disable-next-line no-constant-condition -- Consume the final page before ending cursor traversal.
  } while (true);
  assert.deepEqual(ids, expected.reverse());
  assert.equal(page.coverage.scannedFromByte, 0);
});

test("producer envelope omissions remain visible without payload opt-in", async (t) => {
  const { file } = await fixture(
    t,
    lines([
      http({
        payloadOmitted: true,
        omissionReason: "record_byte_limit",
        omittedBytes: 2000000,
      }),
    ]),
  );
  const result = await new BackendLogStore(file).searchLogs();
  assert.equal(result.records[0].payloadOmitted, true);
  assert.equal(result.records[0].omissionReason, "record_byte_limit");
  assert.equal(result.records[0].omittedBytes, 2000000);
  assert.equal(result.coverage.payloadsOmitted, 1);
});
