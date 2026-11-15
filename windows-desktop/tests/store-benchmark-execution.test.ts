import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type { StoreSessionClient } from "../src/main/session/store-session-client.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import {
  parseStoreBenchmarkRequest,
  storeBenchmarkConfigurationSha256,
} from "../src/shared/store-benchmark-contracts.js";
import {
  advancedRequest,
  benchmarkConfig,
  processIdentity,
} from "./fleet-advanced-fixtures.js";

// Genuine execution source under synthetic private Session/file boundaries.
// These fixtures do not admit a Store package, GPU, process or native Job.
const boundary = vi.hoisted(() => {
  class Client {
    #host: object;
    #owned = new Set<object>();
    command = vi.fn();
    waiter = vi.fn(async () => {});
    globalClose = vi.fn();
    constructor(host: object) {
      this.#host = host;
    }
    own(value: object) {
      this.#owned.add(value);
    }
    assertBenchmarkHost(host: object) {
      if (host !== this.#host) throw Error("FOREIGN_HOST");
    }
    benchmarkOperationCommand(execution: object, action: string) {
      if (!this.#owned.has(execution)) throw Error("FOREIGN_EXECUTION");
      return this.command(execution, action);
    }
    retireBenchmarkWaiter(execution: object) {
      if (!this.#owned.has(execution)) throw Error("FOREIGN_EXECUTION");
      return this.waiter();
    }
  }
  return { Client, read: vi.fn() };
});
vi.mock("../src/main/session/store-session-client.js", () => ({
  StoreSessionClient: boundary.Client,
}));
vi.mock("../src/main/prepare/private-files.js", () => ({
  readPrivateBytes: boundary.read,
}));
import { StoreBenchmarkExecution } from "../src/main/session/store-benchmark-execution.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  boundary.read.mockReset();
  const product = STORE_PRODUCTS.worker,
    fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
    request = parseStoreBenchmarkRequest(
      Buffer.from(
        JSON.stringify({
          version: 1,
          requestId: advancedRequest,
          operation: "benchmark_file",
          configuration: benchmarkConfig("benchmark_file"),
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
        }),
      ),
    ),
    launch = {
      version: 1,
      requestId: request.requestId,
      inventorySha256: request.binding.inventorySha256,
      owner: {
        role: "prepare",
        nonce: "1".repeat(64),
        identity: { ...processIdentity, pid: 345 },
      },
    },
    raw = Buffer.from('{"synthetic":true}'),
    result = {
      configurationSha256: storeBenchmarkConfigurationSha256(
        request.configuration,
      ),
      rawBytes: raw.length,
      rawSha256: createHash("sha256").update(raw).digest("hex"),
      wallSeconds: 12.25,
    },
    host = { native: {} } as unknown as HostContext,
    client = new boundary.Client(host),
    execution = StoreBenchmarkExecution.create(
      client as unknown as StoreSessionClient,
      host,
      request,
    );
  client.own(execution);
  client.command.mockImplementation(async (_execution, action: string) =>
    action === "benchmark_wait"
      ? { ...launch, state: "completed", result }
      : action === "benchmark_cancel"
        ? { ...launch, job: "confirmed", gpu: "confirmed" }
        : launch,
  );
  boundary.read.mockImplementation(async () => Buffer.from(raw));
  return {
    host,
    request,
    launch,
    raw,
    result,
    client,
    execution,
    signal: new AbortController().signal,
  };
}
it("retains the source before IO, reads only the fixed hash-bound report, and retires only its original transient owner", async () => {
  const f = fixture();
  expect(f.client.command).not.toHaveBeenCalled();
  await f.execution.run(f.signal);
  await expect(f.execution.readResult()).resolves.toEqual(f.raw);
  expect(boundary.read).toHaveBeenCalledWith(
    f.host,
    `prepare\\results\\${f.request.requestId}.benchmark.raw.json`,
    8 * 1024 ** 2,
  );
  await f.execution.close();
  expect(f.client.command.mock.calls.map((row) => row[1])).toEqual([
    "benchmark_launch",
    "benchmark_wait",
    "benchmark_cancel",
  ]);
  expect(f.client.waiter).toHaveBeenCalledOnce();
  expect(f.client.globalClose).not.toHaveBeenCalled();
});
it("requires the actual class/session association and denies a copied receipt, forged prototype or unregistered execution", async () => {
  const f = fixture();
  expect(() =>
    StoreBenchmarkExecution.prototype.requestForSession.call(
      Object.create(StoreBenchmarkExecution.prototype),
      f.client as unknown as StoreSessionClient,
    ),
  ).toThrow();
  expect(() =>
    StoreBenchmarkExecution.create(
      Object.create(boundary.Client.prototype),
      f.host,
      f.request,
    ),
  ).toThrow();
  const unregistered = StoreBenchmarkExecution.create(
    f.client as unknown as StoreSessionClient,
    f.host,
    f.request,
  );
  await expect(unregistered.launch(f.signal)).rejects.toThrow(
    "FOREIGN_EXECUTION",
  );
  expect(f.client.command).not.toHaveBeenCalled();
  expect(() =>
    f.execution.requestForSession(
      new boundary.Client(f.host) as unknown as StoreSessionClient,
    ),
  ).toThrow();
});
it("fences a same-turn close before any queued launch effect", async () => {
  const f = fixture(),
    launch = f.execution.launch(f.signal);
  void launch.catch(() => {});
  await f.execution.close();
  await expect(launch).rejects.toThrow("STORE_BENCHMARK_EXECUTION_DENIED");
  expect(f.client.command).not.toHaveBeenCalled();
  expect(f.client.waiter).toHaveBeenCalledOnce();
});
it("joins the original pending launch and adopts its actual ACK before canceling", async () => {
  const f = fixture(),
    pending = deferred<unknown>();
  f.client.command.mockImplementation(async (_execution, action) =>
    action === "benchmark_launch"
      ? pending.promise
      : { ...f.launch, job: "confirmed", gpu: "confirmed" },
  );
  const launch = f.execution.launch(f.signal);
  void launch.catch(() => {});
  await vi.waitFor(() => expect(f.client.command).toHaveBeenCalledOnce());
  let closed = false;
  const close = f.execution.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.client.waiter).not.toHaveBeenCalled();
  pending.resolve(f.launch);
  await close;
  await expect(launch).rejects.toThrow();
  expect(f.client.command.mock.calls.map((row) => row[1])).toEqual([
    "benchmark_launch",
    "benchmark_cancel",
  ]);
});
it("recovers a lost launch ACK through the same original request before retiring its issued owner", async () => {
  const f = fixture();
  f.client.command.mockRejectedValueOnce(Error("LOST_LAUNCH_ACK"));
  await expect(f.execution.launch(f.signal)).rejects.toThrow("LOST_LAUNCH_ACK");
  await f.execution.close();
  expect(f.client.command.mock.calls.map((row) => row[1])).toEqual([
    "benchmark_launch",
    "benchmark_recover",
    "benchmark_cancel",
  ]);
  expect(
    f.execution.launchForSession(f.client as unknown as StoreSessionClient),
  ).toEqual(f.launch);
});
it("accepts only the exact no-owner terminal recovery and never fabricates a Prepare launch", async () => {
  const f = fixture();
  f.client.command
    .mockRejectedValueOnce(Error("NO_ISSUED_ACK"))
    .mockResolvedValueOnce({
      version: 1,
      requestId: f.request.requestId,
      inventorySha256: f.request.binding.inventorySha256,
      state: "retired",
      job: "confirmed",
      gpu: "confirmed",
    });
  await expect(f.execution.launch(f.signal)).rejects.toThrow("NO_ISSUED_ACK");
  await f.execution.close();
  expect(
    f.execution.launchForSession(f.client as unknown as StoreSessionClient),
  ).toBeUndefined();
  expect(f.client.command.mock.calls.map((row) => row[1])).toEqual([
    "benchmark_launch",
    "benchmark_recover",
  ]);
});
it("preserves original failed cancel and retries only the same owner on explicit recovery", async () => {
  const f = fixture();
  await f.execution.launch(f.signal);
  f.client.command.mockRejectedValueOnce(Error("CANCEL_UNKNOWN"));
  const original = f.execution.close();
  await expect(original).rejects.toThrow("CANCEL_UNKNOWN");
  expect(f.execution.close()).toBe(original);
  expect(f.client.waiter).not.toHaveBeenCalled();
  await f.execution.recoverClose();
  expect(f.client.command.mock.calls.map((row) => row[1])).toEqual([
    "benchmark_launch",
    "benchmark_cancel",
    "benchmark_cancel",
  ]);
  expect(f.client.waiter).toHaveBeenCalledOnce();
  await expect(original).rejects.toThrow("CANCEL_UNKNOWN");
});
it("retains a positive original cancel ACK when waiting-helper retirement fails", async () => {
  const f = fixture();
  await f.execution.launch(f.signal);
  f.client.waiter.mockRejectedValueOnce(Error("WAITER_UNKNOWN"));
  await expect(f.execution.close()).rejects.toThrow("WAITER_UNKNOWN");
  await f.execution.recoverClose();
  expect(f.client.command.mock.calls.map((row) => row[1])).toEqual([
    "benchmark_launch",
    "benchmark_cancel",
  ]);
  expect(f.client.waiter).toHaveBeenCalledTimes(2);
  expect(f.client.globalClose).not.toHaveBeenCalled();
});
it("does not mark close complete before the original in-flight event wait joins", async () => {
  const f = fixture(),
    waiting = deferred<unknown>();
  f.client.command.mockImplementation(async (_execution, action) =>
    action === "benchmark_wait"
      ? waiting.promise
      : action === "benchmark_cancel"
        ? { ...f.launch, job: "confirmed", gpu: "confirmed" }
        : f.launch,
  );
  const run = f.execution.run(f.signal);
  void run.catch(() => {});
  await vi.waitFor(() =>
    expect(
      f.client.command.mock.calls.some((row) => row[1] === "benchmark_wait"),
    ).toBe(true),
  );
  let closed = false;
  const close = f.execution.close().then(() => {
    closed = true;
  });
  await vi.waitFor(() =>
    expect(
      f.client.command.mock.calls.some((row) => row[1] === "benchmark_cancel"),
    ).toBe(true),
  );
  expect(closed).toBe(false);
  expect(f.client.waiter).not.toHaveBeenCalled();
  waiting.resolve({ ...f.launch, state: "completed", result: f.result });
  await close;
  await expect(run).rejects.toThrow();
});
it("denies reading before a fulfilled run and scrubs mismatched result bytes", async () => {
  const f = fixture();
  await expect(f.execution.readResult()).rejects.toThrow();
  await f.execution.run(f.signal);
  const foreign = Buffer.from("foreign");
  boundary.read.mockResolvedValue(foreign);
  await expect(f.execution.readResult()).rejects.toThrow();
  expect(foreign.every((value) => value === 0)).toBe(true);
  await f.execution.close();
});

it("exposes only frozen completed result observations and denies early or retired observations", async () => {
  const f = fixture();
  expect(() => f.execution.resultObservation()).toThrow();
  await f.execution.run(f.signal);
  const observation = f.execution.resultObservation();
  expect(observation).toEqual(f.result);
  expect(Object.isFrozen(observation)).toBe(true);
  expect(observation).not.toHaveProperty("owner");
  await f.execution.close();
  expect(() => f.execution.resultObservation()).toThrow();
});
