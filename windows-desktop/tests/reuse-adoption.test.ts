import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((p) => p.replaceAll("\\", "/"))),
    },
  };
});
import { WindowsGuestAdoption } from "../src/main/reuse/guest-adoption.js";
import { WindowsGuestCredentialStore } from "../src/main/reuse/guest-credentials.js";
import type { HostContext } from "../src/main/host-context.js";
import { receiptFixture } from "./reuse-fixtures.js";
import { WindowsStorageWriteJournal } from "../src/main/storage/write-journal.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-reuse-code-"));
  roots.push(root);
  const f = receiptFixture(),
    bytes = Buffer.from("synthetic original"),
    voice = Buffer.from("synthetic voice");
  for (const [name, data] of [
    ["input.m4a", bytes],
    ["voice.mp3", voice],
  ] as const)
    await writeFile(join(root, name), data);
  const source = await open(join(root, "input.m4a"), "r"),
    vocal = await open(join(root, "voice.mp3"), "r");
  const held = new Set<string>();
  const host = {
    personalRoot: root,
    report: { installationId: f.completion.installationId },
    directory: async (relative: string) => {
      const path = join(root, relative.replaceAll("\\", "/"));
      await mkdir(path, { recursive: true });
      return path;
    },
    native: {
      ...privateFileNativeFixture((relative) =>
        join(root, relative.replaceAll("\\", "/")),
      ),
      validatePath: async (_space: string, relative: string, kind: string) => {
        const path = join(root, relative.replaceAll("\\", "/"));
        if (kind === "absent") {
          try {
            await lstat(path);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
            throw e;
          }
          throw new Error("PATH_EXISTS");
        }
        const stat = await lstat(path);
        if (
          stat.isSymbolicLink() ||
          (kind === "file" && (!stat.isFile() || stat.nlink !== 1)) ||
          (kind === "directory" && !stat.isDirectory())
        )
          throw new Error("PATH_UNSAFE");
      },
      acquireMutex: async (scope: string) => {
        if (held.has(scope)) return null;
        held.add(scope);
        return { scope, nonce: randomUUID() };
      },
      releaseMutex: async (lease: { scope: string }) => {
        held.delete(lease.scope);
      },
      processIdentity: async (pid: number) =>
        pid === process.pid ? writer : null,
    },
  } as unknown as HostContext;
  const writer = {
    sid: "S-1-5-21-100-200-300-1001",
    sessionId: 1,
    pid: process.pid,
    creationTime: "1000",
  };
  Object.assign(host, { identity: { ...writer, pid: 9999 } });
  const journal = new WindowsStorageWriteJournal(host, async (pid) =>
    pid === process.pid ? writer : null,
  );
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex"),
    release = vi.fn(async () => {}),
    remember = vi.fn(async () => "local:fixture"),
    validate = vi.fn(async () => {});
  const original = {
      file: source,
      extension: "m4a",
      declaration: {
        ...f.entry.original,
        bytes: bytes.length,
        sha256: hash(bytes),
      },
    },
    vocals = {
      file: vocal,
      extension: "mp3",
      declaration: {
        ...f.entry.vocals,
        bytes: voice.length,
        sha256: hash(voice),
      },
    };
  const receipt = {
    ...f.reuse,
    originalSha256: hash(bytes),
    vocalsSha256: hash(voice),
  };
  const adoption = new WindowsGuestAdoption({
    host,
    store: { rememberPersonal: remember },
    admission: {
      beginWrite: async (relative, kind) => {
        const row = await journal.beginOwned(relative, kind);
        return {
          captureCreated: (birth, relative) =>
            journal.captureCreatedOwned(row, birth, relative),
          preparePublish: (path, metadata, temporary, sha) =>
            journal.preparePublishOwned(row, path, metadata, temporary, sha),
          handoff: () => journal.handoffOwned(row),
          settle: () => journal.finishOwned(row),
        };
      },
      protectTree: vi.fn(async () => ({ release })),
      reserveVoice: vi.fn(async () => ({ release })),
    },
    validate,
  });
  return {
    root,
    host,
    original,
    vocals,
    receipt,
    release,
    remember,
    validate,
    adoption,
    close: async () => {
      await source.close();
      await vocal.close();
    },
  };
}
describe("verified immutable guest adoption and protected capabilities", () => {
  it("copies exact bytes, fsyncs private pair and adopts existing guest Library without touching sources", async () => {
    const h = await fixture();
    try {
      const result = await h.adoption.adopt(
        h.receipt,
        h.original,
        h.vocals,
        new AbortController().signal,
        () => {},
      );
      const directory = join(
          h.root,
          "personal",
          "results",
          result.entry.personalJobId,
        ),
        raw = JSON.parse(await readFile(join(directory, "pair.json"), "utf8"));
      expect(raw.reuseReceipt).toEqual(h.receipt);
      expect(raw.completionReceipt).toBeUndefined();
      expect(await readFile(join(h.root, "input.m4a"), "utf8")).toBe(
        "synthetic original",
      );
      expect(h.remember).toHaveBeenCalledWith(result.view, null);
      expect(h.validate).toHaveBeenCalledOnce();
      expect(h.release).toHaveBeenCalledTimes(2);
    } finally {
      await h.close();
    }
  });
  it("rejects changed/corrupt descriptor and leaves no playable or partial artifact", async () => {
    const h = await fixture();
    try {
      h.vocals.declaration.sha256 = "a".repeat(64);
      h.receipt.vocalsSha256 = "a".repeat(64);
      await expect(
        h.adoption.adopt(
          h.receipt,
          h.original,
          h.vocals,
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow("REUSE_ARTIFACT_INVALID");
      expect(h.remember).not.toHaveBeenCalled();
      expect(await readdir(join(h.root, "personal", "results"))).toEqual([]);
      expect(await readFile(join(h.root, "voice.mp3"), "utf8")).toBe(
        "synthetic voice",
      );
    } finally {
      await h.close();
    }
  });
  it("stores only bounded validated guest capability inside current-user DPAPI vault", async () => {
    let bytes: Buffer | null = null;
    const write = vi.fn(async (_space: string, _key: string, next: Buffer) => {
      bytes = next;
    });
    const store = new WindowsGuestCredentialStore({
      native: { vaultRead: async () => bytes, vaultWrite: write },
    } as unknown as HostContext);
    const credential = {
      token: "a".repeat(43),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    };
    await store.save(credential);
    expect(await store.load()).toEqual(credential);
    expect(write).toHaveBeenCalledWith(
      "account",
      "youtube_guest",
      expect.any(Buffer),
    );
    await expect(
      store.save({ ...credential, token: "secret\n" }),
    ).rejects.toThrow("GUEST_CREDENTIALS_UNAVAILABLE");
    bytes = Buffer.alloc(4097);
    await expect(store.load()).rejects.toThrow("GUEST_CREDENTIALS_UNAVAILABLE");
  });
});
