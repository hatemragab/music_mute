import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type { StorePreparationOperations } from "../src/main/prepare/store-operations.js";
import type {
  ConsumerFileBirth,
  PrivateWritable,
} from "../../worker/src/platform/windows/consumer-native.js";

// Receiving/transfer tests only. Synthetic owners never establish an installed
// Store package, native Windows filesystem authority or GPU qualification.
const owners = vi.hoisted(() => {
  class Operations {
    #host: object;
    #view: unknown;
    alive = true;
    views = 0;
    constructor(host: object, view: unknown) {
      this.#host = host;
      this.#view = view;
    }
    assertHost(host: object) {
      if (host !== this.#host || !this.alive) throw Error("OWNER_DENIED");
    }
    async mediaCodeView(signal: AbortSignal) {
      signal.throwIfAborted();
      if (!this.alive) throw Error("OWNER_DENIED");
      this.views++;
      return this.#view;
    }
  }
  return { Operations };
});
vi.mock("../src/main/prepare/store-operations.js", () => ({
  StorePreparationOperations: owners.Operations,
}));
import { downloadStoreQualificationFixture } from "../src/main/fleet/store-fixture-transfer.js";

const bytes = Buffer.alloc(256, 7);
bytes.write("RIFF");
bytes.writeUInt32LE(bytes.length - 8, 4);
bytes.write("WAVEfmt ", 8);
const sha = createHash("sha256").update(bytes).digest("hex"),
  relative = `prepare\\approved\\${sha}.wav`,
  key = `prepare_fixture_${sha.slice(0, 48)}`;
function fixture() {
  const state = {
      exists: false,
      bytes: Buffer.alloc(0),
      birth: { device: "8", fileId: "10", bornAt: "101" },
      changed: 1,
      readCloses: 0,
      writerCloses: 0,
      writerCloseFailure: undefined as Error | undefined,
      readCloseFailure: undefined as Error | undefined,
    },
    vault = new Map<string, Buffer>(),
    view = {
      binding: {
        sid: "S-1-5-21-1-2-3-1000",
        inventorySha256: "a".repeat(64),
        runtimeManifestSha256: "b".repeat(64),
        bootIdentity: "c".repeat(64),
        package: { fullName: "MusicMuteWorker_0.1.3.0_x64__fixture" },
      },
    };
  function file(writable: boolean): PrivateWritable {
    let closed = false;
    const info = async () => {
      if (closed) throw Error("CLOSED_FILE");
      return {
        ...state.birth,
        bytes: state.bytes.length,
        writtenAt: String(state.changed),
        changedAt: String(state.changed),
      };
    };
    return {
      info,
      read: async (target, offset, length, position) => {
        await info();
        const part = state.bytes.subarray(position, position + length);
        target.set(part, offset);
        return { bytesRead: part.length };
      },
      async *chunks() {
        await info();
        yield Buffer.from(state.bytes);
      },
      write: async (source, offset, length, position = 0) => {
        await info();
        if (!writable) throw Error("READ_ONLY");
        const next = Buffer.alloc(
          Math.max(state.bytes.length, position + length),
        );
        next.set(state.bytes);
        next.set(source.subarray(offset, offset + length), position);
        state.bytes = next;
        state.changed++;
        return { bytesWritten: length };
      },
      writeFile: async () => {
        throw Error("UNEXPECTED_WRITE_FILE");
      },
      truncate: async (length) => {
        await info();
        if (!writable) throw Error("READ_ONLY");
        state.bytes = Buffer.from(state.bytes.subarray(0, length));
        state.changed++;
      },
      sync: async () => {
        await info();
      },
      close: async () => {
        if (closed) throw Error("REPLAYED_CLOSE");
        closed = true;
        if (writable) {
          state.writerCloses++;
          if (state.writerCloseFailure) throw state.writerCloseFailure;
        } else {
          state.readCloses++;
          if (state.readCloseFailure) throw state.readCloseFailure;
        }
      },
    };
  }
  const native = {
      openPrivateFile: vi.fn(async (path, mode, maximum) => {
        expect([path, mode, maximum]).toEqual([relative, "read", bytes.length]);
        if (state.bytes.length > maximum) throw Error("NATIVE_BOUND_DENIED");
        return state.exists ? file(false) : null;
      }),
      openStoreFixtureFile: vi.fn(
        async (path, maximum, expected?: ConsumerFileBirth) => {
          expect([path, maximum]).toEqual([relative, bytes.length]);
          if (expected) {
            if (
              !state.exists ||
              JSON.stringify(expected) !== JSON.stringify(state.birth)
            )
              throw Error("NATIVE_BIRTH_DENIED");
          } else {
            if (state.exists) throw Error("NATIVE_CREATE_NEW_DENIED");
            state.exists = true;
          }
          return file(true);
        },
      ),
      vaultRead: vi.fn(async (scope, entry) => {
        expect([scope, entry]).toEqual(["account", key]);
        return vault.get(entry) ?? null;
      }),
      vaultWrite: vi.fn(async (scope, entry, value: Buffer) => {
        expect([scope, entry]).toEqual(["account", key]);
        expect(value.length).toBeLessThanOrEqual(4096);
        vault.set(entry, Buffer.from(value));
      }),
      vaultDelete: vi.fn(async (scope, entry) => {
        expect([scope, entry]).toEqual(["account", key]);
        vault.delete(entry);
      }),
    },
    host = {
      native,
      identity: { sid: view.binding.sid },
      directory: vi.fn(async (path) => {
        expect(path).toBe("prepare\\approved");
      }),
    } as unknown as HostContext,
    operations = new owners.Operations(host, view),
    grant = {
      filename: "qualification.wav",
      bytes: bytes.length,
      sha256: sha,
      contentType: "audio/wav",
      url: "https://fixture.invalid/approved.wav?grant=current",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  return {
    state,
    vault,
    view,
    native,
    host,
    operations,
    grant,
    transfer: (fetcher?: typeof fetch, signal = new AbortController().signal) =>
      downloadStoreQualificationFixture({
        host,
        operations: operations as unknown as StorePreparationOperations,
        fixture: grant,
        signal,
        ...(fetcher ? { fetch: fetcher } : {}),
      }),
  };
}
function response(body = bytes, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "audio/wav",
      "content-length": String(body.length),
      etag: '"approved-fixture"',
      ...extra,
    },
  });
}
function interrupted() {
  let reads = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (reads++ === 0) controller.enqueue(bytes.subarray(0, 80));
          else controller.error(new Error("network interruption"));
        },
      },
      { highWaterMark: 0 },
    ),
    {
      headers: {
        "content-type": "audio/wav",
        "content-length": String(bytes.length),
        etag: '"approved-fixture"',
      },
    },
  );
}
afterEach(() => vi.useRealTimers());
describe("Store approved fixture retained-handle transfer", () => {
  it("uses only the fixed native create-new leaf and clears its encrypted checkpoint after verified bytes and original close", async () => {
    const f = fixture(),
      fetcher = vi.fn(async (url, init) => {
        expect(String(url)).toBe(f.grant.url);
        expect(init).toMatchObject({
          method: "GET",
          credentials: "omit",
          redirect: "error",
        });
        expect(init.headers).toMatchObject({
          Accept: "audio/wav",
          "Accept-Encoding": "identity",
        });
        return response();
      });
    await expect(f.transfer(fetcher as typeof fetch)).resolves.toEqual({
      relativePath: relative,
      bytes: bytes.length,
      sha256: sha,
    });
    expect(f.state.bytes).toEqual(bytes);
    expect(f.state.writerCloses).toBe(1);
    expect(f.native.openStoreFixtureFile).toHaveBeenCalledWith(
      relative,
      bytes.length,
      undefined,
    );
    expect(f.native.vaultDelete).toHaveBeenCalledTimes(1);
    expect(f.vault.size).toBe(0);
    expect(key.length).toBe(64);
    expect(f.operations.views).toBeGreaterThanOrEqual(4);
  });
  it("reuses only a fully rehashed original read handle, including after a package update, without any writer or network", async () => {
    const f = fixture();
    f.state.exists = true;
    f.state.bytes = Buffer.from(bytes);
    f.vault.set(key, Buffer.from("old checkpoint from earlier inventory"));
    const fetcher = vi.fn();
    await expect(f.transfer(fetcher)).resolves.toMatchObject({ sha256: sha });
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.native.openStoreFixtureFile).not.toHaveBeenCalled();
    expect(f.native.vaultRead).not.toHaveBeenCalled();
    expect(f.state.readCloses).toBe(1);
  });
  it("preserves an existing corrupt full leaf and closes its reader without opening a writer", async () => {
    const f = fixture();
    f.state.exists = true;
    f.state.bytes = Buffer.alloc(bytes.length, 9);
    const before = Buffer.from(f.state.bytes),
      fetcher = vi.fn();
    await expect(f.transfer(fetcher)).rejects.toThrow("INTEGRITY_INVALID");
    expect(f.state.bytes).toEqual(before);
    expect(f.state.readCloses).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.native.openStoreFixtureFile).not.toHaveBeenCalled();
  });
  it("retains an interrupted exact-birth prefix and resumes with a fresh grant URL, exact ETag/range and unchanged inventory", async () => {
    const f = fixture();
    await expect(
      f.transfer((async () => interrupted()) as typeof fetch),
    ).rejects.toThrow();
    expect(f.state.bytes).toEqual(bytes.subarray(0, 80));
    const saved = f.vault.get(key)!;
    expect(JSON.parse(saved.toString())).toMatchObject({
      birth: f.state.birth,
      checkpoint: { bytes: 80, etag: '"approved-fixture"' },
    });
    expect(saved.toString()).not.toContain("https:");
    expect(saved.toString()).not.toContain("expiresAt");
    expect(f.native.vaultDelete).not.toHaveBeenCalled();
    f.grant.url = "https://fixture.invalid/approved.wav?grant=renewed";
    const fetcher = vi.fn(async (_url, init) => {
      expect(init.headers).toMatchObject({
        Range: "bytes=80-",
        "If-Range": '"approved-fixture"',
      });
      return response(bytes.subarray(80), 206, {
        "content-range": `bytes 80-${bytes.length - 1}/${bytes.length}`,
      });
    });
    await f.transfer(fetcher as typeof fetch);
    expect(f.native.openStoreFixtureFile).toHaveBeenLastCalledWith(
      relative,
      bytes.length,
      f.state.birth,
    );
    expect(f.state.bytes).toEqual(bytes);
    expect(f.state.writerCloses).toBe(2);
    expect(f.state.readCloses).toBe(1);
    expect(f.vault.size).toBe(0);
  });
  it.each(["birth", "inventory", "prefix"])(
    "refuses changed %s before append and preserves the original checkpoint",
    async (change) => {
      const f = fixture();
      await expect(
        f.transfer((async () => interrupted()) as typeof fetch),
      ).rejects.toThrow();
      const saved = Buffer.from(f.vault.get(key)!);
      if (change === "birth") f.state.birth.fileId = "11";
      if (change === "inventory")
        f.view.binding.inventorySha256 = "d".repeat(64);
      if (change === "prefix") f.state.bytes = Buffer.alloc(80, 9);
      const fetcher = vi.fn();
      await expect(f.transfer(fetcher)).rejects.toThrow("INTEGRITY_INVALID");
      expect(fetcher).not.toHaveBeenCalled();
      expect(f.vault.get(key)).toEqual(saved);
      expect(f.native.vaultDelete).not.toHaveBeenCalled();
    },
  );
  it.each(["application/zip", "audio/mpeg", ""])(
    "rejects %s MIME before any body read or native byte write",
    async (mime) => {
      const f = fixture(),
        pulled = vi.fn(),
        cancelled = vi.fn();
      const raw = new Response(
        new ReadableStream(
          { pull: pulled, cancel: cancelled },
          { highWaterMark: 0 },
        ),
        {
          headers: { "content-type": mime },
        },
      );
      await expect(
        f.transfer((async () => raw) as typeof fetch),
      ).rejects.toThrow("INTEGRITY_INVALID");
      expect(pulled).not.toHaveBeenCalled();
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(f.state.bytes.length).toBe(0);
      expect(f.vault.has(key)).toBe(true);
      expect(f.state.writerCloses).toBe(1);
    },
  );
  it("rejects redirects and a different returned URL, and never follows the grant", async () => {
    for (const make of [
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.invalid/fixture" },
        }),
      () =>
        Object.defineProperty(response(), "url", {
          value: "https://other.invalid/fixture",
        }),
      () => Object.defineProperty(response(), "redirected", { value: true }),
    ]) {
      const f = fixture(),
        fetcher = vi.fn(async () => make());
      await expect(f.transfer(fetcher as typeof fetch)).rejects.toThrow(
        "INTEGRITY_INVALID",
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(f.state.bytes.length).toBe(0);
      expect(f.state.writerCloses).toBe(1);
    }
  });
  it("retains complete data and its checkpoint when living code binding changes during the transfer", async () => {
    const f = fixture();
    await expect(
      f.transfer((async () => {
        f.view.binding.inventorySha256 = "d".repeat(64);
        return response();
      }) as typeof fetch),
    ).rejects.toThrow("INTEGRITY_INVALID");
    expect(f.state.bytes).toEqual(bytes);
    expect(f.vault.has(key)).toBe(true);
    expect(f.native.vaultDelete).not.toHaveBeenCalled();
    expect(f.state.writerCloses).toBe(1);
  });
  it("does not clear a checkpoint or report success when the original native writer fails to close", async () => {
    const f = fixture(),
      failure = new Error("actual native close uncertain");
    f.state.writerCloseFailure = failure;
    await expect(
      f.transfer((async () => response()) as typeof fetch),
    ).rejects.toBe(failure);
    expect(f.state.bytes).toEqual(bytes);
    expect(f.vault.has(key)).toBe(true);
    expect(f.native.vaultDelete).not.toHaveBeenCalled();
  });
  it("preserves both the original transfer error and failed body/native close diagnostics", async () => {
    const f = fixture(),
      bodyFailure = new Error("reader cancel uncertain"),
      nativeFailure = new Error("native close uncertain");
    f.state.writerCloseFailure = nativeFailure;
    const raw = new Response(
      new ReadableStream(
        {
          cancel: () => {
            throw bodyFailure;
          },
        },
        { highWaterMark: 0 },
      ),
      {
        headers: { "content-type": "application/zip" },
      },
    );
    const error = await f
      .transfer((async () => raw) as typeof fetch)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ code: "INTEGRITY_INVALID" }),
      bodyFailure,
      nativeFailure,
    ]);
    expect(f.vault.has(key)).toBe(true);
    expect(f.state.writerCloses).toBe(1);
  });
  it("bounds encrypted resume input and rejects duplicate decoded fields, malformed UTF8 and foreign checkpoint authority", async () => {
    const base = fixture();
    await expect(
      base.transfer((async () => interrupted()) as typeof fetch),
    ).rejects.toThrow();
    const good = base.vault.get(key)!;
    for (const bad of [
      Buffer.alloc(4097, 32),
      Buffer.from([0xff]),
      Buffer.from(
        good.toString().replace('"version":1', '"version":1,"ver\\u0073ion":1'),
      ),
      Buffer.from(
        JSON.stringify({ ...JSON.parse(good.toString()), root: "C:\\caller" }),
      ),
    ]) {
      const f = fixture();
      f.state.exists = true;
      f.state.bytes = Buffer.from(bytes.subarray(0, 80));
      f.vault.set(key, bad);
      const fetcher = vi.fn();
      await expect(f.transfer(fetcher)).rejects.toThrow("INTEGRITY_INVALID");
      expect(f.native.openStoreFixtureFile).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect(f.state.readCloses).toBe(1);
      expect(f.vault.get(key)).toEqual(bad);
    }
  });
  it("rejects forged owners, data overrides and accessor inputs before native or network effects", async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    const options = {
      host: f.host,
      operations: f.operations as unknown as StorePreparationOperations,
      fixture: f.grant,
      signal,
    };
    await expect(
      downloadStoreQualificationFixture({
        ...options,
        host: { ...f.host } as HostContext,
      }),
    ).rejects.toThrow("OWNER_DENIED");
    await expect(
      downloadStoreQualificationFixture({
        ...options,
        operations: {} as StorePreparationOperations,
      }),
    ).rejects.toThrow();
    const getter = vi.fn(() => f.grant.url),
      badGrant = Object.defineProperty({ ...f.grant }, "url", {
        enumerable: true,
        get: getter,
      });
    await expect(
      downloadStoreQualificationFixture({ ...options, fixture: badGrant }),
    ).rejects.toThrow("INTEGRITY_INVALID");
    expect(getter).not.toHaveBeenCalled();
    for (const delta of [
      { bytes: MAX_SAFE_TOO_LARGE },
      { url: "http://fixture.invalid/approved.wav" },
      { expiresAt: "2020-01-01T00:00:00.000Z" },
      { contentType: "application/zip" },
      { root: "C:\\caller" },
    ])
      await expect(
        downloadStoreQualificationFixture({
          ...options,
          fixture: { ...f.grant, ...delta },
        }),
      ).rejects.toThrow("INTEGRITY_INVALID");
    expect(f.host.directory).not.toHaveBeenCalled();
    expect(f.native.openPrivateFile).not.toHaveBeenCalled();
    expect(f.native.openStoreFixtureFile).not.toHaveBeenCalled();
  });
  it("bounds waiting for headers with the existing idle transfer budget and preserves the empty retained leaf/checkpoint", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetcher = vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          started();
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    );
    const result = f
      .transfer(fetcher as typeof fetch)
      .catch((error: unknown) => error);
    await pending;
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await result).toBeInstanceOf(Error);
    expect(f.state.writerCloses).toBe(1);
    expect(f.vault.has(key)).toBe(true);
    expect(f.state.bytes.length).toBe(0);
  });
});
const MAX_SAFE_TOO_LARGE = 64 * 1024 ** 2 + 1;
