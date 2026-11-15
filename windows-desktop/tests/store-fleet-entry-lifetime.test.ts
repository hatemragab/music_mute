import { beforeEach, expect, it, vi } from "vitest";
import {
  createFleetWorkerRuntime,
  runFleetChildEntry,
  runFleetSessionChild,
} from "../src/agent/fleet.js";
import { StoreFleetChildContext } from "../src/main/session/store-fleet-child-context.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
import { StoreFleetTransfers } from "../src/main/fleet/store-transfers.js";
import { record } from "./fleet-fixtures.js";

// Synthetic private module boundaries exercise the real entry's selection and
// lifetime ordering. They provide no native, installed Store, or GPU evidence.
const boundary = vi.hoisted(() => ({
  create: vi.fn(),
  serve: vi.fn(),
  verifyPeer: vi.fn(),
  closeContext: vi.fn(),
  contextOpen: vi.fn(),
  openLegacy: vi.fn(),
  verifyLegacy: vi.fn(),
  readRecord: vi.fn(),
  closeTransfers: vi.fn(),
  createAdmission: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock("../src/main/session/store-fleet-child-context.js", () => ({
  StoreFleetChildContext: class {
    #associated = true;
    constructor(fields: object) {
      Object.assign(this, fields);
    }
    static open() {
      return boundary.contextOpen();
    }
    assertAssociation() {
      if (!this.#associated) throw Error("FOREIGN_CONTEXT");
    }
    close() {
      this.assertAssociation();
      return boundary.closeContext();
    }
  },
}));
vi.mock("../src/main/session/store-node-issuer.js", () => ({
  StoreNodeIssuer: class {
    #owned = true;
    serveControl(...args: unknown[]) {
      if (!this.#owned) throw Error("FOREIGN_ISSUER");
      return boundary.serve(...args);
    }
    verifyControlPeer(...args: unknown[]) {
      if (!this.#owned) throw Error("FOREIGN_ISSUER");
      return boundary.verifyPeer(...args);
    }
  },
}));
vi.mock("../src/main/fleet/store-transfers.js", () => ({
  StoreFleetTransfers: class {
    #owned = true;
    close() {
      if (!this.#owned) throw Error("FOREIGN_TRANSFERS");
      return boundary.closeTransfers();
    }
  },
}));
vi.mock("../src/main/fleet/store-worker-runtime.js", () => ({
  createStoreFleetWorkerRuntime: (...args: unknown[]) =>
    boundary.create(...args),
}));
vi.mock("../src/main/session/bootstrap.js", () => ({
  openSessionChildContext: (...args: unknown[]) => boundary.openLegacy(...args),
}));
vi.mock("../../worker/src/platform/windows/release-manifest.js", () => ({
  verifyWindowsRelease: (...args: unknown[]) => boundary.verifyLegacy(...args),
}));
vi.mock("../src/main/fleet/store.js", () => ({
  VaultFleetStore: class {
    read() {
      return boundary.readRecord();
    }
  },
}));
vi.mock("../src/main/fleet/runtime-control.js", () => ({
  FleetRuntimeControl: class {},
}));
vi.mock("../src/main/fleet/role-control.js", () => ({
  FleetRoleControl: class {
    guardHeld() {
      return true;
    }
    releaseAfterExit() {}
    execute(...args: unknown[]) {
      return boundary.executeCommand(...args);
    }
  },
}));
vi.mock("../src/main/admission/session-admission.js", () => ({
  createFleetPersonalAdmission: (...args: unknown[]) =>
    boundary.createAdmission(...args),
}));

function fixture() {
  const saved = record(),
    personalAdmission = {
      start: vi.fn(),
      pending: vi.fn(() => false),
      grant: vi.fn(),
      stop: vi.fn(),
      setPending: vi.fn(),
    },
    runtime = {
      run: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      hintAvailableWork: vi.fn(),
    },
    transfers = new (
      StoreFleetTransfers as unknown as new () => StoreFleetTransfers
    )(),
    context = new (
      StoreFleetChildContext as unknown as new (
        fields: object,
      ) => StoreFleetChildContext
    )({
      distribution: "microsoft-store",
      role: "fleet",
      ownershipNonce: "a".repeat(64),
      ownerIdentity: {
        sid: saved.sid,
        sessionId: 1,
        pid: 100,
        createdAt: "11",
      },
      fleetRoot: "C:\\Synthetic\\Fleet",
      native: {},
      storeIssuer: new (
        StoreNodeIssuer as unknown as new () => StoreNodeIssuer
      )(),
    });
  boundary.readRecord.mockResolvedValue(saved);
  boundary.contextOpen.mockResolvedValue(context);
  boundary.createAdmission.mockReturnValue(personalAdmission);
  boundary.create.mockResolvedValue({
    runtime,
    transfers,
    inference: { idle: () => true },
    gpu: { luid: "0011223344556677" },
  });
  return { context, saved, personalAdmission, runtime, transfers };
}
beforeEach(() => {
  for (const spy of Object.values(boundary)) spy.mockReset();
  boundary.serve.mockResolvedValue(undefined);
  boundary.verifyPeer.mockResolvedValue(true);
  boundary.closeContext.mockResolvedValue(undefined);
  boundary.closeTransfers.mockResolvedValue(undefined);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("selects the Store factory and returns its exact runtime without the Legacy release path", async () => {
  const f = fixture();
  await expect(
    createFleetWorkerRuntime(f.context, f.saved, f.personalAdmission),
  ).resolves.toBe(f.runtime);
  expect(boundary.create).toHaveBeenCalledWith(
    f.context,
    f.saved,
    f.personalAdmission,
  );
  expect(boundary.verifyLegacy).not.toHaveBeenCalled();
  expect(boundary.openLegacy).not.toHaveBeenCalled();
});

it("rejects a labeled clone before opening a runtime", async () => {
  const f = fixture();
  await expect(
    createFleetWorkerRuntime(
      { ...f.context } as StoreFleetChildContext,
      f.saved,
      f.personalAdmission,
    ),
  ).rejects.toThrow("FLEET_CONTEXT_INVALID");
  expect(boundary.create).not.toHaveBeenCalled();
});

it("attempts both original retirements after synchronous runtime stop failure", async () => {
  const f = fixture(),
    serveError = Error("serve failed"),
    stopError = Error("stop failed"),
    transferError = Error("transfers failed");
  boundary.serve.mockRejectedValue(serveError);
  f.runtime.stop.mockImplementation(() => {
    throw stopError;
  });
  boundary.closeTransfers.mockImplementation(() => {
    throw transferError;
  });
  const error = await runFleetSessionChild(f.context, f).catch(
    (value) => value,
  );
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([serveError, stopError, transferError]);
  expect(f.runtime.stop).toHaveBeenCalledTimes(1);
  expect(boundary.closeTransfers).toHaveBeenCalledTimes(1);
});

it("joins original transfer closure before settling the child", async () => {
  const f = fixture(),
    closing = deferred();
  boundary.closeTransfers.mockReturnValue(closing.promise);
  let settled = false;
  const running = runFleetSessionChild(f.context, f).finally(() => {
    settled = true;
  });
  await vi.waitFor(() =>
    expect(boundary.closeTransfers).toHaveBeenCalledOnce(),
  );
  expect(settled).toBe(false);
  closing.resolve();
  await running;
  expect(f.runtime.stop).toHaveBeenCalledOnce();
});

it("retains the original runtime rejection alongside serve and retirement errors", async () => {
  const f = fixture(),
    runtimeError = Error("runtime failed"),
    serveError = Error("serve failed"),
    transferError = Error("transfers failed");
  f.runtime.run.mockRejectedValue(runtimeError);
  boundary.serve.mockRejectedValue(serveError);
  boundary.closeTransfers.mockRejectedValue(transferError);
  const error = await runFleetSessionChild(f.context, f).catch(
    (value) => value,
  );
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([serveError, transferError, runtimeError]);
});

it.each([undefined, null, false, 0, ""])(
  "retains a falsy runtime rejection (%s)",
  async (reason) => {
    const f = fixture();
    f.runtime.run.mockRejectedValue(reason);
    let resolved = false,
      caught: unknown = Symbol("not caught");
    await runFleetSessionChild(f.context, f).then(
      () => {
        resolved = true;
      },
      (value) => {
        caught = value;
      },
    );
    expect(resolved).toBe(false);
    expect(caught).toBe(reason);
    expect(boundary.closeTransfers).toHaveBeenCalledOnce();
  },
);

it("selects the no-argument Store entry and closes its original context after transfers", async () => {
  const f = fixture(),
    closing = deferred();
  boundary.closeTransfers.mockReturnValue(closing.promise);
  const running = runFleetChildEntry(["--store-session"]);
  await vi.waitFor(() =>
    expect(boundary.closeTransfers).toHaveBeenCalledOnce(),
  );
  expect(boundary.closeContext).not.toHaveBeenCalled();
  closing.resolve();
  await running;
  expect(boundary.closeContext).toHaveBeenCalledOnce();
  expect(boundary.contextOpen).toHaveBeenCalledOnce();
  expect(boundary.createAdmission).toHaveBeenCalledWith(f.context);
  expect(boundary.openLegacy).not.toHaveBeenCalled();
});

it("preserves the original child error when the same context also fails to close", async () => {
  fixture();
  const serveError = Error("serve failed"),
    contextError = Error("context close failed");
  boundary.serve.mockRejectedValue(serveError);
  boundary.closeContext.mockRejectedValue(contextError);
  const error = await runFleetChildEntry(["--store-session"]).catch(
    (value) => value,
  );
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([serveError, contextError]);
});

it("verifies the Session peer before parsing or executing a Store command", async () => {
  const f = fixture(),
    peer = { synthetic: "peer" };
  boundary.verifyPeer.mockResolvedValue(false);
  boundary.serve.mockImplementation(async ({ dispatch }) => {
    await dispatch(Buffer.from("malformed"), peer);
  });
  await expect(runFleetSessionChild(f.context, f)).rejects.toThrow(
    "FLEET_CONTEXT_INVALID",
  );
  expect(boundary.verifyPeer).toHaveBeenCalledWith(peer, "session-agent");
  expect(boundary.executeCommand).not.toHaveBeenCalled();
  expect(boundary.closeTransfers).toHaveBeenCalledOnce();
});

it("dispatches a parsed command and keeps unexpected diagnostics off the wire", async () => {
  const f = fixture(),
    command = {
      version: 1,
      requestId: "cf819600-d56f-4c03-9f43-03c353a0ba54",
      action: "stop",
    };
  boundary.executeCommand.mockRejectedValue(Error("synthetic private detail"));
  boundary.serve.mockImplementation(async ({ dispatch }) => {
    const reply = await dispatch(Buffer.from(JSON.stringify(command)), {});
    expect(JSON.parse(reply.toString())).toEqual({
      version: 1,
      requestId: command.requestId,
      ok: false,
      code: "FLEET_CONTROL_UNAVAILABLE",
    });
  });
  await runFleetSessionChild(f.context, f);
  expect(boundary.executeCommand).toHaveBeenCalledWith(command);
});

it("denies malformed Store commands without reflecting their bytes", async () => {
  const f = fixture();
  boundary.serve.mockImplementation(async ({ dispatch }) => {
    const reply = await dispatch(Buffer.from("malformed private data"), {});
    expect(JSON.parse(reply.toString())).toEqual({
      version: 1,
      requestId: "",
      ok: false,
      code: "FLEET_CONTROL_UNAVAILABLE",
    });
  });
  await runFleetSessionChild(f.context, f);
  expect(boundary.executeCommand).not.toHaveBeenCalled();
});

it.each(
  [["--store-session", "extra"], ["--consumer-config"], []].map((argv) => ({
    argv,
  })),
)(
  "rejects malformed entry arguments before opening any context ($argv)",
  async ({ argv }) => {
    fixture();
    await expect(runFleetChildEntry(argv)).rejects.toThrow(
      "FLEET_CONTEXT_INVALID",
    );
    expect(boundary.contextOpen).not.toHaveBeenCalled();
    expect(boundary.openLegacy).not.toHaveBeenCalled();
  },
);
