import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { ConsumerShareReceipt } from "../../worker/src/platform/windows/consumer-native.js";
import { WindowsShareWorkspaceFactory } from "../src/main/storage/share-workspace.js";
import { SHARE_MAX_BYTES } from "../src/main/storage/write-journal.js";
import { storageFixture } from "./storage-fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  let receipt: ConsumerShareReceipt | null = null;
  const inspect = vi.fn(async () => receipt);
  Object.assign(f.native, { inspectShare: inspect });
  const factory = new WindowsShareWorkspaceFactory({
    host: f.host,
    storage: f.controller,
  });
  const requestId = randomUUID(),
    bytes = Buffer.from("synthetic Share audio bytes");
  const workspace = await factory.create(
      requestId,
      bytes.length,
      new AbortController().signal,
    ),
    destination = await workspace.createFile("mp3");
  await destination.file.writeFile(bytes);
  await destination.commit();
  const sealed = await workspace.seal();
  const completed: ConsumerShareReceipt = {
    version: 1,
    requestId,
    nonce: "a".repeat(64),
    helper: f.host.identity,
    windowOwner: f.parent,
    relativePath: sealed.relativePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    fileIdentity: { volumeSerial: 1, fileIndex: "100", creationTime: "1000" },
    state: "completed",
    shown: true,
    quiesced: true,
    callback: "ShareCompleted",
  };
  return {
    ...f,
    factory,
    workspace,
    requestId,
    sealed,
    bytes,
    completed,
    inspect,
    setReceipt: (value: ConsumerShareReceipt | null) => {
      receipt = value;
    },
    path: join(f.root, sealed.relativePath.replaceAll("\\", "/")),
  };
}
describe("Private native Share staging (real files and injected native receipts)", () => {
  it("retains the exact deletion tuple, journal and pin across a lost completion ACK, then resumes its certificate", async () => {
    const f = await fixture();
    await f.workspace.handoff(f.host.identity);
    f.setReceipt(f.completed);
    const remove = f.native.discardShareWorkspace.getMockImplementation()!;
    f.native.discardShareWorkspace.mockImplementationOnce(async (...args) => {
      await remove(...args);
      throw new Error("NATIVE_ACK_LOST");
    });
    await expect(f.workspace.settle(f.completed)).rejects.toThrow(
      "NATIVE_ACK_LOST",
    );
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.controller.writes.readOwned())[0]?.share?.quiesced).toBe(
      true,
    );
    const original = structuredClone(
      f.native.discardShareWorkspace.mock.calls[0],
    );
    await f.workspace.settle(f.completed);
    expect(f.native.discardShareWorkspace.mock.calls[1]).toEqual(original);
    expect(await f.factory.pending()).toEqual([]);
  });
  it("preserves data and native-pending authority on a pending disposition or absent production receiver", async () => {
    const f = await fixture();
    await f.workspace.handoff(f.host.identity);
    f.setReceipt(f.completed);
    f.native.discardShareWorkspace.mockResolvedValueOnce("pending");
    await expect(f.workspace.settle(f.completed)).rejects.toThrow(
      "STORAGE_RECOVERY_PENDING",
    );
    expect(await readFile(f.path)).toEqual(f.bytes);
    Reflect.deleteProperty(f.host.native, "discardShareWorkspace");
    await expect(f.workspace.settle(f.completed)).rejects.toThrow(
      "STORAGE_RECOVERY_PENDING",
    );
    expect(await f.factory.pending()).toEqual([f.requestId]);
  });
  it("retries only completed-receipt retirement after a positive deletion and journal/pin settlement", async () => {
    const f = await fixture();
    await f.workspace.handoff(f.host.identity);
    f.setReceipt(f.completed);
    f.native.recoverPersonalCleanups.mockRejectedValueOnce(
      new Error("RECEIPT_ACK_LOST"),
    );
    await expect(f.workspace.settle(f.completed)).rejects.toThrow(
      "RECEIPT_ACK_LOST",
    );
    expect(await f.factory.pending()).toEqual([]);
    await f.workspace.settle(f.completed);
    expect(f.native.discardShareWorkspace).toHaveBeenCalledOnce();
    expect(f.native.recoverPersonalCleanups).toHaveBeenCalledTimes(2);
  });
  it("reserves and seals the exact copy, retains native handoff across Node death, and accepts only actual inspected quiescence", async () => {
    const f = await fixture();
    expect(await readFile(f.path)).toEqual(f.bytes);
    expect(f.workspace.nativePending()).toBe(false);
    await f.workspace.handoff(f.host.identity);
    expect(f.workspace.nativePending()).toBe(true);
    const writer = (await f.controller.writes.readOwned())[0]!;
    expect(writer.share).toMatchObject({
      nativePending: true,
      file: { sha256: f.completed.sha256 },
    });
    f.setAlive(false);
    await f.controller.cleanup("scratch", new AbortController().signal);
    expect(await readFile(f.path)).toEqual(f.bytes);
    await expect(
      (await f.controller.resumeShareWrite(f.requestId)).lease.settle(),
    ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
    await expect(f.workspace.discardBeforeHandoff()).rejects.toThrow(
      "STORAGE_RECOVERY_PENDING",
    );
    f.setReceipt({
      ...f.completed,
      state: "pending",
      quiesced: false,
      callback: null,
    });
    await expect(f.workspace.settle(f.completed)).rejects.toThrow(
      "STORAGE_RECOVERY_PENDING",
    );
    expect(await f.factory.pending()).toEqual([f.requestId]);
    f.setReceipt(f.completed);
    await f.workspace.settle(f.completed);
    expect(f.inspect).toHaveBeenCalledWith(f.requestId);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.factory.pending()).toEqual([]);
  });
  it("does not trust a supplied terminal receipt, foreign helper/window owner, nonce or file identity", async () => {
    const f = await fixture();
    await f.workspace.handoff(f.host.identity);
    f.setReceipt(f.completed);
    for (const change of [
      { nonce: "b".repeat(64) },
      { fileIdentity: { ...f.completed.fileIdentity, fileIndex: "101" } },
      { windowOwner: { ...f.parent, creationTime: "2000" } },
      { helper: { ...f.host.identity, creationTime: "2000" } },
      {
        relativePath: f.completed.relativePath.replace(
          "media.mp3",
          "media.wav",
        ),
      },
    ]) {
      await expect(
        f.workspace.settle({ ...f.completed, ...change }),
      ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
      expect(await readFile(f.path)).toEqual(f.bytes);
    }
    f.inspect.mockRejectedValueOnce(new Error("helper lost"));
    await expect(f.workspace.settle(f.completed)).rejects.toThrow(
      "helper lost",
    );
    expect(await f.factory.pending()).toEqual([f.requestId]);
  });
  it("restores a retained copy without showing Share again and requires its original window/helper proof", async () => {
    const f = await fixture();
    await f.workspace.handoff(f.host.identity);
    await f.workspace.retain();
    const replacement = { ...f.parent, creationTime: "2000" };
    f.processIdentity.mockResolvedValue(replacement);
    f.native.processIdentity.mockResolvedValue(replacement);
    const restarted = new WindowsShareWorkspaceFactory({
        host: f.host,
        storage: f.controller,
      }),
      restored = await restarted.restore(
        f.requestId,
        new AbortController().signal,
      );
    expect(await restarted.pending()).toEqual([f.requestId]);
    await expect(restored.createFile("mp3")).rejects.toThrow(
      "STORAGE_WRITE_INVALID",
    );
    await expect(restored.settle(f.completed)).rejects.toThrow(
      "STORAGE_RECOVERY_PENDING",
    );
    f.setReceipt(f.completed);
    await restored.settle(f.completed);
    expect(await restarted.pending()).toEqual([]);
  });
  it("preserves a changed sealed file rather than deleting a replacement after quiescence", async () => {
    const f = await fixture();
    await f.workspace.handoff(f.host.identity);
    f.setReceipt(f.completed);
    await writeFile(f.path, Buffer.alloc(f.bytes.length, 1));
    await expect(f.workspace.settle(f.completed)).rejects.toThrow(
      "STORAGE_WRITE_CHANGED",
    );
    expect(await readFile(f.path)).toEqual(Buffer.alloc(f.bytes.length, 1));
    expect(await f.factory.pending()).toEqual([f.requestId]);
  });
  it("restores only a positively dead prehandoff copy as nativePending false for safe discard", async () => {
    const f = await fixture();
    await expect(
      f.factory.restore(f.requestId, new AbortController().signal),
    ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
    const replacement = { ...f.parent, creationTime: "2000" };
    f.processIdentity.mockResolvedValue(replacement);
    f.native.processIdentity.mockResolvedValue(replacement);
    const copy = await f.factory.restore(
      f.requestId,
      new AbortController().signal,
    );
    expect(copy.nativePending()).toBe(false);
    await copy.discardBeforeHandoff();
    expect(await f.factory.pending()).toEqual([]);
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("retries failed pin release after exact copy removal without requiring a fabricated new native proof", async () => {
    const f = await storageFixture();
    roots.push(f.root);
    const original = f.controller.protectTree.bind(f.controller),
      release = vi.fn();
    f.controller.protectTree = async (...args) => {
      const pin = await original(...args);
      release
        .mockRejectedValueOnce(new Error("pin metadata unavailable"))
        .mockImplementation(async () => pin.release());
      return { pinId: pin.pinId, release };
    };
    const inspect =
      vi.fn<(...args: string[]) => Promise<ConsumerShareReceipt | null>>();
    Object.assign(f.native, { inspectShare: inspect });
    const factory = new WindowsShareWorkspaceFactory({
        host: f.host,
        storage: f.controller,
      }),
      id = randomUUID(),
      workspace = await factory.create(id, 3, new AbortController().signal),
      destination = await workspace.createFile("mp3");
    await destination.file.writeFile("wav");
    await destination.commit();
    const sealed = await workspace.seal();
    await workspace.handoff(f.host.identity);
    const receipt: ConsumerShareReceipt = {
      version: 1,
      requestId: id,
      nonce: "a".repeat(64),
      helper: f.host.identity,
      windowOwner: f.parent,
      ...sealed,
      fileIdentity: { volumeSerial: 1, fileIndex: "100", creationTime: "1000" },
      state: "cancelled",
      shown: true,
      quiesced: true,
      callback: "ShareCanceled",
    };
    inspect.mockResolvedValue(receipt);
    await expect(workspace.settle(receipt)).rejects.toThrow(
      "pin metadata unavailable",
    );
    await workspace.settle(receipt);
    expect(inspect).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(2);
  });
  it("bounds persistent copy reservations and permits only the fixed approved Share media slots", async () => {
    const f = await storageFixture();
    roots.push(f.root);
    Object.assign(f.native, { inspectShare: async () => null });
    const factory = new WindowsShareWorkspaceFactory({
      host: f.host,
      storage: f.controller,
    });
    const first = await factory.create(
      randomUUID(),
      SHARE_MAX_BYTES,
      new AbortController().signal,
    );
    const firstId = first.relativePath.split("\\")[2]!;
    await expect(
      factory.restore(firstId, new AbortController().signal),
    ).rejects.toThrow("STORAGE_RECOVERY_PENDING");
    await factory.create(
      randomUUID(),
      SHARE_MAX_BYTES,
      new AbortController().signal,
    );
    await expect(
      factory.create(randomUUID(), 1, new AbortController().signal),
    ).rejects.toThrow("STORAGE_WRITE_LIMIT");
    await expect(first.createFile("exe")).rejects.toThrow(
      "STORAGE_WRITE_INVALID",
    );
    await expect(
      factory.create("..", 1, new AbortController().signal),
    ).rejects.toThrow("STORAGE_WRITE_INVALID");
    await first.discardBeforeHandoff();
    await expect(
      factory.create(randomUUID(), 1, new AbortController().signal),
    ).resolves.toBeDefined();
  });
});
