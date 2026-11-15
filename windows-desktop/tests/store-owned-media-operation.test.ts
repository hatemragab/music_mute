import { expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
// Synthetic module receiving boundaries exercise the real adapter's order,
// exact object handoff and failures. They do not confer Windows Store rights.
const boundary = vi.hoisted(() => {
  class Operation {
    #host: unknown;
    constructor(host: unknown) {
      this.#host = host;
    }
    assertHost(host: unknown) {
      if (host !== this.#host) throw Error("FOREIGN_HOST");
    }
  }
  class GuiOperation {
    #host: unknown;
    constructor(host: unknown) {
      this.#host = host;
    }
    assertHost(host: unknown) {
      if (host !== this.#host) throw Error("FOREIGN_GUI_HOST");
    }
  }
  class CpuExecution {
    readonly owner: Operation | GuiOperation;
    prepareImpl = vi.fn();
    runImpl = vi.fn();
    closeImpl = vi.fn();
    readImpl = vi.fn();
    constructor(host: unknown, gui = false) {
      this.owner = gui ? new GuiOperation(host) : new Operation(host);
      this.prepareImpl.mockResolvedValue(this.owner);
      this.closeImpl.mockResolvedValue(undefined);
      this.runImpl.mockResolvedValue(undefined);
      this.readImpl.mockResolvedValue(Buffer.from('{"value":42}'));
    }
    prepare(signal: AbortSignal) {
      return this.prepareImpl(signal);
    }
    run(signal: AbortSignal) {
      return this.runImpl(signal);
    }
    readResult() {
      return this.readImpl();
    }
    close() {
      return this.closeImpl();
    }
  }
  class Execution extends CpuExecution {}
  class GuiExecution extends CpuExecution {
    constructor(host: unknown) {
      super(host, true);
    }
  }
  class Tools {
    #host: unknown;
    execution: Execution | GuiExecution;
    configure: unknown;
    constructor(host: unknown, gui = false) {
      this.#host = host;
      this.execution = gui ? new GuiExecution(host) : new Execution(host);
    }
    assertHost(host: unknown) {
      if (host !== this.#host) throw Error("FOREIGN_HOST");
    }
    snapshotMediaTools() {
      return Promise.resolve({
        releaseRoot: "C:\\Program Files\\WindowsApps\\Fixture\\worker",
        releaseIdentity: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        nativeSha256: "c".repeat(64),
        ffmpegPath: "fixed",
        ffprobePath: "fixed",
      });
    }
    openMedia(configuration: unknown) {
      this.configure = configuration;
      return Promise.resolve(this.execution);
    }
  }
  return { Operation, GuiOperation, Execution, GuiExecution, Tools };
});
vi.mock("../src/main/prepare/store-media-tools.js", () => ({
  StoreMediaTools: boundary.Tools,
}));
vi.mock("../src/main/session/store-media-runner.js", () => ({
  StoreMediaExecution: boundary.Execution,
}));
vi.mock("../src/main/session/store-cpu-operation.js", () => ({
  StoreCpuOperation: boundary.Operation,
}));
vi.mock("../src/main/session/store-gui-media.js", () => ({
  StoreGuiMediaExecution: boundary.GuiExecution,
  StoreGuiCpuOperation: boundary.GuiOperation,
}));
import {
  runOwnedMediaOperation,
  MediaShutdownPending,
} from "../src/main/prepare/owned-media-operation.js";
function fixture(gui = false) {
  const host = {
      native: {},
      storeAuthority: {},
      prepareLease: vi.fn(),
    } as unknown as HostContext,
    tools = new boundary.Tools(host, gui),
    events: string[] = [],
    before = vi.fn(async () => {
      events.push("before");
    }),
    onOwner = vi.fn(async (owner: unknown) => {
      expect(owner).toBe(tools.execution.owner);
      events.push("owner");
    }),
    configure = vi.fn(() => ({ operation: "diagnostics_doctor" })),
    options = {
      host,
      tools,
      signal: new AbortController().signal,
      configuration: configure,
      resultRelative: vi.fn(() => "caller-path-is-never-used"),
      parse: (value: unknown) => value,
      maxResultBytes: 4096,
      beforeLaunch: before,
      onOwner,
    };
  tools.execution.prepareImpl.mockImplementation(async () => {
    events.push("prepare");
    return tools.execution.owner;
  });
  tools.execution.runImpl.mockImplementation(async () => {
    events.push("run");
  });
  tools.execution.readImpl.mockImplementation(async () => {
    events.push("result");
    return Buffer.from('{"value":42}');
  });
  tools.execution.closeImpl.mockImplementation(async () => {
    events.push("close");
  });
  return { host, tools, options, events, before, onOwner, configure };
}
it("hands the original private CPU operation to workspace before any child, then reads fixed result and closes only that execution", async () => {
  const f = fixture();
  await expect(runOwnedMediaOperation(f.options)).resolves.toEqual({
    value: 42,
  });
  expect(f.events).toEqual([
    "before",
    "prepare",
    "owner",
    "run",
    "result",
    "close",
  ]);
  expect(f.options.resultRelative).not.toHaveBeenCalled();
  expect(f.host.prepareLease).not.toHaveBeenCalled();
});
it("a failed workspace handoff closes the same operation without running tools", async () => {
  const f = fixture(),
    failure = Error("WORKSPACE_UNAVAILABLE");
  f.onOwner.mockRejectedValue(failure);
  await expect(runOwnedMediaOperation(f.options)).rejects.toBe(failure);
  expect(f.tools.execution.runImpl).not.toHaveBeenCalled();
  expect(f.tools.execution.closeImpl).toHaveBeenCalledOnce();
});
it("retains both original work and cleanup failures as MediaShutdownPending for workspace fencing", async () => {
  const f = fixture(),
    work = Error("TOOL_FAILED"),
    cleanup = Error("OWNED_JOB_UNKNOWN");
  f.tools.execution.runImpl.mockRejectedValue(work);
  f.tools.execution.closeImpl.mockRejectedValue(cleanup);
  const error = await runOwnedMediaOperation(f.options).catch(
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(MediaShutdownPending);
  expect((error as Error).cause).toBeInstanceOf(AggregateError);
  expect(((error as Error).cause as AggregateError).errors).toEqual([
    work,
    cleanup,
  ]);
});
it("rejects oversized or malformed result bytes but still closes the original CPU execution", async () => {
  for (const bytes of [Buffer.alloc(4097), Buffer.from("not-json")]) {
    const f = fixture();
    f.tools.execution.readImpl.mockResolvedValue(bytes);
    await expect(runOwnedMediaOperation(f.options)).rejects.toThrow();
    expect(f.tools.execution.closeImpl).toHaveBeenCalledOnce();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  }
});
it("abort after original owner handoff prevents child launch and retains that same owner through close", async () => {
  const f = fixture(),
    abort = new AbortController();
  f.options.signal = abort.signal;
  f.onOwner.mockImplementation(async (owner) => {
    expect(owner).toBe(f.tools.execution.owner);
    abort.abort();
  });
  await expect(runOwnedMediaOperation(f.options)).rejects.toThrow();
  expect(f.tools.execution.runImpl).not.toHaveBeenCalled();
  expect(f.tools.execution.closeImpl).toHaveBeenCalledOnce();
});
it("rejects a substituted Store tools object before legacy preparation", async () => {
  const f = fixture();
  await expect(
    runOwnedMediaOperation({
      ...f.options,
      tools: Object.create(boundary.Tools.prototype),
    }),
  ).rejects.toThrow();
  expect(f.host.prepareLease).not.toHaveBeenCalled();
});
it("keeps the actual GUI CPU execution and original proxy owner distinct from the personal Node class", async () => {
  const f = fixture(true);
  expect(f.tools.execution).toBeInstanceOf(boundary.GuiExecution);
  expect(f.tools.execution).not.toBeInstanceOf(boundary.Execution);
  await expect(runOwnedMediaOperation(f.options)).resolves.toEqual({
    value: 42,
  });
  expect(f.tools.execution.owner).toBeInstanceOf(boundary.GuiOperation);
  expect(f.tools.execution.owner).not.toBeInstanceOf(boundary.Operation);
  expect(f.events).toEqual([
    "before",
    "prepare",
    "owner",
    "run",
    "result",
    "close",
  ]);
  expect(f.host.prepareLease).not.toHaveBeenCalled();
  expect(f.options.resultRelative).not.toHaveBeenCalled();
});
it("preserves GUI CPU cleanup uncertainty after a failed exact owner handoff", async () => {
  const f = fixture(true),
    handoff = Error("GUI_WORKSPACE_HANDOFF_UNKNOWN"),
    cleanup = Error("GUI_CPU_RETIREMENT_UNKNOWN");
  f.onOwner.mockRejectedValue(handoff);
  f.tools.execution.closeImpl.mockRejectedValue(cleanup);
  const error = await runOwnedMediaOperation(f.options).catch(
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(MediaShutdownPending);
  expect(((error as Error).cause as AggregateError).errors).toEqual([
    handoff,
    cleanup,
  ]);
  expect(f.tools.execution.runImpl).not.toHaveBeenCalled();
  expect(f.tools.execution.closeImpl).toHaveBeenCalledOnce();
});
