import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicHistoryStore } from "../src/main/history/store.js";
import {
  decodeHistory,
  emptyHistory,
  encodeHistory,
  parseHistoryRecord,
} from "../src/main/history/model.js";
import { historyFixture, song } from "./history-fixtures.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
function stored(f: ReturnType<typeof historyFixture>) {
  const record = emptyHistory(f.scope());
  record.revision = 1;
  record.entries.push({
    aliases: [song.id],
    count: 1,
    lastListenedAt: "2026-10-09T00:00:00.000Z",
    listenedSeconds: 0,
    lastPosition: 0,
  });
  record.receipts.push({ sessionId: randomUUID(), trackId: song.id });
  return record;
}
describe("bounded history persistence and schema", () => {
  it("roundtrips an atomic real-filesystem fixture across reopened store instances", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "musicmute-history-fixture-"),
    );
    directories.push(directory);
    const files = {
        read: async (path: string) => {
          try {
            return await readFile(join(directory, path.replaceAll("\\", "_")));
          } catch (e) {
            if (
              e &&
              typeof e === "object" &&
              "code" in e &&
              e.code === "ENOENT"
            )
              return null;
            throw e;
          }
        },
        write: async (path: string, bytes: Buffer) => {
          const target = join(directory, path.replaceAll("\\", "_")),
            temporary = `${target}.${randomUUID()}.tmp`;
          await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
          await rename(temporary, target);
        },
      },
      f = historyFixture(),
      record = stored(f);
    await new AtomicHistoryStore(files).write(f.scope(), record);
    expect(await new AtomicHistoryStore(files).read(f.scope())).toEqual({
      state: "ready",
      record,
      errorCode: null,
    });
  });
  it("leaves the previous primary intact if atomic replacement fails before commit", async () => {
    const f = historyFixture(),
      first = stored(f);
    await f.store.write(f.scope(), first);
    vi.mocked(f.files.write).mockRejectedValueOnce(
      new Error("ATOMIC_WRITE_FAILED"),
    );
    const next = structuredClone(first);
    next.revision++;
    next.entries[0]!.count++;
    await expect(f.store.write(f.scope(), next)).rejects.toThrow(
      "ATOMIC_WRITE_FAILED",
    );
    expect((await f.store.read(f.scope())).record).toEqual(first);
  });
  it("keeps a committed primary authoritative if the last-good copy fails", async () => {
    const f = historyFixture(),
      record = stored(f);
    vi.mocked(f.files.write).mockImplementation(async (path, bytes) => {
      if (path.endsWith("last-good.json")) throw new Error("BACKUP_FAILED");
      f.saved.set(path, bytes);
    });
    await f.store.write(f.scope(), record);
    expect((await f.store.read(f.scope())).record).toEqual(record);
  });
  it("rejects checksum mutation, cross-owner/device records and malformed count/alias values", () => {
    const f = historyFixture(),
      record = stored(f),
      bytes = encodeHistory(record);
    expect(() =>
      decodeHistory(
        Buffer.from(bytes.toString().replace('"count":1', '"count":2')),
        f.scope(),
      ),
    ).toThrow("HISTORY_CORRUPT");
    expect(() => decodeHistory(bytes, f.scope("different-owner"))).toThrow(
      "HISTORY_CORRUPT",
    );
    for (const patch of [
      { count: true },
      { count: 1.25 },
      { count: -1 },
      { aliases: [song.id, song.id] },
      { lastListenedAt: "2026-02-31T00:00:00.000Z" },
      { listenedSeconds: -1 },
      { lastPosition: Infinity },
    ])
      expect(() =>
        parseHistoryRecord(
          { ...record, entries: [{ ...record.entries[0], ...patch }] },
          f.scope(),
        ),
      ).toThrow("HISTORY_CORRUPT");
  });
  it("does not downgrade an unsupported schema to a previous backup or blank history", async () => {
    const f = historyFixture(),
      record = stored(f);
    await f.store.write(f.scope(), record);
    const future = { ...record, version: 2 },
      bytes = Buffer.from(
        JSON.stringify({
          checksum: createHash("sha256")
            .update(JSON.stringify(future))
            .digest("hex"),
          record: future,
        }),
      );
    f.saved.set(f.primary(), bytes);
    expect(await f.store.read(f.scope())).toEqual({
      state: "unsupported",
      record: null,
      errorCode: "HISTORY_VERSION_UNSUPPORTED",
    });
    expect(f.saved.get(f.primary())).toEqual(bytes);
    await expect(f.store.recover(f.scope())).rejects.toThrow(
      "HISTORY_RECOVERY_UNAVAILABLE",
    );
  });
  it("cannot complete Clear while old backup/recovery copies remain writable failures", async () => {
    const f = historyFixture(),
      record = stored(f);
    await f.store.write(f.scope(), record);
    vi.mocked(f.files.write).mockRejectedValueOnce(
      new Error("COPY_CLEAR_FAILED"),
    );
    await expect(f.store.clear(f.scope())).rejects.toThrow("COPY_CLEAR_FAILED");
    expect((await f.store.read(f.scope())).record).toEqual(record);
  });
  it("reports unavailable storage and preserves unknown corrupt bytes", async () => {
    const f = historyFixture();
    vi.mocked(f.files.read).mockRejectedValue(new Error("ACL_UNSAFE"));
    expect(await f.store.read(f.scope())).toEqual({
      state: "unavailable",
      record: null,
      errorCode: "HISTORY_STORAGE_UNAVAILABLE",
    });
    expect(f.files.write).not.toHaveBeenCalled();
  });
});
