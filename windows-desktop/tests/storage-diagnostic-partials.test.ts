import { randomUUID } from "node:crypto";
import { lstat, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:path", async (original) => {
  const actual = await original<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((p) => p.replaceAll("\\", "/"))),
    },
  };
});
import { storageFixture } from "./storage-fixtures.js";
import { storageBirth } from "../src/main/storage/write-journal.js";
import {
  partialWriteTarget,
  assertPartialCanonical,
} from "../src/main/storage/partial-write-policy.js";
import { WindowsStorageInventory } from "../src/main/storage/inventory.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const f = await storageFixture();
  Object.assign(f.native, { vaultRead: vi.fn(async () => null) });
  roots.push(f.root);
  return f;
}
const canonical = () => `diagnostics\\reports\\${randomUUID()}.json`;
it("accepts only fixed report UUID temporary slots with an independent 2 MiB/4-file bound", async () => {
  const f = await fixture();
  const name = canonical();
  expect(partialWriteTarget(`${name}.${randomUUID()}.tmp`)).toEqual({
    canonical: name,
    kind: "diagnostic-report",
    maxBytes: 2 * 1024 ** 2,
  });
  expect(() => assertPartialCanonical(name)).not.toThrow();
  for (const invalid of [
    `${name}.${randomUUID()}.part`,
    `diagnostics\\reports\\secret.json.${randomUUID()}.tmp`,
    `${name}\\child.tmp`,
    `logs\\${randomUUID()}.json.${randomUUID()}.tmp`,
  ])
    expect(partialWriteTarget(invalid)).toBeUndefined();
  await expect(
    f.controller.beginPartialWrite(
      `${name}.${randomUUID()}.tmp`,
      2 * 1024 ** 2 + 1,
    ),
  ).rejects.toThrow("STORAGE_WRITE_INVALID");
  for (let i = 0; i < 4; i++)
    await f.controller.beginPartialWrite(
      `${canonical()}.${randomUUID()}.tmp`,
      2 * 1024 ** 2,
    );
  await expect(
    f.controller.beginPartialWrite(`${canonical()}.${randomUUID()}.tmp`, 1),
  ).rejects.toThrow("STORAGE_WRITE_LIMIT");
  await expect(
    f.controller.beginPartialWrite(
      `outbox\\${"a".repeat(64)}\\${randomUUID()}\\vocals.mp3.${randomUUID()}.part`,
      100000000,
    ),
  ).resolves.toBeDefined();
});
it("counts report bytes once and recovers only settled exact temporary births while preserving canonical data", async () => {
  const f = await fixture(),
    name = canonical(),
    relative = `${name}.${randomUUID()}.tmp`,
    lease = await f.controller.beginPartialWrite(relative, 16),
    physical = (p: string) => join(f.root, p.replaceAll("\\", "/"));
  await f.host.directory("diagnostics\\reports");
  await writeFile(physical(relative), "temporary");
  await lease.captureCreated(
    storageBirth(await lstat(physical(relative), { bigint: true })),
  );
  await writeFile(physical(name), "canonical");
  const inventory = new WindowsStorageInventory(
      f.host,
      f.treeExited,
      undefined,
      f.controller.writes,
    ),
    items = await inventory.scan(new AbortController().signal);
  const report = items.find(
    (item) => item.relativePath === "diagnostics\\reports",
  );
  expect(report?.bytes).toBe(18);
  expect(
    items.filter((item) => item.relativePath.startsWith("diagnostics\\")),
  ).toHaveLength(1);
  expect(report?.eligible).toBe(false);
  await expect(
    f.controller.recoverPartialWrites(name, new AbortController().signal),
  ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  await lease.settle();
  await f.controller.recoverPartialWrites(name, new AbortController().signal);
  expect(await readFile(physical(name), "utf8")).toBe("canonical");
  await expect(lstat(physical(relative))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("does not reclaim a substituted report temporary after an actual writer's birth disappears", async () => {
  const f = await fixture(),
    name = canonical(),
    relative = `${name}.${randomUUID()}.tmp`,
    lease = await f.controller.beginPartialWrite(relative, 16),
    path = join(f.root, relative.replaceAll("\\", "/"));
  await f.host.directory("diagnostics\\reports");
  await writeFile(path, "original");
  await lease.captureCreated(storageBirth(await lstat(path, { bigint: true })));
  await unlink(path);
  await writeFile(path, "substitute");
  f.setAlive(false);
  await expect(
    f.controller.recoverPartialWrites(name, new AbortController().signal),
  ).rejects.toThrow("STORAGE_WRITE_CHANGED");
  expect(await readFile(path, "utf8")).toBe("substitute");
});
