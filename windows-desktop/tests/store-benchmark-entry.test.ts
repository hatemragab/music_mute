import { afterEach, describe, expect, it, vi } from "vitest";
import { runStoreBenchmarkChild } from "../src/agent/store-benchmark.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";

afterEach(() => vi.restoreAllMocks());

describe("fixed Store benchmark entry receiving boundary", () => {
  it.each(
    [
      [],
      ["--store-session"],
      ["--store-cpu"],
      ["--store-benchmark", "C:\\caller\\config.json"],
      ["--store-benchmark", "--cpu"],
      [" --store-benchmark"],
      ["--STORE-BENCHMARK"],
      ["--store-benchmark\u0000"],
      ["--store-benchmark\n"],
      [new String("--store-benchmark")],
    ].map((argv) => ({ argv })),
  )(
    "denies non-fixed arguments $argv before native factory IO",
    async ({ argv }) => {
      const opening = vi.spyOn(StoreNodeIssuer, "open");
      await expect(
        runStoreBenchmarkChild(argv as unknown as readonly string[]),
      ).rejects.toThrow("PREPARE_CONTEXT_INVALID");
      expect(opening).not.toHaveBeenCalled();
    },
  );

  it("does not invoke accessor/proxy callbacks or accept structural arrays", async () => {
    const callback = vi.fn(() => "--store-benchmark"),
      accessor = Object.defineProperty([undefined], "0", {
        enumerable: true,
        get: callback,
      }),
      proxy = new Proxy(["--store-benchmark"], {
        get: callback,
        getPrototypeOf: callback as never,
      }),
      opening = vi.spyOn(StoreNodeIssuer, "open");
    class ForeignArray extends Array<string> {}
    for (const argv of [
      accessor,
      proxy,
      new ForeignArray("--store-benchmark"),
      Object.assign(["--store-benchmark"], { ready: true }),
      Object.assign(["--store-benchmark"], { [Symbol()]: true }),
      { 0: "--store-benchmark", length: 1 },
      null,
    ])
      await expect(
        runStoreBenchmarkChild(argv as readonly string[]),
      ).rejects.toThrow("PREPARE_CONTEXT_INVALID");
    expect(callback).not.toHaveBeenCalled();
    expect(opening).not.toHaveBeenCalled();
  });

  it("denies injected factories and requires the actual native issuer even with valid grammar", async () => {
    const opening = vi.spyOn(StoreNodeIssuer, "open"),
      listeners = [
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ];
    await expect(
      Reflect.apply(runStoreBenchmarkChild, undefined, [
        ["--store-benchmark"],
        { open: vi.fn(), gpu: true },
      ]),
    ).rejects.toThrow("PREPARE_CONTEXT_INVALID");
    expect(opening).not.toHaveBeenCalled();
    if (process.platform !== "win32" || process.arch !== "x64") {
      await expect(
        runStoreBenchmarkChild(Object.freeze(["--store-benchmark"])),
      ).rejects.toThrow("STORE_NODE_ISSUER_DENIED");
      expect(opening).toHaveBeenCalledExactlyOnceWith();
      expect(process.listenerCount("SIGINT")).toBe(listeners[0]);
      expect(process.listenerCount("SIGTERM")).toBe(listeners[1]);
    }
  });
});
