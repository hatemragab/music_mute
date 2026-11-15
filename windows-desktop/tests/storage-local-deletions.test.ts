import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:path", async (original) => {
  const actual = await original<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((part) => part.replaceAll("\\", "/"))),
    },
  };
});
import { storageFixture } from "./storage-fixtures.js";
import { WindowsLocalDeletionJournal } from "../src/main/storage/local-deletions.js";
import { emptyPartition } from "../src/main/library/store.js";
import { parsePersonalPair } from "../src/main/reuse/pair.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const hash = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  const jobId = randomUUID(),
    directory = await f.host.directory(`personal\\results\\${jobId}`),
    raw = {
      version: 1,
      jobId,
      original: {
        id: randomUUID(),
        kind: "original",
        name: "original.wav",
        filename: "original.wav",
        bytes: 3,
        sha256: hash("raw"),
        durationSeconds: 60,
        contentType: "audio/wav",
      },
      vocals: {
        id: randomUUID(),
        kind: "vocals",
        name: "vocals.mp3",
        filename: "vocals.mp3",
        bytes: 3,
        sha256: hash("vox"),
        durationSeconds: 60,
        contentType: "audio/mpeg",
      },
    };
  await writeFile(join(directory, "pair.json"), JSON.stringify(raw));
  await writeFile(join(directory, "original.wav"), "raw");
  await writeFile(join(directory, "vocals.mp3"), "vox");
  const pair = parsePersonalPair(raw, f.host.report.installationId, jobId),
    guest = emptyPartition(null);
  guest.entries.push(pair.entry);
  const journal = new WindowsLocalDeletionJournal(f.host, f.processIdentity),
    begin = () =>
      f.pins.exclusiveUnpinned([], () =>
        journal.beginOwned(jobId, raw.original.sha256, raw.vocals.sha256),
      );
  return { ...f, jobId, directory, guest, journal, begin };
}
function path(root: string, relative: string) {
  return join(root, relative.replaceAll("\\", "/"));
}
it("restores exact renamed pair when the durable catalog deletion never committed", async () => {
  const f = await fixture(),
    row = await f.begin();
  await rename(f.directory, path(f.root, f.journal.tombstone(row)));
  f.setAlive(false);
  const result = await f.pins.exclusiveUnpinned([], (guard) =>
    f.journal.recoverOwned(f.guest, guard, async () => {
      throw new Error("unexpected removal");
    }),
  );
  expect(result).toEqual({ restored: 1, removed: 0, deferred: 0 });
  expect(await readFile(join(f.directory, "vocals.mp3"), "utf8")).toBe("vox");
  expect(await f.journal.readOwned()).toEqual([]);
});
it("removes only exact tombstone after catalog deletion is durable", async () => {
  const f = await fixture(),
    row = await f.begin(),
    tombstone = f.journal.tombstone(row);
  await rename(f.directory, path(f.root, tombstone));
  f.guest.entries = [];
  f.setAlive(false);
  const removed = vi.fn(async (relative: string) => {
    expect(relative).toBe(tombstone);
    await rm(path(f.root, relative), { recursive: true });
  });
  await f.pins.exclusiveUnpinned([], (guard) =>
    f.journal.recoverOwned(f.guest, guard, removed),
  );
  expect(removed).toHaveBeenCalledOnce();
  await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.journal.readOwned()).toEqual([]);
});
it("active owner, consumer pin and open-file failure remain deferred", async () => {
  const f = await fixture(),
    row = await f.begin(),
    relative = f.journal.tombstone(row);
  await rename(f.directory, path(f.root, relative));
  f.guest.entries = [];
  const remove = vi.fn(async () => {
    throw Object.assign(new Error("open fixture"), { code: "EPERM" });
  });
  const recover = () =>
    f.pins.exclusiveUnpinned([], (guard) =>
      f.journal.recoverOwned(f.guest, guard, remove),
    );
  expect((await recover()).deferred).toBe(1);
  expect(remove).not.toHaveBeenCalled();
  await f.pins.exclusiveUnpinned([], () => f.journal.settleOwned(row));
  const pin = await f.pins.pinTree(relative, "outbox");
  expect((await recover()).deferred).toBe(1);
  expect(remove).not.toHaveBeenCalled();
  await pin.release();
  expect((await recover()).deferred).toBe(1);
  expect(await f.journal.readOwned()).toHaveLength(1);
});
it("conflicting canonical directory and changed pair bytes fail closed", async () => {
  const f = await fixture(),
    row = await f.begin(),
    relative = f.journal.tombstone(row);
  await rename(f.directory, path(f.root, relative));
  f.setAlive(false);
  await writeFile(path(f.root, `${relative}\\pair.json`), "changed");
  await expect(
    f.pins.exclusiveUnpinned([], (guard) =>
      f.journal.recoverOwned(f.guest, guard, async () => {}),
    ),
  ).rejects.toThrow("LIBRARY_DELETE_CHANGED");
  expect(await readFile(path(f.root, `${relative}\\vocals.mp3`), "utf8")).toBe(
    "vox",
  );
});
it("repeated recovery is idempotent and never touches user source/export files", async () => {
  const f = await fixture(),
    row = await f.begin(),
    source = join(f.root, "user-source.wav");
  await writeFile(source, "user original");
  await rename(f.directory, path(f.root, f.journal.tombstone(row)));
  f.setAlive(false);
  for (let i = 0; i < 2; i++)
    await f.pins.exclusiveUnpinned([], (guard) =>
      f.journal.recoverOwned(f.guest, guard, async () => {
        throw new Error("unexpected");
      }),
    );
  expect(await readFile(source, "utf8")).toBe("user original");
  expect(await readFile(join(f.directory, "original.wav"), "utf8")).toBe("raw");
});
