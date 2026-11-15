import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  archiveCapture,
  pruneArchives,
  retentionPolicy,
  RotatingJsonlWriter,
} from "./log-retention.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "log-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "events.jsonl");
}
test("policy bounds reject invalid settings", () => {
  assert.equal(retentionPolicy({}).maxBytes, 50 * 1024 * 1024);
  for (const value of ["0", "-1", "NaN", "1.2", "99999999999"])
    assert.throws(() => retentionPolicy({ LOCAL_LOG_MAX_BYTES: value }));
});
test("owner rotation preserves complete records in private archives and continues writing", async (t) => {
  const file = await fixture(t);
  const writer = await new RotatingJsonlWriter(file, {
    maxBytes: 12,
    maxArchives: 7,
    maxAgeMs: 86400000,
    rotateAfterMs: 86400000,
  }).open();
  await writer.write('{"n":1}\n');
  await writer.write('{"n":2}\n');
  await writer.close();
  const names = (await readdir(join(file, "../archives"))).filter((n) =>
    n.endsWith(".jsonl"),
  );
  assert.equal(names.length, 1);
  assert.match(names[0], /^events\.\d{8}T\d{9}Z-[a-f0-9]{8}\.jsonl$/);
  assert.equal(
    await readFile(join(file, "../archives", names[0]), "utf8"),
    '{"n":1}\n',
  );
  assert.equal(await readFile(file, "utf8"), '{"n":2}\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test("retention removes only old owned archives and never the active file or other artifacts", async (t) => {
  const file = await fixture(t);
  await writeFile(file, "old\n");
  const old = await archiveCapture(file, new Date("2020-01-01T00:00:00Z"));
  await writeFile(file, "recent\n");
  const recent = await archiveCapture(file, new Date("2026-10-17T00:00:00Z"));
  const unrelated = join(file, "../archives", "private.json");
  await writeFile(unrelated, "preserve");
  assert.equal(
    await pruneArchives(
      file,
      { maxArchives: 1, maxAgeMs: 86400000 },
      Date.parse("2026-10-17T01:00:00Z"),
    ),
    1,
  );
  await assert.rejects(readFile(old));
  assert.equal(await readFile(recent, "utf8"), "recent\n");
  assert.equal(await readFile(unrelated, "utf8"), "preserve");
  assert.equal(await readFile(file, "utf8"), "");
});
test("linked archive directories and linked active captures are refused without deletion", async (t) => {
  const file = await fixture(t);
  await writeFile(file, "preserved\n");
  await symlink(join(file, ".."), join(file, "../archives"));
  await assert.rejects(archiveCapture(file));
  assert.equal(await readFile(file, "utf8"), "preserved\n");
});

test("an offline collector cannot make producers delete an unread backlog", async (t) => {
  const file = await fixture(t);
  const writer = await new RotatingJsonlWriter(file, {
    maxBytes: 1,
    maxArchives: 1,
    maxAgeMs: 1,
    rotateAfterMs: 86400000,
  }).open();
  await writer.write("one\n");
  await writer.write("two\n");
  await writer.write("three\n");
  await assert.rejects(writer.write("four\n"), /backlog/);
  await writer.close();
  const names = (await readdir(join(file, "../archives"))).filter((n) =>
    n.endsWith(".jsonl"),
  );
  const data = await Promise.all(
    names.map((n) => readFile(join(file, "../archives", n), "utf8")),
  );
  assert.deepEqual(data.sort(), ["one\n", "two\n"]);
  assert.equal(await readFile(file, "utf8"), "three\n");
});

test("a partial failed append closes its handle and fences the lost prefix before a later valid JSONL record", async (t) => {
  const file = await fixture(t);
  const writer = await new RotatingJsonlWriter(file).open();
  await writer.write('{"before":true}\n');
  const append = writer.handle.writeFile.bind(writer.handle);
  writer.handle.writeFile = async () => {
    await append('{"torn":');
    throw Object.assign(new Error("private filesystem detail"), {
      code: "ENOSPC",
    });
  };
  await assert.rejects(writer.write('{"important":true}\n'), (error) => {
    assert.equal(error.logWriteOutcome, "uncertain");
    assert.equal(error.logBytesWritten, 8);
    assert.equal(error.code, "ENOSPC");
    assert.doesNotMatch(String(error), /private filesystem|torn/);
    return true;
  });
  assert.equal(writer.handle, undefined);
  await writer.write('{"important":true}\n');
  await writer.close();
  assert.deepEqual((await readFile(file, "utf8")).trim().split("\n"), [
    '{"before":true}',
    '{"torn":',
    '{"important":true}',
  ]);
});

test("a known zero-byte append failure reports a safe retry outcome and can recover without another producer", async (t) => {
  const file = await fixture(t);
  const writer = await new RotatingJsonlWriter(file).open();
  writer.handle.writeFile = async () => {
    throw Object.assign(new Error("private disk detail"), { code: "EIO" });
  };
  await assert.rejects(writer.write('{"important":true}\n'), (error) => {
    assert.equal(error.logWriteOutcome, "not_written");
    assert.equal(error.logBytesWritten, 0);
    return true;
  });
  await writer.write('{"important":true}\n');
  await writer.close();
  assert.equal((await readFile(file, "utf8")).trim(), '{"important":true}');
});
