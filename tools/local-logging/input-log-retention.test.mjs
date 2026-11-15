import assert from "node:assert/strict";
import {
  link,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  crc64Ecma182,
  InputLogRetentionError,
  parseVectorCheckpoints,
  pruneConsumedInputArchives,
} from "./input-log-retention.mjs";

const now = Date.parse("2026-10-17T01:00:00.000Z");
const policy = { maxArchives: 1, maxAgeMs: 86400000 };
async function fixture(t) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "input-log-retention-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "inputs");
  const archives = join(directory, "archives");
  const state = join(root, "state", "flutter");
  await mkdir(archives, { recursive: true, mode: 0o700 });
  await mkdir(state, { recursive: true, mode: 0o700 });
  return {
    root,
    directory,
    archives,
    file: join(directory, "flutter.jsonl"),
    checkpoint: join(state, "checkpoints.json"),
  };
}
function archiveName(stamp, index = 0) {
  return `flutter.${stamp}-${index.toString(16).padStart(8, "0")}.jsonl`;
}
function fingerprint(text) {
  const bytes = Buffer.from(text);
  const end = bytes.indexOf(10);
  return crc64Ecma182(
    end >= 0 ? bytes.subarray(0, end + 1) : bytes.subarray(0, 1024 * 1024),
  );
}
async function checkpoints(path, entries) {
  // Vector stores u64 values as JSON numbers, not IEEE-754-safe quoted strings.
  const encoded = entries.map(
    ([checksum, position]) =>
      `{"fingerprint":{"first_lines_checksum":${checksum}},"position":${position}}`,
  );
  await writeFile(
    path,
    `{"version":"1","checkpoints":[${encoded.join(",")}]}`,
    { mode: 0o600 },
  );
}
async function present(path) {
  return !!(await lstat(path).catch(() => null));
}

test("CRC64 matches the ECMA-182 published check value and preserves 64-bit numeric checkpoints", () => {
  assert.equal(
    BigInt(crc64Ecma182(Buffer.from("123456789"))).toString(16),
    "6c40df5f0b497347",
  );
  const map = parseVectorCheckpoints(
    '{"version":"1","checkpoints":[{"fingerprint":{"first_lines_checksum":18446744073709551615},"position":97},{"fingerprint":{"first_lines_checksum":18446744073709551614},"position":98}]}',
  );
  assert.equal(map.get("18446744073709551615"), 97);
  assert.equal(map.get("18446744073709551614"), 98);
  assert.equal(map.size, 2);
  assert.equal(
    parseVectorCheckpoints(
      '{"version":"1","checkpoints":[{"fingerprint":{"first_line_checksum":9840103131050179868},"position":42}]}',
    ).get("9840103131050179868"),
    42,
  );
});

test("duplicate, invalid and out-of-range checkpoint entries cannot grant deletion authority", () => {
  const map = parseVectorCheckpoints(
    '{"version":"1","checkpoints":[{"fingerprint":{"first_lines_checksum":10},"position":7},{"fingerprint":{"first_lines_checksum":10},"position":99},{"fingerprint":{"first_lines_checksum":18446744073709551616},"position":99},{"fingerprint":{"first_lines_checksum":11},"position":9007199254740992},{"fingerprint":{"first_lines_checksum":12},"position":-1}]}',
  );
  assert.deepEqual([...map], [["10", 7]]);
  assert.throws(() =>
    parseVectorCheckpoints('{"version":"2","checkpoints":[]}'),
  );
});

test("age expiry only removes EOF-acknowledged inputs; unread archives and unrelated files stay intact", async (t) => {
  const { file, archives, checkpoint } = await fixture(t);
  const consumed = '{"id":"consumed"}\n{"last":true}\n';
  const unread = '{"id":"unread"}\n{"last":true}\n';
  const recent = '{"id":"recent"}\n';
  const oldPath = join(archives, archiveName("20261014T000000000Z"));
  const unreadPath = join(archives, archiveName("20261013T000000000Z"));
  const recentPath = join(archives, archiveName("20261017T000000000Z"));
  await writeFile(oldPath, consumed, { mode: 0o600 });
  await writeFile(unreadPath, unread, { mode: 0o600 });
  await writeFile(recentPath, recent, { mode: 0o600 });
  await writeFile(file, '{"id":"active"}\n', { mode: 0o600 });
  await writeFile(join(archives, "private.jsonl"), "preserve", { mode: 0o600 });
  await checkpoints(checkpoint, [
    [fingerprint(consumed), Buffer.byteLength(consumed)],
    [fingerprint(unread), Buffer.byteLength(unread) - 1],
    [fingerprint(recent), Buffer.byteLength(recent)],
  ]);
  const result = await pruneConsumedInputArchives(
    file,
    checkpoint,
    policy,
    now,
  );
  assert.equal(result.removedArchives, 1);
  assert.equal(result.removedBytes, Buffer.byteLength(consumed));
  assert.equal(result.unconsumedArchives, 1);
  assert.equal(result.retainedArchives, 2);
  assert.equal(result.checkpointAvailable, true);
  assert.equal(await present(oldPath), false);
  assert.equal(await readFile(unreadPath, "utf8"), unread);
  assert.equal(await readFile(recentPath, "utf8"), recent);
  assert.equal(
    await readFile(join(archives, "private.jsonl"), "utf8"),
    "preserve",
  );
});

test("archive count applies only after exact checksum/EOF verification", async (t) => {
  const { file, archives, checkpoint } = await fixture(t);
  const old = "older first line\nsecond\n";
  const newer = "newer first line\n";
  const oldPath = join(archives, archiveName("20261017T000000000Z"));
  const newPath = join(archives, archiveName("20261017T003000000Z"));
  await writeFile(oldPath, old);
  await writeFile(newPath, newer);
  await checkpoints(checkpoint, [[fingerprint(old), Buffer.byteLength(old)]]);
  const result = await pruneConsumedInputArchives(
    file,
    checkpoint,
    policy,
    now,
  );
  assert.equal(result.removedArchives, 1);
  assert.equal(result.unconsumedArchives, 1);
  assert.equal(await present(oldPath), false);
  assert.equal(await readFile(newPath, "utf8"), newer);
});

test("first-line fingerprint includes the newline and a checkpoint for a different prefix never authorizes pruning", async (t) => {
  const { file, archives, checkpoint } = await fixture(t);
  const text = "first line\nrest\n";
  const path = join(archives, archiveName("20261010T000000000Z"));
  await writeFile(path, text);
  await checkpoints(checkpoint, [
    [crc64Ecma182(Buffer.from("first line")), Buffer.byteLength(text)],
  ]);
  assert.equal(
    (await pruneConsumedInputArchives(file, checkpoint, policy, now))
      .removedArchives,
    0,
  );
  await checkpoints(checkpoint, [
    [crc64Ecma182(Buffer.from("first line\n")), Buffer.byteLength(text)],
  ]);
  assert.equal(
    (await pruneConsumedInputArchives(file, checkpoint, policy, now))
      .removedArchives,
    1,
  );
});

test("missing, malformed or unsupported checkpoint files preserve all inputs without creating files", async (t) => {
  const { file, archives, checkpoint } = await fixture(t);
  const path = join(archives, archiveName("20261010T000000000Z"));
  await writeFile(path, "unread\n");
  assert.equal(
    (await pruneConsumedInputArchives(file, checkpoint, policy, now))
      .checkpointAvailable,
    false,
  );
  assert.equal(await present(checkpoint), false);
  for (const contents of [
    "not-json",
    '{"version":"2","checkpoints":[]}',
    '{"version":"1","checkpoints":{}}',
  ]) {
    await writeFile(checkpoint, contents);
    const result = await pruneConsumedInputArchives(
      file,
      checkpoint,
      policy,
      now,
    );
    assert.equal(result.removedArchives, 0);
    assert.equal(result.checkpointAvailable, false);
    assert.equal(await readFile(path, "utf8"), "unread\n");
  }
});

test("linked checkpoint files and parent directories are refused without touching archives", async (t) => {
  const { root, file, archives, checkpoint } = await fixture(t);
  const path = join(archives, archiveName("20261010T000000000Z"));
  const text = "preserve\n";
  await writeFile(path, text);
  const target = join(root, "checkpoint-target.json");
  await checkpoints(target, [[fingerprint(text), Buffer.byteLength(text)]]);
  await symlink(target, checkpoint);
  await assert.rejects(
    pruneConsumedInputArchives(file, checkpoint, policy, now),
    InputLogRetentionError,
  );
  await rm(checkpoint);
  await link(target, checkpoint);
  await assert.rejects(
    pruneConsumedInputArchives(file, checkpoint, policy, now),
    InputLogRetentionError,
  );
  assert.equal(await readFile(path, "utf8"), text);
});

for (const replacementTiming of [
  "before descriptor stat",
  "after descriptor stat",
  "during stable snapshot",
])
  test(`a safe atomic checkpoint replacement ${replacementTiming} defers pruning and recovers`, async (t) => {
    const { file, archives, checkpoint } = await fixture(t);
    const consumed = "consumed first line\n";
    const unread = "unread first line\n";
    const consumedPath = join(archives, archiveName("20261010T000000000Z"));
    const unreadPath = join(archives, archiveName("20261011T000000000Z"));
    await writeFile(consumedPath, consumed, { mode: 0o600 });
    await writeFile(unreadPath, unread, { mode: 0o600 });
    await checkpoints(checkpoint, []);
    const replacement = checkpoint + ".new";
    await checkpoints(replacement, [
      [fingerprint(consumed), Buffer.byteLength(consumed)],
    ]);
    const originalIdentity = await lstat(checkpoint);
    const probe = await open(checkpoint, "r");
    t.after(() => probe.close());
    const prototype = Object.getPrototypeOf(probe);
    const originalStat = prototype.stat;
    let replaced = false;
    let observedUnlinked = false;
    let checkpointStats = 0;
    const mocked = t.mock.method(prototype, "stat", async function (...args) {
      const info = await originalStat.apply(this, args);
      const checkpointHandle =
        this !== probe && info.ino === originalIdentity.ino;
      if (checkpointHandle) checkpointStats++;
      const replacementPoint =
        replacementTiming === "during stable snapshot" ? 2 : 1;
      if (
        !replaced &&
        checkpointHandle &&
        checkpointStats === replacementPoint
      ) {
        replaced = true;
        // Deterministically reproduce Vector's rename between open and identity
        // validation, without a timing-dependent write loop or unsafe link.
        await rename(replacement, checkpoint);
        if (replacementTiming !== "after descriptor stat") {
          const unlinked = await originalStat.apply(this, args);
          observedUnlinked = unlinked.nlink === 0;
          return unlinked;
        }
      }
      return info;
    });
    const result = await pruneConsumedInputArchives(
      file,
      checkpoint,
      policy,
      now,
    );
    mocked.mock.restore();
    assert.equal(replaced, true);
    if (replacementTiming !== "after descriptor stat")
      assert.equal(observedUnlinked, true);
    assert.equal(result.checkpointAvailable, false);
    assert.equal(result.removedArchives, 0);
    assert.equal(result.unconsumedArchives, 2);
    assert.match(result.warnings.join(" "), /checkpoints are unavailable/);
    assert.equal(await readFile(consumedPath, "utf8"), consumed);
    assert.equal(await readFile(unreadPath, "utf8"), unread);
    const recovered = await pruneConsumedInputArchives(
      file,
      checkpoint,
      policy,
      now,
    );
    assert.equal(recovered.checkpointAvailable, true);
    assert.equal(recovered.removedArchives, 1);
    assert.equal(await readFile(unreadPath, "utf8"), unread);
  });

test("writable checkpoint and archive files stay unsafe rather than transient snapshots", async (t) => {
  const { file, archives, checkpoint } = await fixture(t);
  const path = join(archives, archiveName("20261010T000000000Z"));
  await writeFile(path, "preserve\n", { mode: 0o600 });
  await checkpoints(checkpoint, [[fingerprint("preserve\n"), 9]]);
  await chmod(checkpoint, 0o666);
  await assert.rejects(
    pruneConsumedInputArchives(file, checkpoint, policy, now),
    { code: "UNSAFE_INPUT_LOG_FILES" },
  );
  await chmod(checkpoint, 0o600);
  await chmod(path, 0o666);
  const result = await pruneConsumedInputArchives(
    file,
    checkpoint,
    policy,
    now,
  );
  assert.equal(result.unsafeArchives, 1);
  assert.equal(result.removedArchives, 0);
  assert.equal(await readFile(path, "utf8"), "preserve\n");
});

test("unsafe archive leaves are excluded and preserved; linked archive directories cannot be traversed", async (t) => {
  const { root, file, archives, checkpoint } = await fixture(t);
  const target = join(root, "private.jsonl");
  await writeFile(target, "private\n");
  await checkpoints(checkpoint, [[fingerprint("private\n"), 8]]);
  await symlink(target, join(archives, archiveName("20261010T000000000Z")));
  await link(target, join(archives, archiveName("20261011T000000000Z")));
  const result = await pruneConsumedInputArchives(
    file,
    checkpoint,
    policy,
    now,
  );
  assert.equal(result.unsafeArchives, 2);
  assert.equal(result.removedArchives, 0);
  assert.equal(await readFile(target, "utf8"), "private\n");
  await rm(archives, { recursive: true });
  await symlink(root, archives);
  await assert.rejects(
    pruneConsumedInputArchives(file, checkpoint, policy, now),
    InputLogRetentionError,
  );
});

test("identical first-line identities across files are ambiguous and remain even with a full checkpoint", async (t) => {
  const { file, archives, checkpoint } = await fixture(t);
  const text = "same first\narchive content\n";
  const path = join(archives, archiveName("20261010T000000000Z"));
  await writeFile(path, text);
  await writeFile(file, "same first\nactive content longer than archive\n");
  await checkpoints(checkpoint, [[fingerprint(text), 1000]]);
  const result = await pruneConsumedInputArchives(
    file,
    checkpoint,
    policy,
    now,
  );
  assert.equal(result.ambiguousArchives, 1);
  assert.equal(result.removedArchives, 0);
  assert.equal(await readFile(path, "utf8"), text);
});

test("short unterminated first lines and invalid archive dates are preserved", async (t) => {
  const { file, archives, checkpoint } = await fixture(t);
  const path = join(archives, archiveName("20261010T000000000Z"));
  const invalidDatePath = join(archives, archiveName("20261399T000000000Z"));
  await writeFile(path, "incomplete");
  await writeFile(invalidDatePath, "preserve\n");
  await checkpoints(checkpoint, [
    [crc64Ecma182(Buffer.from("incomplete")), 1000],
    [fingerprint("preserve\n"), 1000],
  ]);
  const result = await pruneConsumedInputArchives(
    file,
    checkpoint,
    policy,
    now,
  );
  assert.equal(result.unconsumedArchives, 1);
  assert.equal(result.removedArchives, 0);
  assert.equal(await readFile(invalidDatePath, "utf8"), "preserve\n");
});

test("the pinned one-MiB fingerprint prefix is bounded even when the first line is longer", async (t) => {
  const { file, archives, checkpoint } = await fixture(t);
  const prefix = Buffer.alloc(1024 * 1024, 97);
  const text = Buffer.concat([
    prefix,
    Buffer.from("beyond the fingerprint limit\n"),
  ]);
  const path = join(archives, archiveName("20261010T000000000Z"));
  await writeFile(path, text);
  await checkpoints(checkpoint, [[crc64Ecma182(prefix), text.length]]);
  const result = await pruneConsumedInputArchives(
    file,
    checkpoint,
    policy,
    now,
  );
  assert.equal(result.removedArchives, 1);
  assert.equal(result.removedBytes, text.length);
});

test("a linked input ancestor cannot redirect pruning into an unrelated directory", async (t) => {
  const { root, directory, file, checkpoint } = await fixture(t);
  const foreign = join(root, "foreign");
  await mkdir(join(foreign, "archives"), { recursive: true });
  const path = join(foreign, "archives", archiveName("20261010T000000000Z"));
  await writeFile(path, "foreign preserve\n");
  await checkpoints(checkpoint, [[fingerprint("foreign preserve\n"), 1000]]);
  await rm(directory, { recursive: true });
  await symlink(foreign, directory);
  await assert.rejects(
    pruneConsumedInputArchives(file, checkpoint, policy, now),
    InputLogRetentionError,
  );
  assert.equal(await readFile(path, "utf8"), "foreign preserve\n");
});
