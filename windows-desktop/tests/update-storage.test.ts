import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  lstat,
  symlink,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ConsumerModelArchive } from "../src/main/update/model-archive.js";
import { ConsumerBackupRetention } from "../src/main/update/retention.js";
import type { HostContext } from "../src/main/host-context.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
const roots: string[] = [],
  id = "a".repeat(64),
  signal = () => new AbortController().signal;
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function files() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-update-archive-"));
  roots.push(root);
  const path = (relative: string) => join(root, ...relative.split("\\"));
  const validatePath = vi.fn(
    async (_root: string, relative: string, kind: string) => {
      expect(relative).not.toContain("..");
      if (kind === "absent") {
        await expect(lstat(path(relative))).rejects.toMatchObject({
          code: "ENOENT",
        });
        return;
      }
      const stat = await lstat(path(relative));
      if (
        stat.isSymbolicLink() ||
        (kind === "file" && (!stat.isFile() || stat.nlink !== 1)) ||
        (kind === "directory" && !stat.isDirectory())
      )
        throw new Error("ACL_UNSAFE");
    },
  );
  const host = {
    personalRoot: root,
    native: { validatePath },
    directory: async (relative: string) => {
      await mkdir(path(relative), { recursive: true });
      return path(relative);
    },
  } as unknown as HostContext;
  const archive = new ConsumerModelArchive(host),
    old = Buffer.from("immutable previous model bytes"),
    blob = {
      bytes: old.length,
      sha256: createHash("sha256").update(old).digest("hex"),
    };
  await mkdir(join(root, "models"));
  await writeFile(join(root, "models", MODEL.filename), old);
  return { root, path, host, archive, old, blob };
}
it("retains exact old model bytes independently of a same-name replacement and restores them atomically", async () => {
  const f = await files();
  await f.archive.capture(id, f.blob, signal());
  const before = await lstat(f.path(`updates\\backups\\${id}\\model.onnx`));
  const active = await lstat(join(f.root, "models", MODEL.filename));
  expect(before.ino).not.toBe(active.ino);
  await writeFile(
    join(f.root, "models", MODEL.filename),
    "new incompatible model",
  );
  expect(await readFile(f.path(`updates\\backups\\${id}\\model.onnx`))).toEqual(
    f.old,
  );
  await f.archive.restore(id, f.blob, signal());
  expect(await readFile(join(f.root, "models", MODEL.filename))).toEqual(f.old);
});
it("rejects corrupt retained bytes without changing the active model", async () => {
  const f = await files();
  await f.archive.capture(id, f.blob, signal());
  await writeFile(
    f.path(`updates\\backups\\${id}\\model.onnx`),
    Buffer.alloc(f.old.length),
  );
  await expect(f.archive.restore(id, f.blob, signal())).rejects.toThrow(
    "UPDATE_HASH_INVALID",
  );
  expect(await readFile(join(f.root, "models", MODEL.filename))).toEqual(f.old);
});
it("never overwrites a mismatched immutable backup", async () => {
  const f = await files();
  await f.archive.capture(id, f.blob, signal());
  await writeFile(join(f.root, "models", MODEL.filename), "changed");
  await expect(
    f.archive.capture(id, { ...f.blob, sha256: "b".repeat(64) }, signal()),
  ).rejects.toThrow("UPDATE_HASH_INVALID");
  expect(await readFile(f.path(`updates\\backups\\${id}\\model.onnx`))).toEqual(
    f.old,
  );
});
it("publishes only a verified staged model and leaves the predecessor retained", async () => {
  const f = await files();
  await f.archive.capture(id, f.blob, signal());
  const next = Buffer.from("verified replacement"),
    blob = {
      bytes: next.length,
      sha256: createHash("sha256").update(next).digest("hex"),
    };
  await mkdir(f.path(`updates\\staging\\${id}`), { recursive: true });
  await writeFile(f.path(`updates\\staging\\${id}\\model.onnx`), next);
  await f.archive.activate(id, blob, signal());
  expect(await readFile(join(f.root, "models", MODEL.filename))).toEqual(next);
  expect(await readFile(f.path(`updates\\backups\\${id}\\model.onnx`))).toEqual(
    f.old,
  );
});
it("abort and malformed identity leave the active model intact", async () => {
  const f = await files(),
    abort = new AbortController();
  abort.abort();
  await expect(f.archive.capture(id, f.blob, abort.signal)).rejects.toThrow();
  await expect(
    f.archive.capture("../foreign", f.blob, signal()),
  ).rejects.toThrow("UPDATE_STATE_INVALID");
  expect(await readFile(join(f.root, "models", MODEL.filename))).toEqual(f.old);
});
it("rejects linked backup files and never follows a substituted symlink", async () => {
  const f = await files();
  await mkdir(f.path(`updates\\backups\\${id}`), { recursive: true });
  const backup = f.path(`updates\\backups\\${id}\\model.onnx`),
    foreign = join(f.root, "foreign.onnx");
  await writeFile(foreign, f.old);
  await symlink(foreign, backup);
  await expect(f.archive.restore(id, f.blob, signal())).rejects.toThrow(
    "ACL_UNSAFE",
  );
  await rm(backup);
  await link(foreign, backup);
  await expect(f.archive.restore(id, f.blob, signal())).rejects.toThrow(
    "ACL_UNSAFE",
  );
  expect(await readFile(foreign)).toEqual(f.old);
});
it("denied activation destination keeps both active and retained bytes", async () => {
  const f = await files();
  await f.archive.capture(id, f.blob, signal());
  const validate = vi
    .mocked(f.host.native.validatePath)
    .getMockImplementation()!;
  vi.spyOn(f.host.native, "validatePath").mockImplementation(
    async (root, relative, kind) => {
      if (relative === `models\\${MODEL.filename}` && kind === "file")
        throw new Error("ACL_UNSAFE");
      return validate(root, relative, kind);
    },
  );
  await expect(f.archive.restore(id, f.blob, signal())).rejects.toThrow(
    "ACL_UNSAFE",
  );
  expect(await readFile(join(f.root, "models", MODEL.filename))).toEqual(f.old);
});
it("retention cleanup is idempotent after model removal and preserves unknown files", async () => {
  const f = await files();
  await f.archive.capture(id, f.blob, signal());
  const foreign = f.path(`updates\\backups\\${id}\\foreign.txt`);
  await writeFile(foreign, "preserved");
  await expect(f.archive.remove(id)).rejects.toThrow("UPDATE_CLEANUP_PENDING");
  expect(await readFile(foreign, "utf8")).toBe("preserved");
  await rm(foreign);
  await f.archive.remove(id);
  await f.archive.remove(id);
  await expect(lstat(f.path(`updates\\backups\\${id}`))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
function retention(ids: string[] = []) {
  const data = new Map<string, Buffer>(
      ids.length
        ? [
            [
              "consumer_update_backups",
              Buffer.from(JSON.stringify({ version: 1, identities: ids })),
            ],
          ]
        : [],
    ),
    writes: string[] = [];
  const native = {
    vaultRead: async (_root: string, key: string) =>
      data.get(key) ? Buffer.from(data.get(key)!) : null,
    vaultWrite: vi.fn(async (_root: string, key: string, value: Buffer) => {
      writes.push(key);
      data.set(key, Buffer.from(value));
    }),
  };
  return {
    data,
    writes,
    native,
    retention: new ConsumerBackupRetention(native),
  };
}
it("reserves before packet writes and refuses a fourth identity without writing", async () => {
  const f = retention(["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
  await expect(f.retention.reserve("d".repeat(64))).rejects.toThrow(
    "UPDATE_CLEANUP_PENDING",
  );
  expect(f.writes).toEqual([]);
});
it("a failed capture remains bounded by its durable reservation and retry is idempotent", async () => {
  const f = retention();
  await f.retention.reserve(id);
  // Simulate a process exit before any packet or immutable blob is written.
  const restored = new ConsumerBackupRetention(f.native);
  await restored.reserve(id);
  expect(await restored.read()).toEqual([id]);
  expect(f.writes).toHaveLength(1);
});
it("a reservation persistence failure cannot authorize packet creation", async () => {
  const f = retention();
  f.native.vaultWrite.mockRejectedValueOnce(new Error("VAULT_UNAVAILABLE"));
  await expect(f.retention.reserve(id)).rejects.toThrow("VAULT_UNAVAILABLE");
  expect(await f.retention.read()).toEqual([]);
});
it("rejects malformed, duplicate and oversized retention state", async () => {
  for (const identities of [[id, id], Array(4).fill(id), ["../foreign"]]) {
    const f = retention();
    f.data.set(
      "consumer_update_backups",
      Buffer.from(JSON.stringify({ version: 1, identities })),
    );
    await expect(f.retention.read()).rejects.toThrow("UPDATE_STATE_INVALID");
  }
});
