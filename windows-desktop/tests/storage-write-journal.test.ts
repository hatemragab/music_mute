import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
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
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
function path(root: string, relative: string) {
  return join(root, relative.replaceAll("\\", "/"));
}
it("reads all256 admitted rows with the explicit private node budget, while duplicate/escaped keys and invalid UTF8 fail", async () => {
  const f = await fixture();
  await f.host.directory("storage");
  const writes = Array.from({ length: 256 }, (_, n) => {
    const id = `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
    return {
      id,
      relativePath:
        n < 64 ? `personal\\inputs\\${id}` : `personal\\results\\${id}.pending`,
      kind: "tree",
      owner: f.parent,
      settled: false,
      createdAt: 1000,
      birth: { device: "1", fileId: String(n + 1), bornAt: "1000" },
      ...(n < 64
        ? {
            input: {
              bytes: 1,
              expiresAt: 1001,
              birth: {
                name: "source.mp3",
                directory: {
                  device: "1",
                  fileId: String(n + 1),
                  bornAt: "1000",
                },
                file: { device: "1", fileId: String(n + 257), bornAt: "1000" },
              },
            },
          }
        : {}),
    };
  });
  const journal = JSON.stringify({ version: 1, writes });
  await writeFile(path(f.root, "storage\\writes.json"), journal);
  expect((await f.controller.writes.readOwned()).length).toBe(256);
  for (const bad of [
    '{"version":1,"version":1,"writes":[]}',
    '{"version":1,"\\u0076ersion":1,"writes":[]}',
    journal.replace('"settled":false', '"settled":true,"settled":false'),
  ]) {
    await writeFile(path(f.root, "storage\\writes.json"), bad);
    await expect(f.controller.writes.readOwned()).rejects.toThrow();
  }
  await writeFile(
    path(f.root, "storage\\writes.json"),
    Buffer.concat([
      Buffer.from('{"version":1,"writes":[],"bad":"'),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from('"}'),
    ]),
  );
  await expect(f.controller.writes.readOwned()).rejects.toThrow();
});
it("workspace marker removal requires exact whole-Job proof and retries certified reply/ACK loss without a path unlink", async () => {
  const f = await fixture(),
    relative = `prepare\\work\\${randomUUID()}`,
    owner = {
      role: "prepare" as const,
      nonce: "a".repeat(64),
      identity: f.parent,
    },
    marker = `storage\\workspaces\\${hash(relative)}.json`;
  await f.host.directory(relative);
  const lease = await f.controller.trackWorkspace(
    relative,
    owner,
    "processing",
  );
  await rmdir(path(f.root, relative));
  await expect(lease.release()).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  expect(await lstat(path(f.root, marker))).toBeDefined();
  f.setExited(true);
  const retire = f.native.retireStorageWorkspaceMarker.getMockImplementation()!;
  f.native.retireStorageWorkspaceMarker.mockImplementationOnce(async (r, o) => {
    await retire(r, o);
    throw new Error("REPLY_LOST");
  });
  await expect(lease.release()).rejects.toThrow("REPLY_LOST");
  f.native.acknowledgeStorageCleanup.mockRejectedValueOnce(
    new Error("ACK_LOST"),
  );
  await expect(lease.release()).rejects.toThrow("ACK_LOST");
  const calls = f.native.retireStorageWorkspaceMarker.mock.calls.length;
  await lease.release();
  expect(f.native.retireStorageWorkspaceMarker.mock.calls.length).toBe(calls);
  await expect(lstat(path(f.root, marker))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("a live exact personal role can retire its marker only after the injected actual inference census is idle; restart still needs whole-Job proof", async () => {
  const f = await fixture(),
    relative = `personal\\jobs\\${randomUUID()}`,
    owner = {
      role: "personal" as const,
      nonce: "a".repeat(64),
      identity: f.parent,
    };
  await f.host.directory(relative);
  const lease = await f.controller.trackWorkspace(
    relative,
    owner,
    "processing",
  );
  await rmdir(path(f.root, relative));
  f.setInferenceIdle(false);
  await expect(lease.release()).rejects.toThrow("STORAGE_RECOVERY_PENDING");
  f.setInferenceIdle(true);
  await lease.release();
  expect(f.native.retireStorageWorkspaceMarker).toHaveBeenCalledTimes(2);
  // assertWorkspaceExited is the stronger recovery authority and never accepts
  // the new Node's empty role census for a retained old marker.
  const old = `personal\\jobs\\${randomUUID()}`;
  await f.host.directory(old);
  await f.controller.trackWorkspace(old, owner, "processing");
  f.setAlive(false);
  await expect(f.controller.assertWorkspaceExited(old)).rejects.toThrow(
    "STORAGE_RECOVERY_PENDING",
  );
});
it("retains an active Node copy then reclaims only its settled pending tree", async () => {
  const f = await fixture(),
    relative = `personal\\results\\${randomUUID()}.pending`;
  await f.host.directory("personal\\results");
  const lease = await f.controller.beginWrite(relative, "tree");
  expect((await f.controller.writes.readOwned())[0]!.owner).toEqual(f.parent);
  await f.host.directory(relative);
  await lease.captureCreated(
    storageBirth(await lstat(path(f.root, relative), { bigint: true })),
  );
  await writeFile(path(f.root, `${relative}\\original.wav`), "owned fixture");
  await f.controller.execute({
    type: "CLEANUP",
    target: "scratch",
    confirmation: "clear-eligible-cache",
  });
  expect(await lstat(path(f.root, relative))).toBeDefined();
  await lease.settle();
  await f.controller.execute({
    type: "CLEANUP",
    target: "scratch",
    confirmation: "clear-eligible-cache",
  });
  await expect(lstat(path(f.root, relative))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await f.controller.writes.readOwned()).toEqual([]);
});
it("process death permits Node-only partial cleanup while uncertain liveness retains it", async () => {
  const f = await fixture(),
    relative = `personal\\results\\${randomUUID()}.pending`;
  await f.host.directory("personal\\results");
  const lease = await f.controller.beginWrite(relative, "tree");
  await f.host.directory(relative);
  await lease.captureCreated(
    storageBirth(await lstat(path(f.root, relative), { bigint: true })),
  );
  await writeFile(
    path(f.root, `${relative}\\pair.json`),
    "incomplete Node fixture",
  );
  f.processIdentity.mockRejectedValueOnce(new Error("uncertain native query"));
  await f.controller.execute({
    type: "CLEANUP",
    target: "scratch",
    confirmation: "clear-eligible-cache",
  });
  expect(await lstat(path(f.root, relative))).toBeDefined();
  f.setAlive(false);
  await f.controller.execute({
    type: "CLEANUP",
    target: "scratch",
    confirmation: "clear-eligible-cache",
  });
  await expect(lstat(path(f.root, relative))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("handoff removes Node cleanup permission before any decoder/benchmark child can launch", async () => {
  const f = await fixture(),
    relative = `prepare\\work\\${randomUUID()}`;
  await f.host.directory("prepare\\work");
  const lease = await f.controller.beginWrite(relative, "tree");
  await f.host.directory(relative);
  await lease.captureCreated(
    storageBirth(await lstat(path(f.root, relative), { bigint: true })),
  );
  await writeFile(
    path(f.root, `${relative}\\source.wav`),
    "bounded source fixture",
  );
  await lease.handoff();
  expect(await f.controller.writes.readOwned()).toEqual([]);
  f.setAlive(false);
  await f.controller.execute({
    type: "CLEANUP",
    target: "scratch",
    confirmation: "clear-eligible-cache",
  });
  expect(await lstat(path(f.root, relative))).toBeDefined();
  expect(f.treeExited).not.toHaveBeenCalled();
});
async function publicationFixture() {
  const f = await fixture(),
    uid = "journal-owner",
    root = `library\\media\\${hash(uid)}\\${"a".repeat(24)}\\voice\\${hash("voice")}`,
    relative = `${root}\\media.mp3`,
    temporary = `${relative}.${randomUUID()}.part`,
    metadata = `${root}\\media.json`,
    pending = `${metadata}.${randomUUID()}.tmp`;
  await f.host.directory(root);
  const lease = await f.controller.beginWrite(temporary, "file");
  const file = await open(path(f.root, temporary), "wx");
  try {
    await lease.captureCreated(storageBirth(await file.stat({ bigint: true })));
    await file.writeFile("voice");
    await file.sync();
  } finally {
    await file.close();
  }
  await lease.preparePublish(relative, metadata, pending, hash("voice"));
  return {
    ...f,
    uid,
    mediaRoot: root,
    relative,
    temporary,
    metadata,
    pending,
    lease,
  };
}
it("reclaims exact own orphan data after rename-before-metadata crash", async () => {
  const f = await publicationFixture();
  await rename(path(f.root, f.temporary), path(f.root, f.relative));
  f.setAlive(false);
  await f.controller.execute({
    type: "CLEANUP",
    target: "scratch",
    confirmation: "clear-eligible-cache",
  });
  await expect(readFile(path(f.root, f.relative))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await f.controller.writes.readOwned()).toEqual([]);
});
it("never removes a committed immutable artifact while settling/recovering a writer", async () => {
  const f = await publicationFixture();
  await rename(path(f.root, f.temporary), path(f.root, f.relative));
  await writeFile(
    path(f.root, f.metadata),
    JSON.stringify({
      version: 1,
      ownerUid: f.uid,
      jobId: "a".repeat(24),
      variant: "voice",
      sha256: hash("voice"),
      bytes: 5,
      relativePath: f.relative,
      artifactId: randomUUID(),
      durationSeconds: 60,
      contentType: "audio/mpeg",
      createdAt: Date.now(),
    }),
  );
  await f.lease.settle();
  expect(await f.controller.writes.readOwned()).toEqual([]);
  await f.controller.execute({
    type: "CLEANUP",
    target: "scratch",
    confirmation: "clear-eligible-cache",
  });
  expect(await readFile(path(f.root, f.relative), "utf8")).toBe("voice");
});
it("changed published file birth/hash fails closed instead of deleting late publisher bytes", async () => {
  const f = await publicationFixture();
  await rename(path(f.root, f.temporary), path(f.root, f.relative));
  await writeFile(path(f.root, f.relative), "other");
  f.setAlive(false);
  await expect(
    f.controller.execute({
      type: "CLEANUP",
      target: "scratch",
      confirmation: "clear-eligible-cache",
    }),
  ).rejects.toThrow("STORAGE_WRITE_CHANGED");
  expect(await readFile(path(f.root, f.relative), "utf8")).toBe("other");
});
it("rejects source/runtime roots and helper identity as a Node writer", async () => {
  const f = await fixture();
  await expect(
    f.controller.beginWrite("models\\Kim_Vocal_2.onnx", "file"),
  ).rejects.toThrow("STORAGE_WRITE_INVALID");
  await expect(
    f.controller.beginWrite(`personal\\jobs\\${randomUUID()}`, "tree"),
  ).rejects.toThrow("STORAGE_WRITE_INVALID");
  f.processIdentity.mockResolvedValue(f.host.identity);
  await expect(
    f.controller.beginWrite(
      `personal\\results\\${randomUUID()}.pending`,
      "tree",
    ),
  ).rejects.toThrow("STORAGE_OWNER_INVALID");
});
it("an old unbound journal cannot authorize partial-tree deletion after Node death", async () => {
  const f = await fixture(),
    relative = `personal\\results\\${randomUUID()}.pending`;
  await f.host.directory("personal\\results");
  await f.controller.beginWrite(relative, "tree");
  await f.host.directory(relative);
  await writeFile(path(f.root, `${relative}\\pair.json`), "unknown birth");
  f.setAlive(false);
  await f.controller.cleanup("scratch", new AbortController().signal);
  expect(await readFile(path(f.root, `${relative}\\pair.json`), "utf8")).toBe(
    "unknown birth",
  );
  expect(await f.controller.writes.readOwned()).toHaveLength(1);
});
it("refuses a replaced partial directory even when its old writer is positively dead", async () => {
  const f = await fixture(),
    relative = `personal\\results\\${randomUUID()}.pending`;
  await f.host.directory("personal\\results");
  const writer = await f.controller.beginWrite(relative, "tree");
  await f.host.directory(relative);
  await writer.captureCreated(
    storageBirth(await lstat(path(f.root, relative), { bigint: true })),
  );
  await rename(path(f.root, relative), path(f.root, `${relative}.saved`));
  await f.host.directory(relative);
  await writeFile(path(f.root, `${relative}\\pair.json`), "replacement bytes");
  f.setAlive(false);
  await expect(
    f.controller.cleanup("scratch", new AbortController().signal),
  ).rejects.toThrow("STORAGE_WRITE_CHANGED");
  expect(await readFile(path(f.root, `${relative}\\pair.json`), "utf8")).toBe(
    "replacement bytes",
  );
});
it("reclaims exact bound metadata staged before atomic data publication", async () => {
  const f = await publicationFixture(),
    file = await open(path(f.root, f.pending), "wx");
  try {
    await f.lease.captureCreated(
      storageBirth(await file.stat({ bigint: true })),
      f.pending,
    );
    await file.writeFile("incomplete metadata");
  } finally {
    await file.close();
  }
  f.setAlive(false);
  await f.controller.cleanup("scratch", new AbortController().signal);
  await expect(lstat(path(f.root, f.pending))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(lstat(path(f.root, f.temporary))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await f.controller.writes.readOwned()).toEqual([]);
});
