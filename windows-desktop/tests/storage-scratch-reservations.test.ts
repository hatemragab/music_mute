import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
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
import {
  WindowsScratchReservations,
  CPU_SCRATCH_MAX_BYTES,
} from "../src/main/storage/scratch-reservations.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  return {
    ...f,
    reservations: new WindowsScratchReservations(
      f.host,
      f.processIdentity,
      f.treeExited,
    ),
  };
}
it("reserves incoming CPU bytes before files exist without charging the voices budget", async () => {
  const f = await fixture();
  await f.controller.reserveScratch(
    CPU_SCRATCH_MAX_BYTES,
    `cloud\\work\\${randomUUID()}`,
  );
  await expect(
    f.controller.reserveScratch(1, `cloud\\work\\${randomUUID()}`),
  ).rejects.toThrow("STORAGE_SCRATCH_FULL");
  expect(
    (await f.reservations.readOwned()).reduce((sum, row) => sum + row.bytes, 0),
  ).toBe(CPU_SCRATCH_MAX_BYTES);
  expect(f.controller.view().reservedVoicesBytes).toBe(0);
});
it("an unacknowledged Native handoff retains capacity even when parent Node and path are gone", async () => {
  const f = await fixture(),
    lease = await f.controller.reserveScratch(
      100,
      `cloud\\work\\${randomUUID()}`,
    );
  await lease.handoff();
  f.setAlive(false);
  f.setExited(true);
  await f.reservations.pruneOwned();
  expect(await f.reservations.readOwned()).toHaveLength(1);
  await expect(lease.release()).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  expect(await f.reservations.readOwned()).toHaveLength(1);
});
it("reclaims a missing Native workspace only after exact owned full-tree exit proof", async () => {
  const f = await fixture(),
    lease = await f.controller.reserveScratch(
      100,
      `cloud\\work\\${randomUUID()}`,
    ),
    owner = {
      role: "prepare" as const,
      nonce: "a".repeat(64),
      identity: f.parent,
    };
  await lease.handoff();
  await lease.bind(owner);
  f.setAlive(false);
  await f.reservations.pruneOwned();
  expect(await f.reservations.readOwned()).toHaveLength(1);
  f.setExited(true);
  await f.reservations.pruneOwned();
  expect(await f.reservations.readOwned()).toEqual([]);
});
it("refuses an unsafe root, foreign SID or insufficient actual free volume before copying", async () => {
  const f = await fixture();
  await expect(
    f.controller.reserveScratch(1, "models\\Kim_Vocal_2.onnx"),
  ).rejects.toThrow("STORAGE_SCRATCH_INVALID");
  f.setFree(3 * 1024 ** 3);
  await expect(
    f.controller.reserveScratch(1, `cloud\\work\\${randomUUID()}`),
  ).rejects.toThrow("DISK_SPACE_LOW");
});
