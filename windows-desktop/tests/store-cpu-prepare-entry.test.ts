import { afterEach, describe, expect, it, vi } from "vitest";
import { runStoreCpuPreparationChild } from "../src/agent/store-cpu-prepare.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
import { StoreMediaExecution } from "../src/main/session/store-media-runner.js";
import { StoreCpuOperation } from "../src/main/session/store-cpu-operation.js";

afterEach(() => vi.restoreAllMocks());

describe("dedicated Store CPU Prepare entry authority boundary", () => {
  it.each(
    [
      [],
      ["--store-session"],
      ["--consumer-config"],
      ["--store-cpu", "C:\\caller\\prepare-config.json"],
      ["--store-cpu", "--gpu"],
      [" --store-cpu"],
      ["--STORE-CPU"],
      ["--store-cpu "],
      ["--store-cpu\u0000"],
      ["--store-cpu\n"],
      [new String("--store-cpu")],
      ["C:\\caller\\node.exe"],
    ].map((argv) => ({ argv })),
  )(
    "denies non-fixed entry arguments $argv before issuer IO",
    async ({ argv }) => {
      const opening = vi.spyOn(StoreNodeIssuer, "open");
      const term = process.listenerCount("SIGTERM"),
        interrupt = process.listenerCount("SIGINT");
      await expect(
        runStoreCpuPreparationChild(argv as unknown as readonly string[]),
      ).rejects.toThrow("PREPARE_CONTEXT_INVALID");
      expect(opening).not.toHaveBeenCalled();
      expect(process.listenerCount("SIGTERM")).toBe(term);
      expect(process.listenerCount("SIGINT")).toBe(interrupt);
    },
  );

  it("denies missing arguments or injected owner/launcher arguments before issuer IO", async () => {
    const opening = vi.spyOn(StoreNodeIssuer, "open");
    for (const argv of [
      [],
      [["--store-cpu"], Object.create(StoreNodeIssuer.prototype)],
      [["--store-cpu"], { launch: vi.fn(), ready: true }],
    ])
      await expect(
        Reflect.apply(runStoreCpuPreparationChild, undefined, argv),
      ).rejects.toThrow("PREPARE_CONTEXT_INVALID");
    expect(opening).not.toHaveBeenCalled();
  });

  it("denies structural lists, sparse arrays, extra keys and subclasses", async () => {
    class CallerArray extends Array<string> {}
    const sparse: unknown[] = [];
    sparse.length = 1;
    const withField = Object.assign(["--store-cpu"], { runtime: "caller" }),
      withSymbol = Object.assign(["--store-cpu"], { [Symbol()]: true }),
      withHidden = Object.defineProperty(["--store-cpu"], "ready", {
        value: true,
      }),
      nullPrototype = Object.setPrototypeOf(["--store-cpu"], null),
      opening = vi.spyOn(StoreNodeIssuer, "open");
    for (const argv of [
      null,
      undefined,
      "--store-cpu",
      { 0: "--store-cpu", length: 1 },
      sparse,
      new CallerArray("--store-cpu"),
      withField,
      withSymbol,
      withHidden,
      nullPrototype,
    ])
      await expect(
        runStoreCpuPreparationChild(argv as readonly string[]),
      ).rejects.toThrow("PREPARE_CONTEXT_INVALID");
    expect(opening).not.toHaveBeenCalled();
  });

  it("does not evaluate an argument accessor while checking the fixed entry", async () => {
    const getter = vi.fn(() => "--store-cpu"),
      argv = Object.defineProperty([undefined], "0", {
        enumerable: true,
        get: getter,
      }),
      opening = vi.spyOn(StoreNodeIssuer, "open");
    await expect(
      runStoreCpuPreparationChild(argv as unknown as readonly string[]),
    ).rejects.toThrow("PREPARE_CONTEXT_INVALID");
    expect(getter).not.toHaveBeenCalled();
    expect(opening).not.toHaveBeenCalled();
  });

  it("a valid fixed argument still requires the real native Store issuer and leaves no signal listener after denial", async () => {
    if (process.platform === "win32" && process.arch === "x64") return;
    const term = process.listenerCount("SIGTERM"),
      interrupt = process.listenerCount("SIGINT"),
      opening = vi.spyOn(StoreNodeIssuer, "open");
    await expect(
      runStoreCpuPreparationChild(Object.freeze(["--store-cpu"])),
    ).rejects.toThrow("STORE_NODE_ISSUER_DENIED");
    expect(opening).toHaveBeenCalledExactlyOnceWith();
    expect(process.listenerCount("SIGTERM")).toBe(term);
    expect(process.listenerCount("SIGINT")).toBe(interrupt);
  });

  it("receiving reports and prototype lookalikes cannot construct CPU ownership", async () => {
    const report = { requestId: "12345678-1234-4234-8234-123456789012" },
      issuer = Object.create(StoreNodeIssuer.prototype);
    expect(() =>
      Reflect.construct(StoreMediaExecution, [Symbol(), {}, issuer, report]),
    ).toThrow("STORE_MEDIA_EXECUTION_DENIED");
    expect(() =>
      Reflect.construct(StoreCpuOperation, [Symbol(), {}, issuer, report]),
    ).toThrow("STORE_CPU_OPERATION_DENIED");
    await expect(
      StoreMediaExecution.open(
        { native: {} } as never,
        issuer,
        report as never,
      ),
    ).rejects.toThrow();
    expect(() =>
      StoreCpuOperation.prototype.expectation.call(
        Object.create(StoreCpuOperation.prototype),
      ),
    ).toThrow();
  });
});
