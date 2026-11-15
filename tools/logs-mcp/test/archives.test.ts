import assert from "node:assert/strict";
import {
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

const id = "events.20261017T003000123Z-ab12cd34.jsonl";
const otherId = "events.20261017T004000123Z-ab12cd34.jsonl";
const record = (requestId: string) =>
  JSON.stringify({
    timestamp: "2026-10-17T00:00:00.000Z",
    source: "backend",
    event: "http_request",
    level: "info",
    requestId,
    userId: null,
    status: 200,
  }) + "\n";
async function fixture(t: TestContext) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "logs-archives-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    archives: join(directory, "archives"),
    file: join(directory, "events.jsonl"),
  };
}

test("archive discovery never creates missing directories", async (t) => {
  const { directory, file } = await fixture(t);
  const result = await new BackendLogStore(file).listLogArchives();
  assert.equal(result.available, false);
  assert.deepEqual(result.archives, []);
  await assert.rejects(lstat(join(directory, "archives")), { code: "ENOENT" });
});

test("exact retained archives are queried separately with independent cursor snapshots", async (t) => {
  const { archives, file } = await fixture(t);
  await mkdir(archives, { mode: 0o700 });
  await writeFile(file, record("live"), { mode: 0o600 });
  const old = record("archive-old") + record("archive-new");
  await writeFile(join(archives, id), old, { mode: 0o600 });
  await writeFile(join(archives, otherId), record("other"), { mode: 0o600 });
  await writeFile(join(archives, "unrelated.jsonl"), "private unrelated file", {
    mode: 0o600,
  });
  const store = new BackendLogStore(file);
  const listing = await store.listLogArchives();
  assert.deepEqual(
    listing.archives.map((archive) => archive.id),
    [otherId, id],
  );
  assert.equal(listing.archives[1].bytes, Buffer.byteLength(old));
  assert.equal((await store.searchLogs()).records[0].requestId, "live");
  const first = await store.searchLogs({ archive: id, limit: 1 });
  assert.equal(first.records[0].requestId, "archive-new");
  assert.ok(first.nextCursor);
  const second = await store.searchLogs({
    archive: id,
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.records[0].requestId, "archive-old");
  await assert.rejects(
    store.searchLogs({ archive: otherId, limit: 1, cursor: first.nextCursor }),
    (error) =>
      error instanceof LogStoreError && error.code === "INVALID_CURSOR",
  );
  await assert.rejects(
    store.searchLogs({ limit: 1, cursor: first.nextCursor }),
    (error) =>
      error instanceof LogStoreError && error.code === "INVALID_CURSOR",
  );
  assert.equal(
    (await store.traceRequest({ archive: id, requestId: "archive-old" }))
      .records.length,
    1,
  );
  assert.equal((await store.errorSummary({ archive: id })).totalFailures, 0);
  assert.equal(
    (
      await store.traceEvents({
        archive: id,
        source: "web-client",
        instanceId: "tab-a",
        traceId: "t1",
      })
    ).records.length,
    0,
  );
  assert.equal(await readFile(join(archives, id), "utf8"), old);
});

test("archive arguments reject traversal, arbitrary filenames and cross-capture prefixes", async (t) => {
  const { file } = await fixture(t);
  const store = new BackendLogStore(file);
  for (const archive of [
    "../events.jsonl",
    "/tmp/events.jsonl",
    "unrelated.jsonl",
    "traffic.20261017T003000123Z-ab12cd34.jsonl",
    "events.20261017T003000123Z-ab12cd34.jsonl/child",
  ])
    await assert.rejects(
      store.searchLogs({ archive }),
      (error) =>
        error instanceof LogStoreError && error.code === "INVALID_ARGUMENT",
    );
  assert.equal((await store.searchLogs({ archive: id })).available, false);
});

test("discovery excludes unsafe candidates and refuses a linked archive directory", async (t) => {
  const { directory, archives, file } = await fixture(t);
  await mkdir(archives);
  const target = join(directory, "private.jsonl");
  await writeFile(target, record("private"), { mode: 0o600 });
  await symlink(target, join(archives, id));
  await link(target, join(archives, otherId));
  const store = new BackendLogStore(file);
  const result = await store.listLogArchives();
  assert.equal(result.unsafeEntries, 2);
  assert.deepEqual(result.archives, []);
  await assert.rejects(
    store.searchLogs({ archive: id }),
    (error) =>
      error instanceof LogStoreError && error.code === "CAPTURE_UNAVAILABLE",
  );
  await rename(archives, join(directory, "old-archives"));
  await symlink(join(directory, "old-archives"), archives);
  await assert.rejects(
    store.listLogArchives(),
    (error) =>
      error instanceof LogStoreError && error.code === "CAPTURE_UNAVAILABLE",
  );
});

test("rollover invalidates live cursors while the retained archive remains readable", async (t) => {
  const { archives, file } = await fixture(t);
  await mkdir(archives);
  await writeFile(file, record("old") + record("new"), { mode: 0o600 });
  const store = new BackendLogStore(file);
  const first = await store.searchLogs({ limit: 1 });
  assert.ok(first.nextCursor);
  await rename(file, join(archives, id));
  await writeFile(file, record("after-rollover"), { mode: 0o600 });
  await assert.rejects(
    store.searchLogs({ limit: 1, cursor: first.nextCursor }),
    (error) =>
      error instanceof LogStoreError && error.code === "INVALID_CURSOR",
  );
  assert.equal((await store.searchLogs({ archive: id })).records.length, 2);
  assert.equal(
    (await store.searchLogs()).records[0].requestId,
    "after-rollover",
  );
});

test("archive listing is bounded and reports incomplete discovery explicitly", async (t) => {
  const { archives, file } = await fixture(t);
  await mkdir(archives);
  await Promise.all(
    Array.from({ length: 130 }, (_, index) =>
      writeFile(
        join(
          archives,
          `events.20261017T003000123Z-${index.toString(16).padStart(8, "0")}.jsonl`,
        ),
        "",
        { mode: 0o600 },
      ),
    ),
  );
  const listing = await new BackendLogStore(file).listLogArchives();
  assert.equal(listing.archives.length, 128);
  assert.equal(listing.truncated, true);
  assert.match(listing.warnings.join(" "), /not a complete archive inventory/);
});
