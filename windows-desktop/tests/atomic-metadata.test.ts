import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PrivateReadable } from "../../worker/src/platform/windows/consumer-private-file.js";
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
import { writePrivateAtomic } from "../src/main/prepare/private-files.js";
import {
  RUNTIME_BACKUP_INVENTORY,
  RUNTIME_BACKUP_INVENTORY_MAX,
} from "../src/main/prepare/runtime-repair-policy.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  await f.host.directory("metadata");
  return f;
}
const relative = "metadata\\state.json";
async function interrupted(
  f: Awaited<ReturnType<typeof fixture>>,
  bound = true,
) {
  const lock = join(f.root, "metadata", "state.json.atomic.lock"),
    temporary = join(f.root, "metadata", "state.json.atomic.tmp"),
    payload = Buffer.from("interrupted payload");
  await writeFile(lock, Buffer.alloc(0));
  const header = {
    version: 1,
    target: relative,
    bytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    owner: f.parent,
    birth: storageBirth(await lstat(lock, { bigint: true })),
  };
  await writeFile(temporary, Buffer.alloc(0));
  const tempBirth = storageBirth(await lstat(temporary, { bigint: true }));
  await writeFile(
    lock,
    `${JSON.stringify(header)}\n${bound ? `${JSON.stringify({ temporaryBirth: tempBirth })}\n` : ""}`,
  );
  await writeFile(temporary, payload.subarray(0, 5));
  return { lock, temporary, header, tempBirth };
}
it("serializes callers, snapshots input bytes and leaves one canonical with no atomic temporaries", async () => {
  const f = await fixture(),
    first = Buffer.from("first"),
    second = Buffer.from("second");
  const a = writePrivateAtomic(f.host, relative, first),
    b = writePrivateAtomic(f.host, relative, second);
  first.fill(0);
  second.fill(0);
  await Promise.all([a, b]);
  expect(await readFile(join(f.root, "metadata", "state.json"), "utf8")).toBe(
    "second",
  );
  expect(await readdir(join(f.root, "metadata"))).toEqual(["state.json"]);
  expect(f.native.acquireMutex.mock.calls.map(([scope]) => scope)).toEqual([
    "metadata",
    "metadata",
  ]);
});
it("a live actual Node writer fences helper-loss/abandoned-mutex recovery without allocating another file", async () => {
  const f = await fixture(),
    old = await interrupted(f);
  await writeFile(join(f.root, "metadata", "state.json"), "prior canonical");
  for (let i = 0; i < 2; i++)
    await expect(
      writePrivateAtomic(f.host, relative, Buffer.from("new")),
    ).rejects.toThrow("METADATA_RECOVERY_PENDING");
  expect(await readFile(old.temporary, "utf8")).toBe("inter");
  expect(await readFile(join(f.root, "metadata", "state.json"), "utf8")).toBe(
    "prior canonical",
  );
  expect((await readdir(join(f.root, "metadata"))).sort()).toEqual([
    "state.json",
    "state.json.atomic.lock",
    "state.json.atomic.tmp",
  ]);
});
it("positive old Node birth replacement recovers only exact recorded lock/temp and commits new canonical", async () => {
  const f = await fixture();
  await interrupted(f);
  f.setAlive(false);
  await writePrivateAtomic(f.host, relative, Buffer.from("replacement"));
  expect(await readFile(join(f.root, "metadata", "state.json"), "utf8")).toBe(
    "replacement",
  );
  expect(await readdir(join(f.root, "metadata"))).toEqual(["state.json"]);
});
it.each(["missing", "denied"] as const)(
  "a %s retained recovery reader preserves the lock and temporary without a Node-open fallback",
  async (failure) => {
    const f = await fixture(),
      old = await interrupted(f);
    f.setAlive(false);
    const priorLock = await readFile(old.lock),
      priorTemporary = await readFile(old.temporary),
      openRead =
        vi.fn<
          (
            path: string,
            mode: "read",
            maximumBytes: number,
          ) => Promise<PrivateReadable | null>
        >();
    // This recovery attempt only opens a reader. Keep its injected null result
    // typed as a read result instead of the writable overload of the port.
    Reflect.set(f.native, "openPrivateFile", openRead);
    if (failure === "missing") openRead.mockResolvedValueOnce(null);
    else openRead.mockRejectedValueOnce(new Error("PATH_UNSAFE"));
    await expect(
      writePrivateAtomic(f.host, relative, Buffer.from("replacement")),
    ).rejects.toThrow("METADATA_RECOVERY_PENDING");
    expect(openRead).toHaveBeenCalledWith(
      `${relative}.atomic.lock`,
      "read",
      4096,
    );
    expect(await readFile(old.lock)).toEqual(priorLock);
    expect(await readFile(old.temporary)).toEqual(priorTemporary);
    expect((await readdir(join(f.root, "metadata"))).sort()).toEqual([
      "state.json.atomic.lock",
      "state.json.atomic.tmp",
    ]);
  },
);
it("changed metadata on the retained recovery generation rejects parsing and positively closes the reader", async () => {
  const f = await fixture(),
    old = await interrupted(f),
    actualOpen = f.native.openPrivateFile.getMockImplementation()!;
  f.setAlive(false);
  const priorLock = await readFile(old.lock),
    priorTemporary = await readFile(old.temporary);
  let closed = false;
  f.native.openPrivateFile.mockImplementationOnce(async (...args) => {
    const file = await actualOpen(...args);
    if (!file) throw new Error("FIXTURE_FILE_MISSING");
    let observations = 0;
    return {
      ...file,
      info: async () => {
        const info = await file.info();
        if (++observations === 2)
          return { ...info, changedAt: String(BigInt(info.changedAt) + 1n) };
        return info;
      },
      close: async () => {
        await file.close();
        closed = true;
      },
    };
  });
  await expect(
    writePrivateAtomic(f.host, relative, Buffer.from("replacement")),
  ).rejects.toThrow("METADATA_RECOVERY_PENDING");
  expect(closed).toBe(true);
  expect(await readFile(old.lock)).toEqual(priorLock);
  expect(await readFile(old.temporary)).toEqual(priorTemporary);
});
it("a dead writer's unbound temporary remains protected and bounded across repeated retries", async () => {
  const f = await fixture(),
    old = await interrupted(f, false);
  f.setAlive(false);
  for (let i = 0; i < 2; i++)
    await expect(
      writePrivateAtomic(f.host, relative, Buffer.from("new")),
    ).rejects.toThrow("METADATA_RECOVERY_PENDING");
  expect(await readFile(old.temporary, "utf8")).toBe("inter");
  expect((await readdir(join(f.root, "metadata"))).sort()).toEqual([
    "state.json.atomic.lock",
    "state.json.atomic.tmp",
  ]);
});
it("a replaced temporary birth and an incomplete lock header never gain deletion authority", async () => {
  const f = await fixture(),
    old = await interrupted(f);
  f.setAlive(false);
  await unlink(old.temporary);
  await writeFile(old.temporary, "unrelated replacement");
  await expect(
    writePrivateAtomic(f.host, relative, Buffer.from("new")),
  ).rejects.toThrow("METADATA_RECOVERY_PENDING");
  expect(await readFile(old.temporary, "utf8")).toBe("unrelated replacement");
  await writeFile(old.lock, "{incomplete");
  await expect(
    writePrivateAtomic(f.host, relative, Buffer.from("new")),
  ).rejects.toThrow("METADATA_RECOVERY_PENDING");
  expect(await readFile(old.lock, "utf8")).toBe("{incomplete");
});
it("unknown current Node identity and size limits fail before writing or borrowing a helper identity", async () => {
  const f = await fixture();
  f.native.processIdentity.mockResolvedValueOnce(null);
  await expect(
    writePrivateAtomic(f.host, relative, Buffer.from("new")),
  ).rejects.toThrow("STORAGE_OWNER_INVALID");
  await expect(
    writePrivateAtomic(f.host, relative, Buffer.alloc(2 * 1024 ** 2 + 1)),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(await readdir(join(f.root, "metadata"))).toEqual([]);
});
it("allows one fixed repair sidecar up to its independent bound while generic/path-substituted targets retain 2MiB", async () => {
  const f = await fixture(),
    bytes = Buffer.alloc(2 * 1024 ** 2 + 1, 65);
  await writePrivateAtomic(f.host, RUNTIME_BACKUP_INVENTORY, bytes);
  expect(
    await readFile(
      join(f.root, "staging", "prepare-runtime-backup.inventory.json"),
    ),
  ).toEqual(bytes);
  await expect(
    writePrivateAtomic(
      f.host,
      RUNTIME_BACKUP_INVENTORY,
      Buffer.alloc(RUNTIME_BACKUP_INVENTORY_MAX + 1),
    ),
  ).rejects.toThrow("INTEGRITY_INVALID");
  await expect(
    writePrivateAtomic(
      f.host,
      RUNTIME_BACKUP_INVENTORY.replace("staging", "other"),
      bytes,
    ),
  ).rejects.toThrow("INTEGRITY_INVALID");
  await expect(
    writePrivateAtomic(f.host, `${RUNTIME_BACKUP_INVENTORY}.other`, bytes),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(await readdir(join(f.root, "staging"))).toEqual([
    "prepare-runtime-backup.inventory.json",
  ]);
});
it("a canonical symlink cannot redirect publication or change user source bytes", async () => {
  const f = await fixture(),
    source = join(f.root, "user-source");
  await writeFile(source, "preserved source");
  await symlink(source, join(f.root, "metadata", "state.json"));
  await expect(
    writePrivateAtomic(f.host, relative, Buffer.from("new")),
  ).rejects.toThrow("PATH_UNSAFE");
  expect(await readFile(source, "utf8")).toBe("preserved source");
  expect(await readdir(join(f.root, "metadata"))).toEqual(["state.json"]);
});
it("a denied old-owner query stays recovery-pending and a contended metadata lease makes no mutation", async () => {
  const f = await fixture(),
    old = await interrupted(f),
    header = {
      ...old.header,
      owner: { ...old.header.owner, pid: process.pid + 100000 },
    };
  await writeFile(
    old.lock,
    `${JSON.stringify(header)}\n${JSON.stringify({ temporaryBirth: old.tempBirth })}\n`,
  );
  f.native.processIdentity.mockImplementation(async (pid) => {
    if (pid === process.pid) return f.parent;
    throw new Error("PROCESS_QUERY_DENIED");
  });
  await expect(
    writePrivateAtomic(f.host, relative, Buffer.from("new")),
  ).rejects.toThrow("METADATA_RECOVERY_PENDING");
  f.native.acquireMutex.mockResolvedValueOnce(null);
  await expect(
    writePrivateAtomic(f.host, relative, Buffer.from("new")),
  ).rejects.toThrow("METADATA_BUSY");
  expect(await readFile(old.temporary, "utf8")).toBe("inter");
  expect((await readdir(join(f.root, "metadata"))).sort()).toEqual([
    "state.json.atomic.lock",
    "state.json.atomic.tmp",
  ]);
});
