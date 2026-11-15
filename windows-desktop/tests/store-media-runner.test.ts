import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  readStoreToolOutput,
  StoreMediaExecution,
} from "../src/main/session/store-media-runner.js";
import {
  StoreNodeIssuer,
  StoreFixedToolChild,
} from "../src/main/session/store-node-issuer.js";

describe("Store CPU output and private execution boundary", () => {
  it("collects real bounded byte streams including an empty successful FFmpeg stdout", async () => {
    const signal = new AbortController().signal;
    expect(
      await readStoreToolOutput(
        Readable.from([Buffer.from("ab"), Buffer.from("c")]),
        3,
        signal,
      ),
    ).toEqual(Buffer.from("abc"));
    expect(await readStoreToolOutput(Readable.from([]), 1, signal)).toEqual(
      Buffer.alloc(0),
    );
  });
  it("rejects a cumulative overflow across individually bounded chunks", async () => {
    await expect(
      readStoreToolOutput(
        Readable.from([Buffer.alloc(2), Buffer.alloc(2)]),
        3,
        new AbortController().signal,
      ),
    ).rejects.toThrow("STORE_MEDIA_EXECUTION_DENIED");
  });
  it("never coerces textual or caller-object output into accepted tool bytes", async () => {
    await expect(
      readStoreToolOutput(
        Readable.from(["text"]),
        20,
        new AbortController().signal,
      ),
    ).rejects.toThrow("STORE_MEDIA_EXECUTION_DENIED");
    await expect(
      readStoreToolOutput(
        Readable.from([{ bytes: Buffer.from("text") }]),
        20,
        new AbortController().signal,
      ),
    ).rejects.toThrow("STORE_MEDIA_EXECUTION_DENIED");
  });
  it("retains the original stream error", async () => {
    const failure = new Error("original pipe error");
    const stream = new Readable({
      read() {
        this.destroy(failure);
      },
    });
    await expect(
      readStoreToolOutput(stream, 20, new AbortController().signal),
    ).rejects.toBe(failure);
  });
  it.each([0, -1, 1.25, 131073, Number.NaN, Number.POSITIVE_INFINITY])(
    "denies invalid maximum %s before reading",
    async (maximum) => {
      let read = false;
      const stream = new Readable({
        read() {
          read = true;
          this.push(null);
        },
      });
      await expect(
        readStoreToolOutput(stream, maximum, new AbortController().signal),
      ).rejects.toThrow("STORE_MEDIA_EXECUTION_DENIED");
      expect(read).toBe(false);
    },
  );
  it("fences already aborted and actively aborted real streams", async () => {
    const first = new AbortController();
    first.abort(new Error("original abort"));
    await expect(
      readStoreToolOutput(Readable.from([Buffer.from("x")]), 1, first.signal),
    ).rejects.toThrow("original abort");
    const live = new AbortController();
    const stream = new Readable({ read() {} });
    const pending = readStoreToolOutput(stream, 1, live.signal);
    live.abort();
    await expect(pending).rejects.toThrow("STORE_MEDIA_INTERRUPTED");
    expect(stream.destroyed).toBe(true);
  });
  it("cannot mint an execution or fixed CPU child from a prototype/receipt/launcher", async () => {
    let configurationReads = 0;
    const configuration = Object.defineProperty({}, "requestId", {
      get() {
        ++configurationReads;
        throw new Error("caller configuration");
      },
    });
    await expect(
      StoreMediaExecution.open(
        { native: {} } as never,
        Object.create(StoreNodeIssuer.prototype),
        configuration as never,
      ),
    ).rejects.toThrow();
    expect(configurationReads).toBe(0);
    expect(() =>
      Reflect.construct(StoreMediaExecution, [
        Symbol(),
        {},
        {},
        { configuration },
      ]),
    ).toThrow("STORE_MEDIA_EXECUTION_DENIED");
    expect(() =>
      Reflect.construct(StoreFixedToolChild, [
        Symbol(),
        {},
        "cloud-transcode",
        "12345678-1234-4234-8234-123456789012",
        "a".repeat(64),
      ]),
    ).toThrow();
    for (const method of ["run", "close", "recoverClose"] as const) {
      const fake = Object.create(StoreMediaExecution.prototype);
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(
            StoreMediaExecution.prototype[method],
            fake,
            method === "run" ? [new AbortController().signal] : [],
          ),
        ),
      ).rejects.toThrow();
    }
  });
});
