import { randomUUID } from "node:crypto";
import { lstat, readFile, rm, unlink, writeFile } from "node:fs/promises";
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
import { storageBirth } from "../src/main/storage/write-journal.js";
import { LibraryPins } from "../src/main/library/pins.js";
import { WindowsStorageController } from "../src/main/storage/controller.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  return f;
}
const canonical = (index = 1) =>
  `library\\thumbnails\\${index.toString(16).padStart(64, "0")}.image`;
const physical = (root: string, relative: string) =>
  join(root, relative.replaceAll("\\", "/"));
async function copied(
  f: Awaited<ReturnType<typeof fixture>>,
  name = canonical(),
) {
  const relative = `${name}.${randomUUID()}.tmp`,
    write = await f.controller.beginPartialWrite(relative, 16);
  await f.host.directory("library\\thumbnails");
  await writeFile(physical(f.root, relative), Buffer.from("temporary bytes"));
  await write.captureCreated(
    storageBirth(await lstat(physical(f.root, relative), { bigint: true })),
  );
  return { relative, write };
}
it("a lost native deletion reply resumes its certificate; a lost metadata ACK retries only that captured ACK", async () => {
  const f = await fixture(),
    first = await copied(f);
  await first.write.settle();
  const discard = f.native.discardStoragePartial.getMockImplementation()!;
  f.native.discardStoragePartial.mockImplementationOnce(async (id) => {
    await discard(id);
    throw new Error("HELPER_UNAVAILABLE");
  });
  await expect(
    f.controller.recoverPartialWrites(
      canonical(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("HELPER_UNAVAILABLE");
  expect((await f.controller.writes.readOwned()).length).toBe(1);
  await f.controller.recoverPartialWrites(
    canonical(),
    new AbortController().signal,
  );
  expect(f.native.discardStoragePartial).toHaveBeenCalledTimes(2);
  const second = await copied(f, canonical(2));
  await second.write.settle();
  f.native.acknowledgeStorageCleanup.mockRejectedValueOnce(
    new Error("ACK_LOST"),
  );
  await expect(
    f.controller.recoverPartialWrites(
      canonical(2),
      new AbortController().signal,
    ),
  ).rejects.toThrow("ACK_LOST");
  const calls = f.native.discardStoragePartial.mock.calls.length;
  await f.controller.recoverPartialWrites(
    canonical(2),
    new AbortController().signal,
  );
  expect(f.native.discardStoragePartial.mock.calls.length).toBe(calls);
  expect(await f.controller.writes.readOwned()).toEqual([]);
});
it("an absent native authority or pending receiver preserves copier bytes and the durable row", async () => {
  const f = await fixture(),
    first = await copied(f);
  await first.write.settle();
  f.native.discardStoragePartial.mockResolvedValueOnce({ state: "pending" });
  await expect(
    f.controller.recoverPartialWrites(
      canonical(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  expect(await readFile(physical(f.root, first.relative), "utf8")).toBe(
    "temporary bytes",
  );
  delete f.host.native.discardStoragePartial;
  await expect(
    f.controller.recoverPartialWrites(
      canonical(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  expect((await f.controller.writes.readOwned()).length).toBe(1);
});
it("one temporary per canonical slot blocks retry while a copier is live and recovers exact stopped bytes only", async () => {
  const f = await fixture(),
    first = await copied(f);
  await writeFile(physical(f.root, canonical()), "preserved canonical");
  await expect(
    f.controller.beginPartialWrite(`${canonical()}.${randomUUID()}.tmp`, 16),
  ).rejects.toThrow("STORAGE_WRITE_LIMIT");
  await expect(
    f.controller.recoverPartialWrites(
      canonical(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  expect(await readFile(physical(f.root, first.relative), "utf8")).toBe(
    "temporary bytes",
  );
  await first.write.settle();
  await f.controller.recoverPartialWrites(
    canonical(),
    new AbortController().signal,
  );
  await expect(lstat(physical(f.root, first.relative))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(physical(f.root, canonical()), "utf8")).toBe(
    "preserved canonical",
  );
  expect(await f.controller.writes.readOwned()).toEqual([]);
});
it("unbound and replaced temporary births never authorize deletion after writer death", async () => {
  const f = await fixture(),
    first = await copied(f);
  await unlink(physical(f.root, first.relative));
  await writeFile(physical(f.root, first.relative), "replaced file");
  f.setAlive(false);
  await expect(
    f.controller.recoverPartialWrites(
      canonical(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("STORAGE_WRITE_CHANGED");
  expect(await readFile(physical(f.root, first.relative), "utf8")).toBe(
    "replaced file",
  );
  f.setAlive(true);
  const name = canonical(2),
    relative = `${name}.${randomUUID()}.tmp`;
  await f.controller.beginPartialWrite(relative, 16);
  await writeFile(physical(f.root, relative), "no captured birth");
  f.setAlive(false);
  await expect(
    f.controller.recoverPartialWrites(name, new AbortController().signal),
  ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  expect(await readFile(physical(f.root, relative), "utf8")).toBe(
    "no captured birth",
  );
});
it("durable Outbox retention preserves canonical files while actual live consumers still block exact partial recovery", async () => {
  const f = await fixture(),
    root = `outbox\\${"a".repeat(64)}\\${randomUUID()}`,
    name = `${root}\\original.m4a`,
    relative = `${name}.${randomUUID()}.part`,
    pins = new LibraryPins(
      f.host,
      f.processIdentity,
      async () => new Set([root]),
    ),
    controller = new WindowsStorageController({
      host: f.host,
      pins,
      processIdentity: f.processIdentity,
      treeExited: f.treeExited,
      freeBytes: async () => 100 * 1024 ** 3,
    });
  await f.host.directory(root);
  const write = await controller.beginPartialWrite(relative, 16);
  await writeFile(physical(f.root, relative), "partial");
  await write.captureCreated(
    storageBirth(await lstat(physical(f.root, relative), { bigint: true })),
  );
  await write.settle();
  await writeFile(physical(f.root, name), "canonical");
  const pin = await pins.pinTree(root, "outbox");
  await expect(
    controller.recoverPartialWrites(name, new AbortController().signal),
  ).rejects.toThrow("LIBRARY_MEDIA_PINNED");
  await pin.release();
  await controller.recoverPartialWrites(name, new AbortController().signal);
  expect(await readFile(physical(f.root, name), "utf8")).toBe("canonical");
  await expect(
    pins.exclusivePartialWrites(async (guard) => guard(name)),
  ).rejects.toThrow("STORAGE_WRITE_INVALID");
});
it("thumbnail count and Outbox per-role byte reservations bound crash-left retries before creating files", async () => {
  const f = await fixture();
  for (let i = 0; i < 16; i++)
    await f.controller.beginPartialWrite(
      `${canonical(i)}.${randomUUID()}.tmp`,
      1024 ** 2,
    );
  await expect(
    f.controller.beginPartialWrite(`${canonical(17)}.${randomUUID()}.tmp`, 1),
  ).rejects.toThrow("STORAGE_WRITE_LIMIT");
  for (let i = 0; i < 2; i++)
    await f.controller.beginPartialWrite(
      `outbox\\${"b".repeat(64)}\\${randomUUID()}\\original.m4a.${randomUUID()}.part`,
      100000000,
    );
  await expect(
    f.controller.beginPartialWrite(
      `outbox\\${"b".repeat(64)}\\${randomUUID()}\\original.m4a.${randomUUID()}.part`,
      100000000,
    ),
  ).rejects.toThrow("STORAGE_WRITE_LIMIT");
  expect(await f.controller.writes.readOwned()).toHaveLength(18);
});
