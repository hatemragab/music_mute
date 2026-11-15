import { privateFileNativeFixture } from "./private-file-port-fixture.js";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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
vi.mock(
  "../../chrome-extension/src/shared/strict-json.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../chrome-extension/src/shared/strict-json.js")
      >();
    return { ...actual, parseStrictJson: vi.fn(actual.parseStrictJson) };
  },
);
import { parseStrictJson } from "../../chrome-extension/src/shared/strict-json.js";
import type { HostContext } from "../src/main/host-context.js";
import type { TrustedLibraryArtifact } from "../src/main/library/artifacts.js";
import {
  LibraryPins,
  parseStorageAccessIndex,
} from "../src/main/library/pins.js";
import { WindowsStorageInventory } from "../src/main/storage/inventory.js";

const roots: string[] = [],
  corruptIndexes: [string, Buffer][] = [
    ["malformed JSON", Buffer.from("{")],
    ["null root", Buffer.from("null")],
    ["array root", Buffer.from("[]")],
    ["scalar root", Buffer.from("7")],
    ["missing schema", Buffer.from("{}")],
    ["null entries", Buffer.from('{"version":1,"entries":null}')],
    ["null entry", Buffer.from('{"version":1,"entries":[null]}')],
    ["array entry", Buffer.from('{"version":1,"entries":[[]]}')],
    ["scalar entry", Buffer.from('{"version":1,"entries":[7]}')],
    ["missing path", Buffer.from('{"version":1,"entries":[{"at":1}]}')],
    [
      "invalid path",
      Buffer.from(
        '{"version":1,"entries":[{"at":1,"relativePath":"../voice.mp3"}]}',
      ),
    ],
    [
      "aliased path",
      Buffer.from(
        '{"version":1,"entries":[{"at":1,"relativePath":"voice.mp3."}]}',
      ),
    ],
    [
      "invalid timestamp",
      Buffer.from(
        '{"version":1,"entries":[{"at":-1,"relativePath":"voice.mp3"}]}',
      ),
    ],
    [
      "unexpected property",
      Buffer.from('{"version":1,"entries":[],"extra":true}'),
    ],
    [
      "duplicate paths",
      Buffer.from(
        '{"version":1,"entries":[{"at":1,"relativePath":"voice.mp3"},{"at":2,"relativePath":"voice.mp3"}]}',
      ),
    ],
    [
      "case aliases",
      Buffer.from(
        '{"version":1,"entries":[{"at":1,"relativePath":"voice.mp3"},{"at":2,"relativePath":"VOICE.mp3"}]}',
      ),
    ],
    [
      "duplicate decoded root key",
      Buffer.from('{"version":1,"\\u0076ersion":1,"entries":[]}'),
    ],
    [
      "duplicate entry key",
      Buffer.from(
        '{"version":1,"entries":[{"at":1,"at":2,"relativePath":"voice.mp3"}]}',
      ),
    ],
    [
      "invalid UTF-8",
      Buffer.concat([
        Buffer.from('{"version":1,"entries":[{"at":1,"relativePath":"voice'),
        Buffer.from([0xff]),
        Buffer.from('.mp3"}]}'),
      ]),
    ],
  ];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-pins-lru-code-"));
  roots.push(root);
  const identity = {
      sid: "S-1-5-21-100-200-300-1001",
      sessionId: 1,
      pid: process.pid,
      creationTime: "1000",
    },
    held = new Set<string>(),
    path = (relative: string) => join(root, relative.replaceAll("\\", "/")),
    processIdentity = vi.fn(async (pid: number) =>
      pid === process.pid ? identity : null,
    ),
    native = {
      ...privateFileNativeFixture(path),
      processIdentity,
      acquireMutex: vi.fn(async (scope: string) => {
        if (held.has(scope)) return null;
        held.add(scope);
        return { scope, nonce: randomUUID(), identity };
      }),
      releaseMutex: vi.fn(async (lease: { scope: string }) => {
        held.delete(lease.scope);
      }),
      validatePath: vi.fn(
        async (_namespace: string, relative: string, kind: string) => {
          if (kind === "absent") {
            try {
              await lstat(path(relative));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
              throw error;
            }
            throw new Error("PATH_EXISTS");
          }
          const stat = await lstat(path(relative));
          if (
            stat.isSymbolicLink() ||
            (kind === "file" && (!stat.isFile() || stat.nlink !== 1)) ||
            (kind === "directory" && !stat.isDirectory())
          )
            throw new Error("PATH_UNSAFE");
        },
      ),
    },
    host = {
      personalRoot: root,
      identity,
      native,
      directory: async (relative: string) => {
        await mkdir(path(relative), { recursive: true, mode: 0o700 });
        return path(relative);
      },
    } as unknown as HostContext,
    relativePath = `personal\\results\\${randomUUID()}\\vocals.mp3`,
    artifact: TrustedLibraryArtifact = {
      relativePath,
      artifactId: randomUUID(),
      sha256: "a".repeat(64),
      bytes: 7,
      durationSeconds: 1,
      mime: "audio/mpeg",
    },
    pins = new LibraryPins(host, processIdentity),
    inventory = new WindowsStorageInventory(host, async () => true);
  await host.directory(relativePath.slice(0, relativePath.lastIndexOf("\\")));
  await writeFile(path(relativePath), "fixture");
  await host.directory("storage");
  return {
    root,
    path,
    host,
    native,
    processIdentity,
    pins,
    artifact,
    inventory,
  };
}

describe("advisory Library access index (filesystem fixtures)", () => {
  it.each(corruptIndexes)(
    "normalizes %s without changing evidence",
    (_label, bytes) => {
      expect(() => parseStorageAccessIndex(bytes)).toThrow(
        "STORAGE_ACCESS_INVALID",
      );
    },
  );

  it.each(["playback", "export"] as const)(
    "persists the %s pin despite corrupt LRU metadata, while inventory fails closed",
    async (purpose) => {
      const f = await fixture();
      for (const [, bytes] of corruptIndexes) {
        await writeFile(f.path("storage\\access.json"), bytes);
        const pin = await f.pins.pin(f.artifact, purpose),
          registry = JSON.parse(
            await readFile(f.path("library\\pins.json"), "utf8"),
          );
        expect(registry.pins).toHaveLength(1);
        expect(registry.pins[0]).toMatchObject({
          relativePath: f.artifact.relativePath,
          purpose,
          owner: { pid: process.pid, creationTime: "1000" },
        });
        await expect(
          f.pins.assertUnpinned(f.artifact.relativePath),
        ).rejects.toThrow("LIBRARY_MEDIA_PINNED");
        await expect(
          f.inventory.scan(new AbortController().signal),
        ).rejects.toThrow("STORAGE_ACCESS_INVALID");
        expect(await readFile(f.path("storage\\access.json"))).toEqual(bytes);
        await pin.release();
        expect(await f.pins.hasLiveConsumers()).toBe(false);
        expect(await readFile(f.path("storage\\access.json"))).toEqual(bytes);
      }
    },
  );

  it("supports all 4096 valid entries and updates only the bounded LRU index", async () => {
    const f = await fixture(),
      entries = Array.from({ length: 4096 }, (_, index) => ({
        relativePath: `cache\\voice-${String(index).padStart(4, "0")}\\vocals.mp3`,
        at: index,
      })),
      bytes = Buffer.from(JSON.stringify({ version: 1, entries }));
    expect(parseStorageAccessIndex(bytes)).toEqual(entries);
    await writeFile(f.path("storage\\access.json"), bytes);
    const pin = await f.pins.pin(f.artifact),
      after = parseStorageAccessIndex(
        await readFile(f.path("storage\\access.json")),
      );
    expect(after).toHaveLength(4096);
    expect(after[0]?.relativePath).toBe(f.artifact.relativePath);
    expect(
      after.some((entry) => entry.relativePath === entries[0]!.relativePath),
    ).toBe(false);
    expect(
      after.some((entry) => entry.relativePath === entries[4095]!.relativePath),
    ).toBe(true);
    await pin.release();
  });

  it("rejects a 4097-entry index instead of silently truncating corrupt metadata", async () => {
    const f = await fixture(),
      bytes = Buffer.from(
        JSON.stringify({
          version: 1,
          entries: Array.from({ length: 4097 }, (_, index) => ({
            relativePath: `cache\\${index}\\vocals.mp3`,
            at: index,
          })),
        }),
      );
    expect(() => parseStorageAccessIndex(bytes)).toThrow(
      "STORAGE_ACCESS_INVALID",
    );
    await writeFile(f.path("storage\\access.json"), bytes);
    const pin = await f.pins.pin(f.artifact, "export");
    expect(await readFile(f.path("storage\\access.json"))).toEqual(bytes);
    await pin.release();
  });

  it("replaces the existing case alias on a successful touch", async () => {
    const f = await fixture();
    await writeFile(
      f.path("storage\\access.json"),
      JSON.stringify({
        version: 1,
        entries: [
          { relativePath: f.artifact.relativePath.toUpperCase(), at: 1 },
        ],
      }),
    );
    const pin = await f.pins.pin(f.artifact),
      entries = parseStorageAccessIndex(
        await readFile(f.path("storage\\access.json")),
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.relativePath).toBe(f.artifact.relativePath);
    await pin.release();
  });

  it.each(["PATH_UNSAFE", "STORAGE_ACCESS_INVALID", "ENOENT"])(
    "does not swallow the access read ownership/I/O failure %s",
    async (message) => {
      const f = await fixture(),
        failure = Object.assign(new Error(message), { code: message }),
        open = f.native.openPrivateFile;
      await writeFile(f.path("storage\\access.json"), "{");
      Object.assign(f.host.native, {
        openPrivateFile: async (
          relative: string,
          mode: "read",
          maximum: number,
        ) => {
          if (mode !== "read") throw new Error("fixture-unused");
          if (relative === "storage\\access.json") throw failure;
          return open(relative, mode, maximum);
        },
      });
      await expect(f.pins.pin(f.artifact)).rejects.toBe(failure);
      await expect(lstat(f.path("library\\pins.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(f.path("storage\\access.json"), "utf8")).toBe("{");
    },
  );

  it("does not swallow a corrupt pin registry or a missing process owner", async () => {
    const f = await fixture();
    await f.host.directory("library");
    await writeFile(f.path("library\\pins.json"), "null");
    await writeFile(f.path("storage\\access.json"), "{");
    await expect(f.pins.pin(f.artifact)).rejects.toThrow(
      "LIBRARY_PINS_INVALID",
    );
    expect(await readFile(f.path("library\\pins.json"), "utf8")).toBe("null");
    await writeFile(f.path("library\\pins.json"), '{"version":1,"pins":[]}');
    f.processIdentity.mockResolvedValue(null);
    await expect(f.pins.pin(f.artifact)).rejects.toThrow(
      "LIBRARY_PIN_OWNER_INVALID",
    );
    expect(
      JSON.parse(await readFile(f.path("library\\pins.json"), "utf8")).pins,
    ).toEqual([]);
  });

  it("does not report a pin after pin-registry persistence fails", async () => {
    const f = await fixture(),
      failure = new Error("EACCES"),
      validate = f.native.validatePath.getMockImplementation()!;
    await writeFile(f.path("storage\\access.json"), "{");
    f.native.validatePath.mockImplementation(
      async (namespace, relative, kind) => {
        if (relative === "library\\pins.json.atomic.tmp") throw failure;
        return validate(namespace, relative, kind);
      },
    );
    await expect(f.pins.pin(f.artifact, "export")).rejects.toBe(failure);
    await expect(lstat(f.path("library\\pins.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(f.path("storage\\access.json"), "utf8")).toBe("{");
  });

  it("does not swallow advisory index write failures", async () => {
    const f = await fixture(),
      failure = new Error("PATH_UNSAFE"),
      validate = f.native.validatePath.getMockImplementation()!;
    await writeFile(
      f.path("storage\\access.json"),
      '{"version":1,"entries":[]}',
    );
    f.native.validatePath.mockImplementation(
      async (namespace, relative, kind) => {
        if (relative === "storage\\access.json.atomic.tmp") throw failure;
        return validate(namespace, relative, kind);
      },
    );
    await expect(f.pins.pin(f.artifact)).rejects.toBe(failure);
    await expect(lstat(f.path("library\\pins.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("access-index data property validation", () => {
  it("persists a pin without evaluating an advisory metadata accessor", async () => {
    const f = await fixture(),
      bytes = Buffer.from('{"version":1,"entries":[]}'),
      getter = vi.fn(() => {
        throw new Error("getter evaluated");
      }),
      row = Object.defineProperty({ version: 1 }, "entries", {
        enumerable: true,
        get: getter,
      });
    await writeFile(f.path("storage\\access.json"), bytes);
    vi.mocked(parseStrictJson).mockReturnValueOnce(row);
    const pin = await f.pins.pin(f.artifact, "export");
    expect(getter).not.toHaveBeenCalled();
    expect(await readFile(f.path("storage\\access.json"))).toEqual(bytes);
    expect(await f.pins.hasLiveConsumers()).toBe(true);
    await pin.release();
  });

  it("rejects accessors at each level without evaluating them", () => {
    const getter = vi.fn(() => {
        throw new Error("getter evaluated");
      }),
      root = Object.defineProperty({ version: 1 }, "entries", {
        enumerable: true,
        get: getter,
      }),
      entries = Object.defineProperty([undefined], "0", {
        enumerable: true,
        get: getter,
      }),
      entry = Object.defineProperty({ at: 1 }, "relativePath", {
        enumerable: true,
        get: getter,
      });
    for (const value of [
      root,
      { version: 1, entries },
      { version: 1, entries: [entry] },
    ]) {
      vi.mocked(parseStrictJson).mockReturnValueOnce(value);
      expect(() => parseStorageAccessIndex(Buffer.from("{}"))).toThrow(
        "STORAGE_ACCESS_INVALID",
      );
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects inherited, symbol, sparse and aliased runtime values", () => {
    const entry = { at: 1, relativePath: "voice.mp3" },
      inherited = Object.create({ version: 1, entries: [] }),
      symbol = { version: 1, entries: [], [Symbol("extra")]: true },
      sparse: unknown[] = [];
    sparse.length = 1;
    for (const value of [
      inherited,
      symbol,
      { version: 1, entries: sparse },
      { version: 1, entries: [entry, entry] },
    ]) {
      vi.mocked(parseStrictJson).mockReturnValueOnce(value);
      expect(() => parseStorageAccessIndex(Buffer.from("{}"))).toThrow(
        "STORAGE_ACCESS_INVALID",
      );
    }
  });
});
