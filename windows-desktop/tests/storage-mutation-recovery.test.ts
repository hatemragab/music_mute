import { randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((part) => part.replaceAll("\\", "/"))),
    },
  };
});

import { WindowsStorageController } from "../src/main/storage/controller.js";
import { sparseAccountVoice, storageFixture } from "./storage-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const f = await storageFixture(),
    onChanged = vi.fn(async () => {});
  roots.push(f.root);
  const controller = new WindowsStorageController({
    host: f.host,
    pins: f.pins,
    processIdentity: f.processIdentity,
    treeExited: f.treeExited,
    freeBytes: async () => 100 * 1024 ** 3,
    onChanged,
  });
  return { ...f, controller, onChanged };
}

const absolute = (root: string, relative: string) =>
  join(root, relative.replaceAll("\\", "/"));
const plannedVoice = () => `personal\\results\\${randomUUID()}.pending`;
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("storage mutation reconciliation over actual temporary files", () => {
  it("refuses an incoming reservation when native pending deletion leaves the actual cache over budget", async () => {
    const f = await fixture(),
      voices = [];
    for (let i = 1; i <= 11; i++) voices.push(await sparseAccountVoice(f, i));
    await f.controller.execute({
      type: "SET_BUDGET",
      budgetBytes: 1_000_000_000,
    });
    f.native.commitCacheDeletion.mockResolvedValue("pending");

    await expect(
      f.controller.reserveVoice(50_000_000, plannedVoice()),
    ).rejects.toThrow("OFFLINE_CACHE_FULL");

    expect(f.native.commitCacheDeletion).toHaveBeenCalled();
    expect(f.native.releaseCacheDeletion).not.toHaveBeenCalled();
    expect(f.onChanged).toHaveBeenCalledOnce();
    expect(f.controller.view()).toMatchObject({
      state: "error",
      errorCode: "OFFLINE_CACHE_FULL",
      reservedVoicesBytes: 0,
      overBudget: true,
      lastCleanup: null,
    });
    expect(f.controller.view().voicesBytes).toBeGreaterThan(1_000_000_000);
    expect(await exists(absolute(f.root, "storage\\reservations.json"))).toBe(
      false,
    );
    for (const voice of voices)
      expect(await exists(absolute(f.root, voice.relativePath))).toBe(true);
  });

  it.each(["cleanup", "admission"] as const)(
    "%s reconciles a real first deletion after a later native failure without retaining an old success result",
    async (mutation) => {
      const f = await fixture();
      await sparseAccountVoice(f, 100, 1_000);
      await f.controller.execute({
        type: "CLEANUP",
        target: "voices",
        confirmation: "clear-eligible-cache",
      });
      expect(f.controller.view().lastCleanup?.removedItems).toBe(1);
      const voices = [];
      for (let i = 1; i <= (mutation === "admission" ? 11 : 2); i++)
        voices.push(await sparseAccountVoice(f, i));
      await f.controller.execute({
        type: "SET_BUDGET",
        budgetBytes: 1_000_000_000,
      });
      const before = f.controller.view().voicesBytes,
        first = voices[0]!,
        second = voices[1]!,
        removedBytes =
          first.bytes +
          (await lstat(absolute(f.root, `${first.relative}\\media.json`))).size,
        failure = new Error("PRIVATE_RECEIVER_TOKEN"),
        commit = f.native.commitCacheDeletion.getMockImplementation()!;
      f.native.commitCacheDeletion.mockImplementation(async (candidate) => {
        if (candidate.relativePath === second.relativePath) throw failure;
        return commit(candidate);
      });
      let localAvailability: boolean[] | undefined;
      f.onChanged.mockClear();
      f.onChanged.mockImplementation(async () => {
        localAvailability = await Promise.all(
          [first, second].map((voice) =>
            exists(absolute(f.root, voice.relativePath)),
          ),
        );
      });

      const operation =
        mutation === "cleanup"
          ? f.controller.execute({
              type: "CLEANUP",
              target: "voices",
              confirmation: "clear-eligible-cache",
            })
          : f.controller.reserveVoice(50_000_000, plannedVoice());
      await expect(operation).rejects.toBe(failure);

      expect(f.onChanged).toHaveBeenCalledOnce();
      expect(localAvailability).toEqual([false, true]);
      expect(f.controller.view()).toMatchObject({
        state: "error",
        errorCode: "STORAGE_UNAVAILABLE",
        voicesBytes: before - removedBytes,
        reservedVoicesBytes: 0,
        lastCleanup: null,
      });
      expect(await exists(absolute(f.root, first.relative))).toBe(false);
      expect(await exists(absolute(f.root, second.relativePath))).toBe(true);
    },
  );

  it("rolls back only unissued capacity when the post-reservation Library callback fails", async () => {
    const f = await fixture(),
      existingPath = plannedVoice(),
      unissuedPath = plannedVoice(),
      existing = await f.controller.reserveVoice(1_000, existingPath),
      failure = new Error("PRIVATE_LIBRARY_TOKEN");
    let publishedReservations: { relativePath: string; bytes: number }[] = [];
    f.onChanged.mockClear();
    f.onChanged.mockImplementationOnce(async () => {
      publishedReservations = JSON.parse(
        await readFile(absolute(f.root, "storage\\reservations.json"), "utf8"),
      ).reservations;
      throw failure;
    });

    await expect(f.controller.reserveVoice(2_000, unissuedPath)).rejects.toBe(
      failure,
    );

    expect(publishedReservations.map((row) => row.relativePath)).toEqual([
      existingPath,
      unissuedPath,
    ]);
    const retained = JSON.parse(
      await readFile(absolute(f.root, "storage\\reservations.json"), "utf8"),
    ) as { reservations: { relativePath: string; bytes: number }[] };
    expect(retained.reservations).toHaveLength(1);
    expect(retained.reservations[0]).toMatchObject({
      relativePath: existingPath,
      bytes: 1_000,
    });
    expect(f.controller.view()).toMatchObject({
      state: "error",
      errorCode: "STORAGE_UNAVAILABLE",
      reservedVoicesBytes: 1_000,
      lastCleanup: null,
    });
    await existing.release();
    await f.controller.scan();
    expect(f.controller.view().reservedVoicesBytes).toBe(0);
  });
});
