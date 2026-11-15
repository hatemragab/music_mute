import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type { StoreWorkerCodeAuthority } from "../src/main/browser/store-native.js";
import type {
  ConsumerFileBirth,
  StoreModelWritable,
} from "../../worker/src/platform/windows/consumer-native.js";

// Synthetic receiving/transfer tests. Neither these owners nor the tiny model
// fixture establish actual Store, Windows filesystem, model or GPU authority.
const owners = vi.hoisted(() => {
  class Code {
    #native: object;
    #binding: unknown;
    alive = true;
    constructor(native: object, binding: unknown) {
      this.#native = native;
      this.#binding = binding;
    }
    assertDataNative(native: object) {
      if (native !== this.#native || !this.alive)
        throw Error("CODE_OWNER_DENIED");
    }
    async preparationBinding() {
      if (!this.alive) throw Error("CODE_OWNER_DENIED");
      return this.#binding;
    }
  }
  return { Code };
});
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreWorkerCodeAuthority: owners.Code,
}));
vi.mock("../../chrome-extension/src/shared/local-model.js", async () => {
  const { createHash } = await import("node:crypto"),
    bytes = Buffer.from("synthetic-pinned-store-model-".repeat(12));
  return {
    MODEL: Object.freeze({
      filename: "Kim_Vocal_2.onnx",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx",
    }),
  };
});
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { downloadStoreModel } from "../src/main/prepare/store-model-transfer.js";

const bytes = Buffer.from("synthetic-pinned-store-model-".repeat(12)),
  key = "prepare_model_transfer",
  relative = "models\\" + MODEL.filename + ".part";
function fixture() {
  const state = {
    partExists: false,
    part: Buffer.alloc(0),
    final: Buffer.alloc(0),
    birth: { device: "8", fileId: "10", bornAt: "101" },
    changed: 1,
    readCloses: 0,
    writerCloses: 0,
    publishes: 0,
    writes: 0,
    truncates: 0,
    readCloseFailure: undefined as Error | undefined,
    writerCloseFailure: undefined as Error | undefined,
    writeFailure: undefined as Error | undefined,
    publishFailure: undefined as Error | undefined,
    publicationOverride: undefined as object | undefined,
    events: [] as string[],
  };
  const binding = {
      sid: "S-1-5-21-1-2-3-1000",
      package: { fullName: "MusicMuteWorker_0.1.3.0_x64__fixture" },
      inventorySha256: "a".repeat(64),
      runtimeManifestSha256: "b".repeat(64),
      bootIdentity: "c".repeat(64),
      recipeDigests: { "recipe-a": "d".repeat(64) },
    },
    vault = new Map<string, Buffer>();
  function file(writable: boolean): StoreModelWritable {
    let closed = false,
      sealed = false;
    const originalBirth = { ...state.birth };
    const info = async () => {
      if (closed) throw Error("ORIGINAL_FILE_CLOSED");
      if (JSON.stringify(originalBirth) !== JSON.stringify(state.birth))
        throw Error("NATIVE_HELD_BIRTH_CHANGED");
      return {
        ...originalBirth,
        bytes: state.part.length,
        writtenAt: String(state.changed),
        changedAt: String(state.changed),
      };
    };
    const writeAllowed = async () => {
      await info();
      if (!writable || sealed) throw Error("NATIVE_WRITE_DENIED");
    };
    return {
      info,
      read: async (target, offset, length, position) => {
        await info();
        const part = state.part.subarray(position, position + length);
        target.set(part, offset);
        return { bytesRead: part.length };
      },
      async *chunks() {
        await info();
        yield Buffer.from(state.part);
      },
      write: async (source, offset, length, position = 0) => {
        await writeAllowed();
        if (state.writeFailure) throw state.writeFailure;
        const next = Buffer.alloc(
          Math.max(state.part.length, position + length),
        );
        next.set(state.part);
        next.set(source.subarray(offset, offset + length), position);
        state.part = next;
        state.changed++;
        state.writes++;
        return { bytesWritten: length };
      },
      writeFile: async () => {
        throw Error("UNEXPECTED_WRITE_FILE");
      },
      truncate: async (length) => {
        await writeAllowed();
        state.truncates++;
        state.part = Buffer.from(state.part.subarray(0, length));
        state.changed++;
      },
      sync: async () => {
        await writeAllowed();
      },
      publish: async () => {
        await writeAllowed();
        sealed = true;
        state.events.push("publish");
        state.publishes++;
        if (state.publishFailure) throw state.publishFailure;
        expect(state.writerCloses).toBe(0);
        expect(state.part).toEqual(bytes);
        const identity = await info();
        state.final = Buffer.from(state.part);
        state.partExists = false;
        return (state.publicationOverride ?? {
          version: 1,
          state: "published",
          identity,
          sha256: MODEL.sha256,
          bytes: MODEL.bytes,
          backupRelativePath: null,
        }) as Awaited<ReturnType<StoreModelWritable["publish"]>>;
      },
      close: async () => {
        if (closed) throw Error("REPLAYED_ORIGINAL_CLOSE");
        closed = true;
        state.events.push(writable ? "writer-close" : "reader-close");
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
        expect([path, mode, maximum]).toEqual([relative, "read", MODEL.bytes]);
        return state.partExists ? file(false) : null;
      }),
      openStoreModelFile: vi.fn(async (expected?: ConsumerFileBirth) => {
        state.events.push("writer-open");
        if (expected) {
          if (
            !state.partExists ||
            JSON.stringify(expected) !== JSON.stringify(state.birth)
          )
            throw Error("NATIVE_RESUME_BIRTH_DENIED");
        } else {
          if (state.partExists) throw Error("NATIVE_CREATE_NEW_DENIED");
          state.partExists = true;
        }
        return file(true);
      }),
      vaultRead: vi.fn(async (scope, entry) => {
        expect([scope, entry]).toEqual(["account", key]);
        return vault.get(entry) ?? null;
      }),
      vaultWrite: vi.fn(async (scope, entry, value: Buffer) => {
        expect([scope, entry]).toEqual(["account", key]);
        expect(value.length).toBeLessThanOrEqual(4096);
        state.events.push("checkpoint");
        vault.set(entry, Buffer.from(value));
      }),
      vaultDelete: vi.fn(async (scope, entry) => {
        expect([scope, entry]).toEqual(["account", key]);
        state.events.push("checkpoint-delete");
        vault.delete(entry);
      }),
    },
    host = {
      native,
      identity: { sid: binding.sid },
      directory: vi.fn(async (path) => {
        expect(path).toBe("models");
      }),
    } as unknown as HostContext,
    code = new owners.Code(native, binding);
  return {
    state,
    binding,
    vault,
    host,
    native,
    code,
    options: {
      host,
      code: code as unknown as StoreWorkerCodeAuthority,
      signal: new AbortController().signal,
    },
  };
}
function response(body = bytes, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      etag: '"pinned-model"',
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
          else controller.error(Error("network interrupted"));
        },
      },
      { highWaterMark: 0 },
    ),
    {
      headers: {
        "content-length": String(bytes.length),
        etag: '"pinned-model"',
      },
    },
  );
}
afterEach(() => vi.useRealTimers());
describe("Store fixed model retained-writer transfer", () => {
  it("publishes through the original writer and clears only after publication, code recheck and original close", async () => {
    const f = fixture(),
      progress = vi.fn(),
      fetcher = vi.fn(async (input, init) => {
        expect(String(input)).toBe(MODEL.url);
        expect(init).toMatchObject({
          method: "GET",
          redirect: "manual",
          credentials: "omit",
        });
        return response();
      });
    await expect(
      downloadStoreModel({
        ...f.options,
        fetch: fetcher as typeof fetch,
        onProgress: progress,
      }),
    ).resolves.toMatchObject({
      version: 1,
      state: "published",
      bytes: MODEL.bytes,
      sha256: MODEL.sha256,
    });
    expect(f.native.openStoreModelFile).toHaveBeenCalledWith(undefined);
    expect(f.state.final).toEqual(bytes);
    expect(f.state.writerCloses).toBe(1);
    expect(f.state.events.indexOf("publish")).toBeLessThan(
      f.state.events.indexOf("writer-close"),
    );
    expect(f.state.events.indexOf("writer-close")).toBeLessThan(
      f.state.events.indexOf("checkpoint-delete"),
    );
    expect(f.vault.size).toBe(0);
    expect(progress).toHaveBeenLastCalledWith(MODEL.bytes, MODEL.bytes);
  });
  it("adopts only an independently pinned complete partial birth, durably before writer open, without network", async () => {
    const f = fixture();
    f.state.partExists = true;
    f.state.part = Buffer.from(bytes);
    const fetcher = vi.fn(async () => {
      throw Error("must remain offline");
    });
    await downloadStoreModel({ ...f.options, fetch: fetcher as typeof fetch });
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.native.openStoreModelFile).toHaveBeenCalledWith(f.state.birth);
    expect(f.state.events.indexOf("checkpoint")).toBeLessThan(
      f.state.events.indexOf("writer-open"),
    );
    expect(f.state.readCloses).toBe(1);
    expect(f.state.truncates).toBe(0);
  });
  it("retains the interrupted prefix and exact durable birth, then resumes with the same ETag and Range", async () => {
    const f = fixture();
    await expect(
      downloadStoreModel({
        ...f.options,
        fetch: (async () => interrupted()) as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(f.state.part).toEqual(bytes.subarray(0, 80));
    const envelope = JSON.parse(f.vault.get(key)!.toString());
    expect(envelope.birth).toEqual(f.state.birth);
    expect(envelope.checkpoint.bytes).toBe(80);
    expect(envelope.checkpoint.sha256).toBe(
      createHash("sha256").update(bytes.subarray(0, 80)).digest("hex"),
    );
    expect(f.vault.get(key)!.toString()).not.toContain("https:");
    f.state.writerCloses = 0;
    const fetcher = vi.fn(async (_input, init) => {
      expect(init.headers).toMatchObject({
        Range: "bytes=80-",
        "If-Range": '"pinned-model"',
      });
      return response(bytes.subarray(80), 206, {
        "content-range": "bytes 80-" + (bytes.length - 1) + "/" + bytes.length,
      });
    });
    await downloadStoreModel({ ...f.options, fetch: fetcher as typeof fetch });
    expect(f.native.openStoreModelFile).toHaveBeenLastCalledWith(f.state.birth);
    expect(f.vault.size).toBe(0);
  });
  it.each(["absent", "legacy", "changed-binding", "duplicate", "foreign"])(
    "rejects %s partial ownership before writable effects",
    async (variant) => {
      const f = fixture();
      await expect(
        downloadStoreModel({
          ...f.options,
          fetch: (async () => interrupted()) as typeof fetch,
        }),
      ).rejects.toThrow();
      const original = Buffer.from(f.state.part);
      if (variant === "absent") f.vault.delete(key);
      if (variant === "legacy")
        f.vault.set(
          key,
          Buffer.from(
            JSON.stringify(JSON.parse(f.vault.get(key)!.toString()).checkpoint),
          ),
        );
      if (variant === "changed-binding")
        f.binding.inventorySha256 = "e".repeat(64);
      if (variant === "duplicate")
        f.vault.set(
          key,
          Buffer.from(
            f.vault
              .get(key)!
              .toString()
              .replace('"version":1', '"version":2,"version":1'),
          ),
        );
      if (variant === "foreign")
        f.vault.set(
          key,
          Buffer.from(
            '{"version":1,"binding":"wrong","birth":null,"checkpoint":null}',
          ),
        );
      const before = f.native.openStoreModelFile.mock.calls.length,
        truncates = f.state.truncates,
        fetcher = vi.fn();
      await expect(
        downloadStoreModel({ ...f.options, fetch: fetcher }),
      ).rejects.toThrow();
      expect(f.native.openStoreModelFile).toHaveBeenCalledTimes(before);
      expect(fetcher).not.toHaveBeenCalled();
      expect(f.state.part).toEqual(original);
      expect(f.state.truncates).toBe(truncates);
    },
  );
  it("rejects a prefix file birth swap and a corrupt complete partial without reset", async () => {
    const f = fixture();
    await expect(
      downloadStoreModel({
        ...f.options,
        fetch: (async () => interrupted()) as typeof fetch,
      }),
    ).rejects.toThrow();
    f.state.birth.fileId = "11";
    const before = f.native.openStoreModelFile.mock.calls.length;
    await expect(downloadStoreModel(f.options)).rejects.toThrow();
    expect(f.native.openStoreModelFile).toHaveBeenCalledTimes(before);
    f.state.part = Buffer.alloc(bytes.length, 3);
    const corrupt = Buffer.from(f.state.part);
    await expect(downloadStoreModel(f.options)).rejects.toThrow();
    expect(f.state.part).toEqual(corrupt);
    expect(f.state.publishes).toBe(0);
  });
  it("preserves original writer IO and close failures alongside the classified transfer error", async () => {
    const f = fixture();
    f.state.writeFailure = Error("original native write failed");
    f.state.writerCloseFailure = Error("original native close failed");
    const caught = await downloadStoreModel({
      ...f.options,
      fetch: (async () => response()) as typeof fetch,
    }).catch((error) => error);
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors).toContain(f.state.writeFailure);
    expect(caught.errors).toContain(f.state.writerCloseFailure);
    expect(f.vault.has(key)).toBe(true);
    expect(f.state.publishes).toBe(0);
    expect(f.native.vaultDelete).not.toHaveBeenCalled();
  });
  it("rejects a modified checkpoint prefix before fetch or any truncate", async () => {
    const f = fixture();
    await expect(
      downloadStoreModel({
        ...f.options,
        fetch: (async () => interrupted()) as typeof fetch,
      }),
    ).rejects.toThrow();
    f.state.part[0] = f.state.part.readUInt8(0) ^ 1;
    const original = Buffer.from(f.state.part),
      truncates = f.state.truncates,
      fetcher = vi.fn();
    await expect(
      downloadStoreModel({ ...f.options, fetch: fetcher }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.state.part).toEqual(original);
    expect(f.state.truncates).toBe(truncates);
    expect(f.vault.has(key)).toBe(true);
  });
  it("rejects same-birth content changes during reader-to-writer handoff without resetting unknown bytes", async () => {
    const f = fixture();
    await expect(
      downloadStoreModel({
        ...f.options,
        fetch: (async () => {
          throw Error("headers failed before any bytes");
        }) as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(f.state.part.length).toBe(0);
    const open = f.native.openStoreModelFile.getMockImplementation()!;
    f.native.openStoreModelFile.mockImplementationOnce(async (expected) => {
      f.state.part = Buffer.from(bytes.subarray(0, 40));
      f.state.changed++;
      return open(expected);
    });
    const fetcher = vi.fn(),
      truncates = f.state.truncates;
    await expect(
      downloadStoreModel({ ...f.options, fetch: fetcher }),
    ).rejects.toThrow("INTEGRITY_INVALID");
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.state.part).toEqual(bytes.subarray(0, 40));
    expect(f.state.truncates).toBe(truncates);
    expect(f.state.publishes).toBe(0);
  });
  it("does not open a writer after the original complete reader close or adopted checkpoint fails", async () => {
    const f = fixture();
    f.state.partExists = true;
    f.state.part = Buffer.from(bytes);
    f.state.readCloseFailure = Error("original complete reader close failed");
    await expect(downloadStoreModel(f.options)).rejects.toBe(
      f.state.readCloseFailure,
    );
    expect(f.native.openStoreModelFile).not.toHaveBeenCalled();
    expect(f.vault.has(key)).toBe(true);
    const second = fixture(),
      failure = Error("durable adopted birth write failed");
    second.state.partExists = true;
    second.state.part = Buffer.from(bytes);
    second.native.vaultWrite.mockImplementationOnce(async () => {
      throw failure;
    });
    await expect(downloadStoreModel(second.options)).rejects.toBe(failure);
    expect(second.native.openStoreModelFile).not.toHaveBeenCalled();
    expect(second.state.readCloses).toBe(1);
    expect(second.state.part).toEqual(bytes);
  });
  it("bounds a stalled response-header wait and retains the partial birth without publication", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let start!: () => void;
    const entered = new Promise<void>((resolve) => {
        start = resolve;
      }),
      pending = downloadStoreModel({
        ...f.options,
        fetch: ((_input, init) => {
          start();
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              "abort",
              () => reject(init!.signal!.reason),
              { once: true },
            );
          });
        }) as typeof fetch,
      }).catch((error) => error);
    await entered;
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await pending).toBeInstanceOf(AggregateError);
    expect(f.state.publishes).toBe(0);
    expect(f.state.writerCloses).toBe(1);
    expect(f.vault.has(key)).toBe(true);
    expect(f.native.vaultDelete).not.toHaveBeenCalled();
  });
  it("retains publication or post-publication close failures without reporting completion", async () => {
    const f = fixture();
    f.state.publishFailure = Error("native journal publication pending");
    await expect(
      downloadStoreModel({
        ...f.options,
        fetch: (async () => response()) as typeof fetch,
      }),
    ).rejects.toBe(f.state.publishFailure);
    expect(f.vault.has(key)).toBe(true);
    expect(f.native.vaultDelete).not.toHaveBeenCalled();
    const second = fixture();
    second.state.writerCloseFailure = Error(
      "native original close unconfirmed",
    );
    await expect(
      downloadStoreModel({
        ...second.options,
        fetch: (async () => response()) as typeof fetch,
      }),
    ).rejects.toBe(second.state.writerCloseFailure);
    expect(second.state.final).toEqual(bytes);
    expect(second.vault.has(key)).toBe(true);
  });
  it.each([false, true])(
    "a native reused-final observation still requires original source close (failure=%s)",
    async (closeFails) => {
      const f = fixture();
      f.state.publicationOverride = {
        version: 1,
        state: "reused",
        bytes: MODEL.bytes,
        sha256: MODEL.sha256,
        identity: {
          device: "8",
          fileId: "11",
          bornAt: "202",
          bytes: MODEL.bytes,
          writtenAt: "4",
          changedAt: "4",
        },
        backupRelativePath: null,
      };
      if (closeFails)
        f.state.writerCloseFailure = Error(
          "reused source original close unconfirmed",
        );
      const pending = downloadStoreModel({
        ...f.options,
        fetch: (async () => response()) as typeof fetch,
      });
      if (closeFails) {
        await expect(pending).rejects.toBe(f.state.writerCloseFailure);
        expect(f.vault.has(key)).toBe(true);
        expect(f.native.vaultDelete).not.toHaveBeenCalled();
      } else {
        await expect(pending).resolves.toMatchObject({
          state: "reused",
          identity: { fileId: "11", bornAt: "202" },
        });
        expect(f.vault.size).toBe(0);
      }
      expect(f.state.writerCloses).toBe(1);
    },
  );
  it("rejects malformed native publication observations and retains their durable checkpoint", async () => {
    const f = fixture();
    f.state.publicationOverride = {
      version: 1,
      state: "published",
      bytes: MODEL.bytes,
      sha256: MODEL.sha256,
      identity: null,
      backupRelativePath: "../old.onnx",
    };
    await expect(
      downloadStoreModel({
        ...f.options,
        fetch: (async () => response()) as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(f.vault.has(key)).toBe(true);
    expect(f.native.vaultDelete).not.toHaveBeenCalled();
  });
  it("applies the unchanged manual model redirect allowlist and cancels disallowed redirects before bytes", async () => {
    const f = fixture(),
      redirected =
        "https://release-assets.githubusercontent.com/model.bin?temporary=1",
      fetcher = vi.fn(async (input) =>
        String(input) === MODEL.url
          ? new Response(null, {
              status: 302,
              headers: { location: redirected },
            })
          : response(),
      );
    await downloadStoreModel({ ...f.options, fetch: fetcher as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const rejected = fixture(),
      denied = vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://foreign.invalid/model" },
          }),
      );
    await expect(
      downloadStoreModel({
        ...rejected.options,
        fetch: denied as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(denied).toHaveBeenCalledTimes(1);
    expect(rejected.state.writes).toBe(0);
    expect(rejected.state.publishes).toBe(0);
  });
  it("does not publish after current code changes during transfer or when the original network reader cannot close", async () => {
    const f = fixture();
    await expect(
      downloadStoreModel({
        ...f.options,
        fetch: (async () => {
          f.binding.runtimeManifestSha256 = "e".repeat(64);
          return response();
        }) as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(f.state.publishes).toBe(0);
    const second = fixture(),
      failure = Error("original reader cancellation failed");
    let done = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!done) {
            done = true;
            controller.enqueue(bytes);
          } else controller.close();
        },
        cancel() {
          throw failure;
        },
      },
      { highWaterMark: 0 },
    );
    // Cancel failure before EOF is retained even though the transfer classifies
    // the bounded request as interrupted.
    const signal = new AbortController();
    const caught = await downloadStoreModel({
      ...second.options,
      signal: signal.signal,
      onProgress(written) {
        if (written === bytes.length) signal.abort();
      },
      fetch: (async () =>
        new Response(stream, {
          headers: { etag: '"pinned-model"' },
        })) as typeof fetch,
    }).catch((error) => error);
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors).toContain(failure);
    expect(second.state.publishes).toBe(0);
    expect(second.native.vaultDelete).not.toHaveBeenCalled();
  });
  it("denies structural owners, foreign native ports, callback getters and caller path/pin options before IO", async () => {
    const f = fixture();
    await expect(
      downloadStoreModel({
        ...f.options,
        code: {
          assertDataNative() {},
          preparationBinding: async () => f.binding,
        } as unknown as StoreWorkerCodeAuthority,
      }),
    ).rejects.toThrow();
    await expect(
      downloadStoreModel({
        ...f.options,
        host: { ...f.host, native: {} } as unknown as HostContext,
      }),
    ).rejects.toThrow();
    const options = { ...f.options };
    Object.defineProperty(options, "fetch", {
      enumerable: true,
      get() {
        throw Error("getter must not execute");
      },
    });
    await expect(downloadStoreModel(options)).rejects.toThrow(
      "INTEGRITY_INVALID",
    );
    await expect(
      downloadStoreModel({
        ...f.options,
        destination: "../model",
      } as Parameters<typeof downloadStoreModel>[0]),
    ).rejects.toThrow();
    expect(f.native.openPrivateFile).not.toHaveBeenCalled();
    expect(f.native.openStoreModelFile).not.toHaveBeenCalled();
    expect(f.host.directory).not.toHaveBeenCalled();
  });
});
