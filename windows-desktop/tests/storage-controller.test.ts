import {
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
const faults = vi.hoisted(() => ({ blocked: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (String(path) === faults.blocked)
        throw Object.assign(new Error("open-file-code-fixture"), {
          code: "EPERM",
        });
      return actual.unlink(path);
    },
  };
});
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
import { storageFixture, sparseAccountVoice } from "./storage-fixtures.js";
import {
  WindowsStorageInventory,
  parseWorkspace,
} from "../src/main/storage/inventory.js";
import { WindowsStorageFiles } from "../src/main/storage/files.js";
import { durablePendingOriginalBytes } from "../src/main/library/retained-directories.js";
import { JournalOutboxStore } from "../src/main/outbox/store.js";
import {
  OUTBOX_ORIGINAL_BUDGET,
  stageOutbox,
} from "../src/main/outbox/model.js";
import { localEntry, outboxInstallation } from "./outbox-fixtures.js";
import { ownerA, ownerB } from "./realtime-fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  faults.blocked = null;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(pendingOriginalBytes?: () => Promise<number>) {
  const f = await storageFixture(pendingOriginalBytes);
  roots.push(f.root);
  return f;
}
function recoveredOutbox() {
  const records = [ownerA, ownerB, ownerB, ownerA].map((owner) =>
      stageOutbox(
        localEntry(),
        owner,
        outboxInstallation,
        randomUUID(),
        "pair",
        1,
      ),
    ),
    files = {
      list: vi.fn(async (): Promise<unknown[]> => records),
      write: vi.fn(async () => {}),
      locked: async <T>(operation: () => Promise<T>) => operation(),
    };
  records[0]!.original!.bytes = 100000000;
  records[1]!.original!.bytes = 100000000;
  records[1]!.state = "discarded";
  records[2]!.original!.bytes = OUTBOX_ORIGINAL_BUDGET - 200000000;
  records[3]!.original!.bytes = 100000000;
  records[3]!.state = "discarded";
  records[3]!.copiesReleased = true;
  return {
    records,
    files,
    store: new JournalOutboxStore(files, outboxInstallation),
  };
}
describe("Windows storage native-boundary/filesystem code fixtures", () => {
  it("keeps the engine session private/protected until actual exit and uses native exact-birth cleanup before marker retirement", async () => {
    const f = await fixture(),
      relative = `personal\\engine-session\\${randomUUID()}`;
    const owner = {
      role: "personal" as const,
      nonce: "a".repeat(64),
      identity: f.parent,
    };
    const directory = await f.host.directory(relative);
    await writeFile(
      join(directory, "engine-config.json"),
      "session-code-fixture",
    );
    const workspace = await f.controller.trackWorkspace(
      relative,
      owner,
      "processing",
    );
    f.host.native.inferenceIdle = vi.fn(async () => false);
    await expect(workspace.releaseExitedSessionProtection()).rejects.toThrow(
      "STORAGE_RECOVERY_PENDING",
    );
    await expect(
      f.controller.removeExitedSessionWorkspace(relative),
    ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
    expect(f.native.beginCacheDeletion).not.toHaveBeenCalled();
    f.host.native.inferenceIdle = vi.fn(async () => true);
    await workspace.releaseExitedSessionProtection();
    await f.controller.removeExitedSessionWorkspace(relative);
    expect(f.native.beginCacheDeletion).toHaveBeenCalledWith(
      `${relative}\\engine-config.json`,
      "file",
      expect.objectContaining({ bornAt: expect.any(String) }),
    );
    await workspace.release();
    expect(f.native.retireStorageWorkspaceMarker).toHaveBeenCalledWith(
      relative,
      owner,
    );
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("accepts only a personal processing owner for the fixed engine-session namespace", async () => {
    const f = await fixture(),
      row = {
        version: 1,
        relativePath: `personal\\engine-session\\${randomUUID()}`,
        owner: { role: "personal", nonce: "a".repeat(64), identity: f.parent },
        purpose: "processing",
        createdAt: 1,
      };
    expect(parseWorkspace(row, f.host.identity.sid).relativePath).toBe(
      row.relativePath,
    );
    expect(() =>
      parseWorkspace(
        { ...row, owner: { ...row.owner, role: "fleet" } },
        f.host.identity.sid,
      ),
    ).toThrow("STORAGE_WORKSPACE_INVALID");
    expect(() =>
      parseWorkspace({ ...row, purpose: "download" }, f.host.identity.sid),
    ).toThrow("STORAGE_WORKSPACE_INVALID");
  });

  it("uses native candidate/commit/ack and retains uncertainty on a lost disposal acknowledgement", async () => {
    const f = await fixture();
    await sparseAccountVoice(f, 1, 1000);
    f.native.commitCacheDeletion.mockRejectedValueOnce(
      new Error("HELPER_UNAVAILABLE"),
    );
    await expect(
      f.controller.execute({
        type: "CLEANUP",
        target: "voices",
        confirmation: "clear-eligible-cache",
      }),
    ).rejects.toThrow("HELPER_UNAVAILABLE");
    expect(f.native.beginCacheDeletion).toHaveBeenCalled();
    expect(f.native.releaseCacheDeletion).not.toHaveBeenCalled();
    expect(f.controller.view().lastCleanup).toBeNull();
  });
  it("rejects an exact candidate rebound before commit instead of deleting its replacement", async () => {
    const f = await fixture(),
      row = await sparseAccountVoice(f, 1, 1000),
      inventory = new WindowsStorageInventory(f.host, f.treeExited);
    const item = (
      await inventory.scan(new AbortController().signal, false)
    ).find((x) => x.category === "voices")!;
    await f.pins.exclusiveUnpinned([], async () => {
      const file = item.files[0]!,
        candidate = await f.native.beginCacheDeletion(
          file.relativePath,
          "file",
          { ...item.births![file.relativePath]!, ...file.fingerprint },
        );
      await writeFile(
        join(f.root, row.relativePath.replaceAll("\\", "/")),
        "replacement-code-fixture",
      );
      await expect(f.native.commitCacheDeletion(candidate)).rejects.toThrow(
        "PATH_UNSAFE",
      );
      expect(
        await readFile(
          join(f.root, row.relativePath.replaceAll("\\", "/")),
          "utf8",
        ),
      ).toBe("replacement-code-fixture");
    });
  });
  it("projects a bounded fixed code from an actual scan failure", async () => {
    const f = await fixture();
    f.native.acquireMutex.mockRejectedValueOnce(
      new Error("PRIVATE_ACCESS_TOKEN"),
    );
    await expect(f.controller.scan()).rejects.toThrow("PRIVATE_ACCESS_TOKEN");
    expect(f.controller.view().errorCode).toBe("STORAGE_UNAVAILABLE");
  });
  it("counts retained readiness/status/repair bytes without offering cache deletion", async () => {
    const f = await fixture();
    for (const relative of [
      "prepare\\readiness\\slot0",
      "prepare\\runtime-status\\slot1",
      "staging\\prepare-runtime-backup",
    ]) {
      const directory = await f.host.directory(relative);
      await writeFile(join(directory, "retained.bin"), "protected");
    }
    const staging = await f.host.directory("staging");
    await writeFile(
      join(staging, "prepare-runtime-backup.inventory.json"),
      "protected-inventory",
    );
    await f.controller.scan();
    expect(
      f.controller.view().categories.find((x) => x.category === "metadata")!
        .bytes,
    ).toBe(2 * 9 + 19);
    expect(
      f.controller.view().categories.find((x) => x.category === "rollback")!
        .bytes,
    ).toBe(9);
    await f.controller.execute({
      type: "CLEANUP",
      target: "all-eligible",
      confirmation: "clear-eligible-cache",
    });
    expect(f.native.beginCacheDeletion).not.toHaveBeenCalled();
    expect(
      await readFile(
        join(staging, "prepare-runtime-backup.inventory.json"),
        "utf8",
      ),
    ).toBe("protected-inventory");
  });
  it("changeswholeGB budget without deleting then admits byLRU includingreservedbytes", async () => {
    const f = await fixture();
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push(await sparseAccountVoice(f, i));
    await f.controller.execute({ type: "SET_BUDGET", budgetBytes: 1000000000 });
    expect(f.controller.view().overBudget).toBe(true);
    expect(
      await lstat(join(f.root, rows[0]!.relativePath.replaceAll("\\", "/"))),
    ).toBeDefined();
    const reserve = await f.controller.reserveVoice(
      50000000,
      `personal\\results\\${randomUUID()}.pending`,
    );
    for (const row of rows.slice(0, 3))
      await expect(
        lstat(join(f.root, row.relativePath.replaceAll("\\", "/"))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await lstat(join(f.root, rows[3]!.relativePath.replaceAll("\\", "/"))),
    ).toBeDefined();
    await f.controller.scan();
    expect(f.controller.view().reservedVoicesBytes).toBe(50000000);
    await reserve.release();
    await f.controller.scan();
    expect(f.controller.view().reservedVoicesBytes).toBe(0);
  });
  it("protectsactualconsumingprocesspins forplayback/export/outbox/processing/download/sync/update", async () => {
    const f = await fixture(),
      row = await sparseAccountVoice(f, 1, 1000);
    for (const purpose of [
      "playback",
      "export",
      "outbox",
      "processing",
      "download",
      "sync",
      "update",
      "share",
    ] as const) {
      const pin = await f.pins.pin(row, purpose);
      await f.controller.execute({
        type: "CLEANUP",
        target: "voices",
        confirmation: "clear-eligible-cache",
      });
      expect(
        await lstat(join(f.root, row.relativePath.replaceAll("\\", "/"))),
      ).toBeDefined();
      expect(await f.pins.hasLiveConsumers()).toBe(true);
      await pin.release();
    }
    expect(await f.pins.hasLiveConsumers()).toBe(false);
    await f.controller.execute({
      type: "CLEANUP",
      target: "voices",
      confirmation: "clear-eligible-cache",
    });
    await expect(
      lstat(join(f.root, row.relativePath.replaceAll("\\", "/"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.controller.view().lastCleanup?.removedItems).toBe(1);
    expect(f.controller.view().lastCleanup?.freedBytes).toBe(0);
  });
  it("excludesonlyexactownupdatepin and retainsotherconsumers", async () => {
    const f = await fixture();
    await f.host.directory("models");
    const update = await f.pins.pinTree("models", "update");
    expect(await f.pins.hasLiveConsumers(update.pinId)).toBe(false);
    const row = await sparseAccountVoice(f, 1, 1000),
      playback = await f.pins.pin(row);
    expect(await f.pins.hasLiveConsumers(update.pinId)).toBe(true);
    await playback.release();
    await update.release();
  });
  it("doesnotdeletecrashedscratchuntilnativewholeJobexitcertificateprovesit", async () => {
    const f = await fixture(),
      relative = `personal\\jobs\\${randomUUID()}`,
      directory = await f.host.directory(relative);
    await writeFile(join(directory, "owned-output.part"), "scratch");
    const pin = await f.controller.trackWorkspace(
      relative,
      {
        role: "personal",
        nonce: "a".repeat(64),
        identity: { ...f.parent, pid: 7777, creationTime: "7777" },
      },
      "processing",
    );
    await pin.release();
    await f.controller.execute({
      type: "CLEANUP",
      target: "scratch",
      confirmation: "clear-eligible-cache",
    });
    expect(await readFile(join(directory, "owned-output.part"), "utf8")).toBe(
      "scratch",
    );
    f.setExited(true);
    await f.controller.execute({
      type: "CLEANUP",
      target: "scratch",
      confirmation: "clear-eligible-cache",
    });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.treeExited).toHaveBeenCalled();
  });
  it("failsclosedonlowspaceandglobalpendingoriginal256MiBcapacity", async () => {
    const f = await fixture(),
      relative = `personal\\results\\${randomUUID()}.pending`;
    f.setFree(1);
    await expect(f.controller.reserveVoice(1000, relative)).rejects.toThrow(
      "DISK_SPACE_LOW",
    );
    f.setFree(100 * 1024 ** 3);
    f.setPending(256 * 1024 ** 2 + 1);
    await expect(f.controller.reserveVoice(1000, relative)).rejects.toThrow(
      "OUTBOX_FULL",
    );
    f.setPending(256 * 1024 ** 2);
    const reservation = await f.controller.reserveVoice(1000, relative);
    await reservation.release();
  });
  it("admits recovered all-owner originals at exactly 256 MiB without adding journal bytes to storage totals", async () => {
    const outbox = recoveredOutbox(),
      f = await fixture(() => durablePendingOriginalBytes(outbox.store)),
      row = await sparseAccountVoice(f, 1, 1000);
    await f.controller.scan();
    expect(f.controller.view().state).toBe("ready");
    const metadata = await lstat(
      join(f.root, row.relative.replaceAll("\\", "/"), "media.json"),
    );
    expect(f.controller.view().voicesBytes).toBe(row.bytes + metadata.size);
    expect(
      f.controller
        .view()
        .categories.find((category) => category.category === "outbox")?.bytes,
    ).toBe(0);
    const reservation = await f.controller.reserveVoice(
      1000,
      `personal\\results\\${randomUUID()}.pending`,
    );
    expect(f.controller.view().reservedVoicesBytes).toBe(1000);
    await reservation.release();
    expect(f.controller.view().reservedVoicesBytes).toBe(0);
    expect(outbox.files.write).not.toHaveBeenCalled();
    expect(f.native.beginCacheDeletion).not.toHaveBeenCalled();
  });
  it("refuses recovered over-limit originals on scan and reserve before cache eviction or reservation mutation", async () => {
    const outbox = recoveredOutbox(),
      f = await fixture(() => durablePendingOriginalBytes(outbox.store)),
      row = await sparseAccountVoice(f, 1, 1000);
    await f.controller.scan();
    const reservation = await f.controller.reserveVoice(
        500,
        `personal\\results\\${randomUUID()}.pending`,
      ),
      reservationPath = join(f.root, "storage", "reservations.json"),
      before = await readFile(reservationPath);
    outbox.records[2]!.original!.bytes += 1;
    await expect(f.controller.scan()).rejects.toThrow("OUTBOX_FULL");
    await expect(
      f.controller.reserveVoice(
        1000,
        `personal\\results\\${randomUUID()}.pending`,
      ),
    ).rejects.toThrow("OUTBOX_FULL");
    expect(await readFile(reservationPath)).toEqual(before);
    expect(
      (await lstat(join(f.root, row.relativePath.replaceAll("\\", "/")))).size,
    ).toBe(row.bytes);
    expect(f.native.beginCacheDeletion).not.toHaveBeenCalled();
    expect(f.native.commitCacheDeletion).not.toHaveBeenCalled();
    expect(outbox.files.write).not.toHaveBeenCalled();
    outbox.records[2]!.original!.bytes -= 1;
    await reservation.release();
  });
  it("refuses malformed recovered journals through real pending-original scan and reservation admission", async () => {
    const outbox = recoveredOutbox(),
      f = await fixture(() => durablePendingOriginalBytes(outbox.store));
    outbox.files.list.mockResolvedValue([null]);
    await expect(f.controller.scan()).rejects.toThrow("OUTBOX_RECORD_INVALID");
    await expect(
      f.controller.reserveVoice(
        1000,
        `personal\\results\\${randomUUID()}.pending`,
      ),
    ).rejects.toThrow("OUTBOX_RECORD_INVALID");
    await expect(
      lstat(join(f.root, "storage", "reservations.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(outbox.files.write).not.toHaveBeenCalled();
    expect(f.native.beginCacheDeletion).not.toHaveBeenCalled();
  });
  it("releasesdeadprocessreservations butuncertainquerykeepsprotection", async () => {
    const f = await fixture(),
      reservation = await f.controller.reserveVoice(
        1000,
        `personal\\results\\${randomUUID()}.pending`,
      );
    f.processIdentity.mockRejectedValueOnce(new Error("IDENTITY_UNAVAILABLE"));
    await f.controller.scan();
    expect(f.controller.view().reservedVoicesBytes).toBe(1000);
    f.setAlive(false);
    await f.controller.scan();
    expect(f.controller.view().reservedVoicesBytes).toBe(0);
    await reservation.release();
  });
  it("countsmodels/runtime/outboxseparately andneverremovesthem orusersource", async () => {
    const f = await fixture();
    for (const relative of [
      "models",
      "runtime\\releases\\" + "a".repeat(64),
      "outbox",
      "personal\\exports",
    ]) {
      const directory = await f.host.directory(relative);
      await writeFile(join(directory, "keep.dat"), "keep");
    }
    await writeFile(join(f.root, "selected-source.wav"), "source");
    await sparseAccountVoice(f, 1, 1000);
    await f.controller.execute({
      type: "CLEANUP",
      target: "all-eligible",
      confirmation: "clear-eligible-cache",
    });
    expect(await readFile(join(f.root, "models", "keep.dat"), "utf8")).toBe(
      "keep",
    );
    expect(await readFile(join(f.root, "selected-source.wav"), "utf8")).toBe(
      "source",
    );
    expect(
      f.controller.view().categories.find((row) => row.category === "runtime")
        ?.bytes,
    ).toBe(4);
  });
  it("rejectsreparseindirectionanddirectoryreplacementwithoutdeletingsource", async () => {
    const f = await fixture(),
      outside = join(f.root, "unmanaged-source");
    await mkdir(outside);
    await writeFile(join(outside, "audio.wav"), "source");
    await f.host.directory("library\\thumbnails");
    await symlink(
      outside,
      join(f.root, "library", "thumbnails", "a".repeat(64) + ".image"),
    );
    await expect(
      f.controller.execute({
        type: "CLEANUP",
        target: "all-eligible",
        confirmation: "clear-eligible-cache",
      }),
    ).rejects.toThrow("STORAGE_UNSAFE");
    expect(await readFile(join(outside, "audio.wav"), "utf8")).toBe("source");
  });
  it("refuseschangedfileidentitywithoutdeletingitsreplacement", async () => {
    const f = await fixture(),
      row = await sparseAccountVoice(f, 1, 1000),
      inventory = new WindowsStorageInventory(f.host, f.treeExited),
      items = await inventory.scan(new AbortController().signal, false),
      item = items.find((item) => item.category === "voices")!;
    await writeFile(
      join(f.root, row.relativePath.replaceAll("\\", "/")),
      "replacement",
    );
    const files = new WindowsStorageFiles(f.host);
    await expect(
      f.pins.exclusiveUnpinned([], () =>
        files.removeOwned(item, new AbortController().signal),
      ),
    ).rejects.toThrow("STORAGE_ITEM_CHANGED");
    await expect(
      inventory.scan(new AbortController().signal, false),
    ).rejects.toThrow("STORAGE_MEDIA_INVALID");
    expect(
      await readFile(
        join(f.root, row.relativePath.replaceAll("\\", "/")),
        "utf8",
      ),
    ).toBe("replacement");
  });
  it("preservescorruptsettingsandnever silentlyresetsbudget", async () => {
    const f = await fixture();
    const directory = await f.host.directory("storage");
    await writeFile(join(directory, "offline-settings.json"), "{corrupt");
    await expect(f.controller.scan()).rejects.toThrow();
    expect(f.controller.view().state).toBe("error");
    expect(
      await readFile(join(directory, "offline-settings.json"), "utf8"),
    ).toBe("{corrupt");
  });
  it("defersinjectedWindowsopenfileerrorswithoutclaimingfreedspace", async () => {
    const f = await fixture(),
      row = await sparseAccountVoice(f, 1, 1000);
    faults.blocked = join(f.root, row.relativePath.replaceAll("\\", "/"));
    await f.controller.execute({
      type: "CLEANUP",
      target: "voices",
      confirmation: "clear-eligible-cache",
    });
    expect(f.controller.view().lastCleanup).toMatchObject({
      freedBytes: 0,
      removedItems: 0,
      deferredItems: 1,
    });
    expect(await lstat(faults.blocked)).toBeDefined();
    expect(f.controller.view().voicesBytes).toBeGreaterThanOrEqual(1000);
  });
});
