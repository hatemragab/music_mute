import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreBenchmarkRequest } from "../src/shared/store-benchmark-contracts.js";

// Synthetic native/issuer/file boundaries around the real fixed entry and the
// unchanged real report validator. No fixture admits Store/GPU/Job authority.
const boundary = vi.hoisted(() => {
  const state = {
    request: undefined as StoreBenchmarkRequest | undefined,
    role: "prepare",
    events: [] as string[],
    childRetired: false,
    native: {
      bootIdentity: vi.fn(),
      enumerateGpus: vi.fn(),
      acquireGpuGuard: vi.fn(),
      validatePath: vi.fn(async () => {}),
    },
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    exit: vi.fn(async () => 0),
    publish: vi.fn(async (_input: unknown) => {}),
    close: vi.fn(async () => {}),
    read: vi.fn<() => Promise<Buffer>>(),
    write: vi.fn(async (_path: string, _bytes: Buffer) => {}),
    binding: vi.fn(),
    factory: vi.fn(),
  };
  class Child {
    get stdout() {
      return (async function* () {
        yield Buffer.from("fixed benchmark output\n");
      })();
    }
    async start() {
      state.events.push("start");
      await state.start();
    }
    waitForExit() {
      return state.exit();
    }
    async stop() {
      state.events.push("stop");
      await state.stop();
      state.childRetired = true;
    }
  }
  class Issuer {
    static open = vi.fn(async () => new Issuer());
    static retireFailedOpen = vi.fn(async () => {});
    get nodeRole() {
      return state.role;
    }
    async openNative() {
      return state.native;
    }
    async benchmarkRequest() {
      return state.request;
    }
    assertNative() {}
    async codeView() {
      return { binding: await state.binding() };
    }
    async writeNewPrivateFile(_native: object, path: string, bytes: Buffer) {
      state.events.push("write");
      await state.write(path, bytes);
    }
    createBenchmark() {
      return state.factory();
    }
    assertChildrenRetired() {
      if (state.factory.mock.calls.length && !state.childRetired)
        throw Error("ORIGINAL_CHILD_PENDING");
    }
    async publishBenchmarkResult(_native: object, input: unknown) {
      state.events.push("publish");
      await state.publish(input);
    }
    async close() {
      state.events.push("issuer-close");
      await state.close();
    }
  }
  return { ...state, state, Child, Issuer, directory: vi.fn(async () => {}) };
});
vi.mock("../src/main/session/store-node-issuer.js", () => ({
  StoreNodeIssuer: boundary.Issuer,
  StoreFixedToolChild: boundary.Child,
}));
vi.mock("../src/main/host-context.js", () => ({
  HostContext: {
    initialize: vi.fn(async () => ({
      identity: { sid: boundary.state.request!.binding.sid },
      native: boundary.state.native,
      directory: boundary.directory,
    })),
  },
}));
vi.mock("../src/main/prepare/private-files.js", () => ({
  readPrivateBytes: () => boundary.state.read(),
}));

import { runStoreBenchmarkChild } from "../src/agent/store-benchmark.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { parseStoreBenchmarkRequest } from "../src/shared/store-benchmark-contracts.js";
import {
  advancedRequest,
  benchmarkConfig,
  consumerRepeatedRaw,
  processIdentity,
} from "./fleet-advanced-fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  const product = STORE_PRODUCTS.worker,
    fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
    state = boundary.state;
  state.request = parseStoreBenchmarkRequest(
    Buffer.from(
      JSON.stringify({
        version: 1,
        requestId: advancedRequest,
        operation: "benchmark_file",
        binding: {
          package: {
            identityName: product.identityName,
            publisher: product.publisher,
            publisherId: product.publisherId,
            familyName: product.familyName,
            fullName,
            packageVersion: "0.1.3.2",
            architecture: "x64",
            signatureKind: 3,
            healthy: true,
            current: true,
            installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
          },
          inventorySha256: "a".repeat(64),
          runtimeManifestSha256: "b".repeat(64),
          sid: processIdentity.sid,
          bootIdentity: "e".repeat(64),
          recipeDigests: {
            "kim-vocals-v2": "c".repeat(64),
            "kim-vocals-v2-trim": "d".repeat(64),
          },
        },
        configuration: benchmarkConfig(),
      }),
    ),
  );
  state.events.length = 0;
  state.childRetired = false;
  state.role = "prepare";
  state.native.bootIdentity.mockResolvedValue(
    state.request.binding.bootIdentity,
  );
  state.native.enumerateGpus.mockResolvedValue([
    state.request.configuration.gpu,
  ]);
  state.native.acquireGpuGuard.mockResolvedValue("synthetic-owned-gpu");
  state.binding.mockResolvedValue(state.request.binding);
  state.factory.mockResolvedValue(new boundary.Child());
  state.stop.mockResolvedValue(undefined);
  state.start.mockResolvedValue(undefined);
  state.exit.mockResolvedValue(0);
  state.close.mockResolvedValue(undefined);
  state.publish.mockResolvedValue(undefined);
  state.read.mockImplementation(async () =>
    Buffer.from(JSON.stringify(consumerRepeatedRaw())),
  );
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(800000);
});
afterEach(() => vi.restoreAllMocks());

describe("Store benchmark Node original-owner lifetime under synthetic boundaries", () => {
  it("writes fixed canonical config and publishes validated original report only after child stop", async () => {
    await runStoreBenchmarkChild(["--store-benchmark"]);
    const state = boundary.state;
    expect(state.write).toHaveBeenCalledOnce();
    expect(boundary.directory).toHaveBeenCalledWith(
      `prepare\\work\\${advancedRequest}\\engine`,
    );
    expect(state.write.mock.calls[0]![0]).toBe(
      `prepare\\work\\${advancedRequest}\\store-benchmark-config.json`,
    );
    const publication = state.publish.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(publication).toMatchObject({
      requestId: advancedRequest,
      wallSeconds_json: "800",
      rawSha256: createHash("sha256")
        .update(JSON.stringify(consumerRepeatedRaw()))
        .digest("hex"),
    });
    expect(state.events.indexOf("stop")).toBeLessThan(
      state.events.indexOf("publish"),
    );
    expect(state.events.at(-1)).toBe("issuer-close");
    expect(state.stop).toHaveBeenCalledTimes(1);
  });

  it("joins the same original pending child stop before publishing or closing issuer", async () => {
    const pending = deferred<void>();
    boundary.state.stop.mockReturnValue(pending.promise);
    const run = runStoreBenchmarkChild(["--store-benchmark"]);
    await vi.waitFor(() => expect(boundary.state.stop).toHaveBeenCalledOnce());
    expect(boundary.state.publish).not.toHaveBeenCalled();
    expect(boundary.state.close).not.toHaveBeenCalled();
    pending.resolve(undefined);
    await run;
    expect(boundary.state.stop).toHaveBeenCalledOnce();
  });

  it("creates only the fixed saved-audio directory when the original parsed request requires it", async () => {
    const original = boundary.state.request!;
    boundary.state.request = parseStoreBenchmarkRequest(
      Buffer.from(
        JSON.stringify({
          ...original,
          configuration: { ...original.configuration, saveAudio: true },
        }),
      ),
    );
    boundary.state.binding.mockResolvedValue(boundary.state.request.binding);
    boundary.state.exit.mockResolvedValue(1);
    await expect(runStoreBenchmarkChild(["--store-benchmark"])).rejects.toThrow(
      "OPERATION_FAILED",
    );
    expect(boundary.directory).toHaveBeenCalledWith(
      `prepare\\work\\${advancedRequest}\\saved-audio`,
    );
    expect(boundary.state.start).toHaveBeenCalledOnce();
    expect(boundary.state.stop).toHaveBeenCalledOnce();
  });

  it("never translates failed original child retirement into success or failure publication", async () => {
    const failure = Error("ORIGINAL_JOB_ZERO_UNKNOWN");
    boundary.state.stop.mockRejectedValue(failure);
    const result = await runStoreBenchmarkChild(["--store-benchmark"]).catch(
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toContain(failure);
    expect(boundary.state.stop).toHaveBeenCalledOnce();
    expect(boundary.state.publish).not.toHaveBeenCalled();
    expect(boundary.state.close).toHaveBeenCalledOnce();
  });

  it("retains partial factory ownership and stops the same child after cancellation without launch", async () => {
    const pending = deferred<InstanceType<typeof boundary.Child>>();
    boundary.state.factory.mockReturnValue(pending.promise);
    const run = runStoreBenchmarkChild(["--store-benchmark"]);
    await vi.waitFor(() =>
      expect(boundary.state.factory).toHaveBeenCalledOnce(),
    );
    process.emit("SIGTERM");
    expect(boundary.state.close).not.toHaveBeenCalled();
    pending.resolve(new boundary.Child());
    await expect(run).rejects.toThrow();
    expect(boundary.state.start).not.toHaveBeenCalled();
    expect(boundary.state.stop).toHaveBeenCalledOnce();
    expect(boundary.state.publish).toHaveBeenCalledWith({
      requestId: advancedRequest,
      errorCode: "PREPARE_INTERRUPTED",
    });
  });

  it("changed current generation after raw read cannot publish a successful result", async () => {
    boundary.state.binding
      .mockResolvedValueOnce(boundary.state.request!.binding)
      .mockResolvedValue({
        ...boundary.state.request!.binding,
        inventorySha256: "f".repeat(64),
      });
    await expect(runStoreBenchmarkChild(["--store-benchmark"])).rejects.toThrow(
      "INTEGRITY_INVALID",
    );
    expect(boundary.state.publish).toHaveBeenCalledExactlyOnceWith({
      requestId: advancedRequest,
      errorCode: "INTEGRITY_INVALID",
    });
    expect(boundary.state.stop).toHaveBeenCalledOnce();
  });

  it.each([
    "\ufeff{}",
    '{"status":"PASS","status":"PASS"}',
    '{"status":"PASS"}',
  ])(
    "invalid report %s remains a failure after positive child cleanup",
    async (raw) => {
      boundary.state.read.mockResolvedValue(Buffer.from(raw));
      await expect(
        runStoreBenchmarkChild(["--store-benchmark"]),
      ).rejects.toThrow();
      expect(boundary.state.stop).toHaveBeenCalledOnce();
      expect(boundary.state.publish).toHaveBeenCalledExactlyOnceWith({
        requestId: advancedRequest,
        errorCode: "OPERATION_FAILED",
      });
    },
  );
});
