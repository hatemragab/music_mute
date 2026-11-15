import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const io = vi.hoisted(() => ({
  renameFailure: null as "quarantine" | "promote" | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await actual.rename(from, to);
      if (
        (io.renameFailure === "quarantine" &&
          to.endsWith("prepare-runtime-backup")) ||
        (io.renameFailure === "promote" && from.endsWith("prepare-runtime"))
      ) {
        io.renameFailure = null;
        throw new Error("lost actual rename ACK");
      }
    },
  };
});
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
import {
  RuntimeRepair,
  RUNTIME_REPAIR_KEY,
  RUNTIME_BACKUP_PATH,
  RUNTIME_BACKUP_INVENTORY,
  parseRuntimeBackupInventory,
} from "../src/main/prepare/runtime-repair.js";
import {
  RuntimeStaging,
  RUNTIME_STAGING_PATH,
  RUNTIME_STAGING_KEY,
} from "../src/main/prepare/runtime-staging.js";
import type { PreparationBundle } from "../src/main/prepare/bundle.js";
import { storageFixture } from "./storage-fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  io.renameFailure = null;
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const bundle: PreparationBundle = {
  targetIdentity: "a".repeat(64),
  archivePath: "fixture-no-execution.zip",
  metadata: {
    schemaVersion: 1,
    platform: "windows-amd64",
    installationProfile: "windows-user",
    sequence: 1,
    releaseVersion: "0.1.3",
    publishedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-10T00:00:00.000Z",
    release: {
      filename: "fixture.zip",
      bytes: 100,
      sha256: "b".repeat(64),
      contentType: "application/zip",
    },
  },
};
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  const vault = new Map<string, Buffer>();
  const native = Object.assign(f.native, {
    vaultRead: vi.fn(async (_: string, key: string) =>
      vault.has(key) ? Buffer.from(vault.get(key)!) : null,
    ),
    vaultWrite: vi.fn(async (_: string, key: string, bytes: Buffer) => {
      vault.set(key, Buffer.from(bytes));
    }),
    vaultDelete: vi.fn(async (_: string, key: string) => {
      vault.delete(key);
    }),
  });
  const path = (relative: string) =>
    join(f.root, relative.replaceAll("\\", "/"));
  const canonical = `runtime\\releases\\${bundle.targetIdentity}`;
  await f.host.directory(canonical);
  await writeFile(path(`${canonical}\\old.exe`), "damaged private bytes");
  await writeFile(join(f.root, "user-source.wav"), "keep user bytes");
  const verify = vi.fn(async (relative: string) => {
    expect(await readFile(path(`${relative}\\new.exe`), "utf8")).toBe(
      "verified fixture only",
    );
    return ["old.exe", "new.exe"];
  });
  const assertMutation = vi.fn(async () => {});
  const staging = new RuntimeStaging(f.host, async (_row, relative) => {
    await verify(relative);
  });
  const stagePath = await staging.create(bundle);
  await writeFile(join(stagePath, "new.exe"), "verified fixture only");
  await staging.verified("c".repeat(64));
  const repair = new RuntimeRepair(f.host, assertMutation, verify);
  return {
    ...f,
    native,
    vault,
    path,
    canonical,
    verify,
    assertMutation,
    staging,
    repair,
  };
}
it("binds exact old tree bytes/birth and signed new stage before renames, preserving old bytes and user files", async () => {
  const f = await fixture();
  await f.repair.replace(bundle, f.staging.verifiedRecord(), null);
  const row = await f.repair.promotedRecord();
  expect(row?.phase).toBe("promoted");
  expect(await f.repair.blocksReady()).toBe(true);
  expect(await readFile(f.path(`${f.canonical}\\new.exe`), "utf8")).toBe(
    "verified fixture only",
  );
  expect(
    await readFile(f.path(`${RUNTIME_BACKUP_PATH}\\old.exe`), "utf8"),
  ).toBe("damaged private bytes");
  await f.staging.acceptRepairPromotion(row!);
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(false);
  await f.repair.activated(bundle);
  expect(await f.repair.blocksReady()).toBe(true); // Native bank cleanup is still pending.
  expect(await readFile(join(f.root, "user-source.wav"), "utf8")).toBe(
    "keep user bytes",
  );
  expect(f.assertMutation).toHaveBeenCalled();
});
it.each(["snapshotting", "quarantining", "promoting", "promoted"])(
  "lost %s WAL ACK retains real stage/backup and exact retry does not allocate another slot",
  async (phase) => {
    const f = await fixture();
    const write = f.native.vaultWrite.getMockImplementation()!;
    let failed = false;
    f.native.vaultWrite.mockImplementation(async (space, key, bytes) => {
      await write(space, key, bytes);
      if (
        key === RUNTIME_REPAIR_KEY &&
        JSON.parse(bytes.toString()).phase === phase &&
        !failed
      ) {
        failed = true;
        throw new Error("lost durable ACK");
      }
    });
    await expect(
      f.repair.replace(bundle, f.staging.verifiedRecord(), null),
    ).rejects.toThrow("lost durable ACK");
    expect(f.repair.cleanupPending()).toBe(true);
    expect(await f.repair.blocksReady()).toBe(true);
    await f.repair.recover(bundle);
    expect(f.repair.cleanupPending()).toBe(false);
    expect(
      await readFile(f.path(`${RUNTIME_BACKUP_PATH}\\old.exe`), "utf8"),
    ).toBe("damaged private bytes");
    expect(await readFile(f.path(`${f.canonical}\\new.exe`), "utf8")).toBe(
      "verified fixture only",
    );
    await expect(
      f.repair.replace(bundle, f.staging.verifiedRecord(), null),
    ).rejects.toThrow("BUSY");
  },
);
it("first WAL refusal before commit retries only the original exact live pre-effect owner, with no suffix cleanup or second allocation", async () => {
  const f = await fixture(),
    write = f.native.vaultWrite.getMockImplementation()!;
  let refused = false;
  f.native.vaultWrite.mockImplementation(async (space, key, bytes) => {
    if (key === RUNTIME_REPAIR_KEY && !refused) {
      refused = true;
      throw new Error("WAL_WRITE_REFUSED");
    }
    await write(space, key, bytes);
  });
  await expect(
    f.repair.replace(bundle, f.staging.verifiedRecord(), null),
  ).rejects.toThrow("WAL_WRITE_REFUSED");
  expect(f.vault.has(RUNTIME_REPAIR_KEY)).toBe(false);
  expect(f.repair.cleanupPending()).toBe(true);
  expect(await readFile(f.path(`${f.canonical}\\old.exe`), "utf8")).toBe(
    "damaged private bytes",
  );
  await f.repair.recover(bundle);
  expect((await f.repair.promotedRecord())?.phase).toBe("promoted");
  expect(
    await readFile(f.path(`${RUNTIME_BACKUP_PATH}\\old.exe`), "utf8"),
  ).toBe("damaged private bytes");
});
it("unknown old files never become backup deletion authority; exact pre-effect cancellation preserves them and drops only its own WAL", async () => {
  const f = await fixture();
  await writeFile(
    f.path(`${f.canonical}\\unknown-user.wav`),
    "keep unknown audio",
  );
  await expect(
    f.repair.replace(bundle, f.staging.verifiedRecord(), null),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(f.repair.cleanupPending()).toBe(true);
  await expect(
    readFile(f.path(RUNTIME_BACKUP_INVENTORY)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.repair.cancelBeforeEffects()).toBe(true);
  expect(f.repair.cleanupPending()).toBe(false);
  expect(f.vault.has(RUNTIME_REPAIR_KEY)).toBe(false);
  expect(
    await readFile(f.path(`${f.canonical}\\unknown-user.wav`), "utf8"),
  ).toBe("keep unknown audio");
  await f.staging.discardOwned();
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(false);
});
it.each(["quarantine", "promote"] as const)(
  "lost %s rename ACK preserves recorded births and exact retry selects the actual placement",
  async (phase) => {
    const f = await fixture();
    io.renameFailure = phase;
    await expect(
      f.repair.replace(bundle, f.staging.verifiedRecord(), null),
    ).rejects.toThrow("lost actual rename ACK");
    expect(f.repair.cleanupPending()).toBe(true);
    await f.repair.recover(bundle);
    expect(f.repair.cleanupPending()).toBe(false);
    expect(
      await readFile(f.path(`${RUNTIME_BACKUP_PATH}\\old.exe`), "utf8"),
    ).toBe("damaged private bytes");
    expect(await readFile(f.path(`${f.canonical}\\new.exe`), "utf8")).toBe(
      "verified fixture only",
    );
    await expect(
      readFile(f.path(`${RUNTIME_STAGING_PATH}\\new.exe`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it("a restarted repair refuses a live or unknown old Node and resumes an exact dead/reused birth after first rename", async () => {
  const f = await fixture();
  const write = f.native.vaultWrite.getMockImplementation()!;
  f.native.vaultWrite.mockImplementation(async (space, key, bytes) => {
    await write(space, key, bytes);
    if (
      key === RUNTIME_REPAIR_KEY &&
      JSON.parse(bytes.toString()).phase === "promoting"
    )
      throw new Error("crash before promote");
  });
  await expect(
    f.repair.replace(bundle, f.staging.verifiedRecord(), null),
  ).rejects.toThrow("crash before promote");
  const restarted = new RuntimeRepair(f.host, f.assertMutation, f.verify);
  await expect(restarted.recover(bundle)).rejects.toThrow("BUSY");
  f.native.processIdentity.mockRejectedValueOnce(
    new Error("birth query unknown"),
  );
  await expect(restarted.recover(bundle)).rejects.toThrow(
    "birth query unknown",
  );
  f.setAlive(false);
  f.native.vaultWrite.mockImplementation(write);
  await restarted.recover(bundle);
  await f.staging.acceptRepairPromotion((await restarted.promotedRecord())!);
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(false);
  expect(await readFile(f.path(`${f.canonical}\\new.exe`), "utf8")).toBe(
    "verified fixture only",
  );
});
it("replacement birth, altered old content or sealed inventory tamper denies recovery without deleting either candidate", async () => {
  const f = await fixture();
  const write = f.native.vaultWrite.getMockImplementation()!;
  f.native.vaultWrite.mockImplementation(async (space, key, bytes) => {
    await write(space, key, bytes);
    if (
      key === RUNTIME_REPAIR_KEY &&
      JSON.parse(bytes.toString()).phase === "promoting"
    )
      throw new Error("crash");
  });
  await expect(
    f.repair.replace(bundle, f.staging.verifiedRecord(), null),
  ).rejects.toThrow("crash");
  f.native.vaultWrite.mockImplementation(write);
  await writeFile(f.path(`${RUNTIME_BACKUP_PATH}\\old.exe`), "changed content");
  await expect(f.repair.recover(bundle)).rejects.toThrow("INTEGRITY_INVALID");
  expect(
    await readFile(f.path(`${RUNTIME_STAGING_PATH}\\new.exe`), "utf8"),
  ).toBe("verified fixture only");
  await writeFile(f.path(RUNTIME_BACKUP_INVENTORY), "untrusted metadata");
  await expect(f.repair.recover(bundle)).rejects.toThrow("INTEGRITY_INVALID");
  await rename(
    f.path(RUNTIME_BACKUP_PATH),
    f.path("staging\\known-old-backup"),
  );
  await mkdir(f.path(RUNTIME_BACKUP_PATH));
  await writeFile(f.path(`${RUNTIME_BACKUP_PATH}\\unknown`), "keep unknown");
  await expect(f.repair.recover(bundle)).rejects.toThrow("INTEGRITY_INVALID");
  expect(
    await readFile(f.path(`${RUNTIME_BACKUP_PATH}\\unknown`), "utf8"),
  ).toBe("keep unknown");
});
it("an old-tree link, occupied backup or lost mutation authority fails closed instead of deleting a path by suffix", async () => {
  const f = await fixture();
  await unlink(f.path(`${f.canonical}\\old.exe`));
  await symlink(
    join(f.root, "user-source.wav"),
    f.path(`${f.canonical}\\old.exe`),
  );
  await expect(
    f.repair.replace(bundle, f.staging.verifiedRecord(), null),
  ).rejects.toThrow("PATH_UNSAFE");
  expect(f.repair.cleanupPending()).toBe(true);
  expect(await readFile(join(f.root, "user-source.wav"), "utf8")).toBe(
    "keep user bytes",
  );
  const g = await fixture();
  g.assertMutation.mockRejectedValue(new Error("actual gate lost"));
  await expect(
    g.repair.replace(bundle, g.staging.verifiedRecord(), null),
  ).rejects.toThrow("actual gate lost");
  expect(g.vault.has(RUNTIME_REPAIR_KEY)).toBe(false);
  await g.host.directory(RUNTIME_BACKUP_PATH);
  await expect(
    g.repair.replace(bundle, g.staging.verifiedRecord(), null),
  ).rejects.toThrow("BUSY");
});
it("strict inventory parser refuses path substitution, duplicates, unbounded bytes and forged fingerprints", async () => {
  const f = await fixture();
  await f.repair.replace(bundle, f.staging.verifiedRecord(), null);
  const bytes = await readFile(f.path(RUNTIME_BACKUP_INVENTORY));
  expect(parseRuntimeBackupInventory(bytes)).toHaveLength(2);
  const valid = JSON.parse(bytes.toString());
  for (const alter of [
    (row: typeof valid) => {
      row.entries[1].path = "../user-source.wav";
    },
    (row: typeof valid) => {
      row.entries.push({ ...row.entries[1], path: "OLD.EXE" });
    },
    (row: typeof valid) => {
      row.entries[1].birth.fileId = "0";
    },
    (row: typeof valid) => {
      row.entries[1].bytes = 16 * 1024 ** 3 + 1;
    },
    (row: typeof valid) => {
      row.entries[1].sha256 = "pretend checksum";
    },
    (row: typeof valid) => {
      row.entries[1].path = "other/old.exe";
    },
    (row: typeof valid) => {
      row.entries[1].extra = true;
    },
    (row: typeof valid) => {
      row.extra = true;
    },
  ]) {
    const row = structuredClone(valid);
    alter(row);
    expect(() =>
      parseRuntimeBackupInventory(Buffer.from(JSON.stringify(row))),
    ).toThrow("INTEGRITY_INVALID");
  }
  expect(() =>
    parseRuntimeBackupInventory(Buffer.alloc(16 * 1024 ** 2 + 1)),
  ).toThrow("INTEGRITY_INVALID");
});
it("native cleanup receives exact raw protected bytes, not normalized JSON, only after installed activation", async () => {
  const f = await fixture();
  await f.repair.replace(bundle, f.staging.verifiedRecord(), null);
  await f.repair.activated(bundle);
  const raw = Buffer.from(
    JSON.stringify(
      JSON.parse(f.vault.get(RUNTIME_REPAIR_KEY)!.toString()),
      null,
      2,
    ),
  );
  f.vault.set(RUNTIME_REPAIR_KEY, raw);
  const remove = vi.fn(async (target: string, digest: string) => {
    expect(target).toBe(bundle.targetIdentity);
    expect(digest).toBe(createHash("sha256").update(raw).digest("hex"));
    await rm(f.path(RUNTIME_BACKUP_PATH), { recursive: true });
    await unlink(f.path(RUNTIME_BACKUP_INVENTORY));
    f.vault.delete(RUNTIME_REPAIR_KEY);
    return { state: "completed" as const };
  });
  Object.assign(f.native, { removeRuntimeRepairBackup: remove });
  await f.repair.cleanupBackup(bundle);
  expect(f.repair.cleanupPending()).toBe(false);
  expect(await f.repair.blocksReady()).toBe(false);
  expect(remove).toHaveBeenCalledOnce();
});
it("partial native deleting state stays busy and retries via native authority rather than demanding the original full old tree", async () => {
  const f = await fixture();
  await f.repair.replace(bundle, f.staging.verifiedRecord(), null);
  await f.repair.activated(bundle);
  const digests: string[] = [],
    remove = vi.fn(async (_target: string, digest: string) => {
      expect(digest).toBe(
        createHash("sha256")
          .update(f.vault.get(RUNTIME_REPAIR_KEY)!)
          .digest("hex"),
      );
      digests.push(digest);
      if (digests.length === 1) {
        const row = JSON.parse(f.vault.get(RUNTIME_REPAIR_KEY)!.toString());
        row.phase = "deleting";
        f.vault.set(RUNTIME_REPAIR_KEY, Buffer.from(JSON.stringify(row)));
        await unlink(f.path(`${RUNTIME_BACKUP_PATH}\\old.exe`));
        return { state: "pending" as const };
      }
      await rm(f.path(RUNTIME_BACKUP_PATH), { recursive: true });
      await unlink(f.path(RUNTIME_BACKUP_INVENTORY));
      f.vault.delete(RUNTIME_REPAIR_KEY);
      return { state: "completed" as const };
    });
  Object.assign(f.native, { removeRuntimeRepairBackup: remove });
  await expect(f.repair.cleanupBackup(bundle)).rejects.toThrow("BUSY");
  expect(f.repair.cleanupPending()).toBe(true);
  expect(await f.repair.blocksReady()).toBe(true);
  await f.repair.recover(bundle);
  expect(f.repair.cleanupPending()).toBe(false);
  expect(digests[0]).not.toBe(digests[1]);
  expect(await readFile(f.path(`${f.canonical}\\new.exe`), "utf8")).toBe(
    "verified fixture only",
  );
});
it("lost native completion ACK needs the protected completion certificate even after backup/sidecar/WAL are absent", async () => {
  const f = await fixture();
  await f.repair.replace(bundle, f.staging.verifiedRecord(), null);
  await f.repair.activated(bundle);
  let protectedDigest: string | undefined;
  const remove = vi.fn(async (_target: string, digest: string) => {
    if (!protectedDigest) {
      protectedDigest = digest;
      await rm(f.path(RUNTIME_BACKUP_PATH), { recursive: true });
      await unlink(f.path(RUNTIME_BACKUP_INVENTORY));
      f.vault.delete(RUNTIME_REPAIR_KEY);
      throw new Error("COMPLETION_ACK_LOST");
    }
    expect(digest).toBe(protectedDigest);
    return { state: "completed" as const };
  });
  Object.assign(f.native, { removeRuntimeRepairBackup: remove });
  await expect(f.repair.cleanupBackup(bundle)).rejects.toThrow(
    "COMPLETION_ACK_LOST",
  );
  expect(f.repair.cleanupPending()).toBe(true);
  remove.mockRejectedValueOnce(new Error("completion certificate unavailable"));
  await expect(f.repair.recover(bundle)).rejects.toThrow(
    "completion certificate unavailable",
  );
  expect(f.repair.cleanupPending()).toBe(true);
  await f.repair.recover(bundle);
  expect(f.repair.cleanupPending()).toBe(false);
  expect(remove).toHaveBeenCalledTimes(3);
});
it("a completed claim without actual protected record/path retirement never clears activity or permits a second replacement", async () => {
  const f = await fixture();
  await f.repair.replace(bundle, f.staging.verifiedRecord(), null);
  await f.repair.activated(bundle);
  const remove = vi.fn(async () => ({ state: "completed" as const }));
  Object.assign(f.native, { removeRuntimeRepairBackup: remove });
  await expect(f.repair.cleanupBackup(bundle)).rejects.toThrow(
    "INTEGRITY_INVALID",
  );
  expect(f.repair.cleanupPending()).toBe(true);
  expect(
    await readFile(f.path(`${RUNTIME_BACKUP_PATH}\\old.exe`), "utf8"),
  ).toBe("damaged private bytes");
});
