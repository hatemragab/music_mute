import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";

// Synthetic receiving/lifetime tests of the actual Session client class. Only
// its existing Store-native factory boundary is mocked; these objects cannot
// prove Windows helper death, genuine Store origin, Creator, Job or GPU rights.
const boundary = vi.hoisted(() => ({
  open: vi.fn<() => Promise<unknown>>(),
  data: vi.fn<(authority: object) => Promise<unknown>>(),
  code: vi.fn<(authority: object) => Promise<unknown>>(),
  session:
    vi.fn<
      (
        authority: object,
        code: object,
        operation: string,
        input: Record<string, unknown>,
      ) => Promise<unknown>
    >(),
  authorityClose: vi.fn<(authority: object) => Promise<void>>(),
  codeClose: vi.fn<(code: object) => Promise<void>>(),
  codeCheck: vi.fn<(code: object) => Promise<void>>(),
  codeCleanupCheck: vi.fn<(code: object) => Promise<void>>(),
  binding: vi.fn<(code: object) => Promise<unknown>>(),
}));
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreNativeAuthority: class {
    static open() {
      return boundary.open();
    }
    openGuiDataNative() {
      return boundary.data(this);
    }
    openWorkerCode() {
      return boundary.code(this);
    }
    storeSessionOperation(
      code: object,
      operation: string,
      input: Record<string, unknown>,
    ) {
      return boundary.session(this, code, operation, input);
    }
    close() {
      return boundary.authorityClose(this);
    }
  },
  StoreWorkerCodeAuthority: class {
    assertDataNative() {
      /* Mock receiving boundary, never an OS authority. */
    }
    revalidate() {
      return boundary.codeCheck(this);
    }
    revalidateCleanup() {
      return boundary.codeCleanupCheck(this);
    }
    preparationBinding() {
      return boundary.binding(this);
    }
    activateSession() {
      return Promise.resolve();
    }
    close() {
      return boundary.codeClose(this);
    }
  },
}));
import {
  StoreNativeAuthority,
  StoreWorkerCodeAuthority,
} from "../src/main/browser/store-native.js";
import { StoreSessionClient } from "../src/main/session/store-session-client.js";
import { parseStorePrepareLaunch } from "../src/shared/store-prepare-contracts.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { bootIdentity, gpu, sid } from "./fixtures/prepare.js";

const product = STORE_PRODUCTS.worker;
const request = parseStorePrepareLaunch(
  Buffer.from(
    JSON.stringify({
      version: 1,
      requestId: "12345678-1234-4234-8234-123456789012",
      operation: "qualify",
      binding: {
        package: {
          identityName: product.identityName,
          publisher: product.publisher,
          publisherId: product.publisherId,
          familyName: product.familyName,
          fullName: `${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
          packageVersion: "0.1.3.2",
          architecture: "x64",
          signatureKind: 3,
          healthy: true,
          current: true,
          installedLocation: `C:\\Program Files\\WindowsApps\\${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
        },
        inventorySha256: "c".repeat(64),
        runtimeManifestSha256: "b".repeat(64),
        sid,
        bootIdentity,
        recipeDigests: {
          "kim-vocals-v2": "0".repeat(64),
          "kim-vocals-v2-trim": "1".repeat(64),
        },
      },
      gpu,
      fixture: { kind: "fixed" },
    }),
  ),
);
const identity = {
  sid,
  sessionId: 1,
  pid: 345,
  creationTime: "132000000000000000",
};
const launch = {
  version: 1,
  requestId: request.requestId,
  inventorySha256: request.binding.inventorySha256,
  owner: { role: "prepare", nonce: "a".repeat(64), identity },
};
const observation = {
  version: 1,
  owner: { ...launch.owner, role: "session-agent" },
  creator: { ...identity, pid: 123, creationTime: "131000000000000000" },
  inventorySha256: request.binding.inventorySha256,
};
const failureEvent = {
  ...launch,
  state: "failed",
  errorCode: "OPERATION_FAILED",
};
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let main: StoreNativeAuthority, waiting: StoreNativeAuthority;
let mainCode: StoreWorkerCodeAuthority, waitingCode: StoreWorkerCodeAuthority;
let codes: Map<object, StoreWorkerCodeAuthority>;
async function setup() {
  const host = {
    native: {},
    storeAuthority: main,
    identity: { sessionId: 1 },
  } as unknown as HostContext;
  const client = await StoreSessionClient.open(host, mainCode, {
    launchIfAbsent: false,
  });
  const held = await client.launchPrepare(request);
  return { client, held, host };
}
function waitResult(
  client: StoreSessionClient,
  held: Awaited<ReturnType<StoreSessionClient["launchPrepare"]>>,
) {
  const result = client.awaitPrepareResult(held, {
    signal: new AbortController().signal,
  });
  // A deliberate deferred rejection is observed from the start of each race.
  void result.catch(() => undefined);
  return result;
}
function waitingCloses() {
  return boundary.session.mock.calls.filter(
    ([authority, , operation]) =>
      authority === waiting && operation === "store_session_close",
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  const fakeProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperties(fakeProcess, {
    platform: { value: "win32" },
    arch: { value: "x64" },
  });
  vi.stubGlobal("process", fakeProcess);
  main = Object.create(StoreNativeAuthority.prototype) as StoreNativeAuthority;
  waiting = Object.create(
    StoreNativeAuthority.prototype,
  ) as StoreNativeAuthority;
  mainCode = Object.create(
    StoreWorkerCodeAuthority.prototype,
  ) as StoreWorkerCodeAuthority;
  waitingCode = Object.create(
    StoreWorkerCodeAuthority.prototype,
  ) as StoreWorkerCodeAuthority;
  codes = new Map([
    [main, mainCode],
    [waiting, waitingCode],
  ]);
  boundary.open.mockResolvedValue(waiting);
  boundary.data.mockResolvedValue(undefined);
  boundary.code.mockImplementation(async (authority) => codes.get(authority));
  boundary.binding.mockResolvedValue(request.binding);
  boundary.authorityClose.mockResolvedValue(undefined);
  boundary.codeClose.mockResolvedValue(undefined);
  boundary.codeCheck.mockResolvedValue(undefined);
  boundary.codeCleanupCheck.mockResolvedValue(undefined);
  boundary.session.mockImplementation(
    async (_authority, _code, operation, input) => {
      if (operation === "store_session_open") return observation;
      if (operation === "store_session_close") return { closed: true };
      const command = input.command as { action: string };
      if (
        command.action === "prepare_launch" ||
        command.action === "prepare_recover"
      )
        return launch;
      if (command.action === "prepare_cancel")
        return { ...launch, job: "confirmed", gpu: "confirmed" };
      if (command.action === "prepare_wait") return failureEvent;
      throw new Error("UNEXPECTED_SYNTHETIC_COMMAND");
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Store Session original waiter retirement (synthetic factories)", () => {
  it("uses the original cleanup check for cancellation while ordinary new work remains invalid", async () => {
    const { client, held, host } = await setup();
    boundary.codeCheck.mockClear();
    boundary.codeCleanupCheck.mockClear();
    boundary.codeCheck.mockRejectedValue(Error("SYNTHETIC_WATCH_INVALIDATED"));
    await client.cancelPrepare(held);
    expect(boundary.codeCleanupCheck).toHaveBeenCalledWith(mainCode);
    expect(boundary.codeCheck).not.toHaveBeenCalled();
    await expect(
      StoreSessionClient.open(host, mainCode, { launchIfAbsent: false }),
    ).rejects.toThrow("SYNTHETIC_WATCH_INVALIDATED");
    expect(boundary.codeCheck).toHaveBeenCalledWith(mainCode);
    await client.close();
  });
  it("joins the original pending waiter close before class close can succeed", async () => {
    const gate = deferred<void>();
    boundary.authorityClose.mockImplementation((authority) =>
      authority === waiting ? gate.promise : Promise.resolve(),
    );
    const { client, held } = await setup(),
      result = waitResult(client, held);
    await vi.waitFor(() =>
      expect(boundary.authorityClose).toHaveBeenCalledWith(waiting),
    );
    await client.cancelPrepare(held);
    expect(client.cleanupPending()).toBe(true);
    let finished = false;
    const closing = client.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(waitingCloses()).toHaveLength(1);
    gate.resolve();
    await expect(result).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    await closing;
    expect(client.cleanupPending()).toBe(false);
    expect(
      boundary.codeClose.mock.calls.filter(([code]) => code === waitingCode),
    ).toHaveLength(1);
    expect(
      boundary.authorityClose.mock.calls.filter(
        ([authority]) => authority === waiting,
      ),
    ).toHaveLength(1);
    expect(
      boundary.authorityClose.mock.calls.some(
        ([authority]) => authority === main,
      ),
    ).toBe(false);
    expect(boundary.open).toHaveBeenCalledTimes(1);
  });
  it("retains a failed code close and explicitly recovers using the same successful helper-retirement proof", async () => {
    const original = new Error("ORIGINAL_CODE_CLOSE_FAILED");
    boundary.codeClose.mockRejectedValue(original);
    const { client, held } = await setup(),
      result = waitResult(client, held);
    await expect(result).rejects.toBe(original);
    expect(boundary.authorityClose).toHaveBeenCalledWith(waiting);
    await client.cancelPrepare(held);
    expect(client.cleanupPending()).toBe(true);
    await client.recoverCleanup();
    expect(client.cleanupPending()).toBe(false);
    await expect(result).rejects.toBe(original);
    expect(waitingCloses()).toHaveLength(1);
    expect(boundary.codeClose).toHaveBeenCalledTimes(1);
    expect(boundary.authorityClose).toHaveBeenCalledTimes(1);
    await client.close();
  });
  it("keeps an original failed helper retirement pending across recovery and repeated close", async () => {
    const original = new Error("ORIGINAL_HELPER_RETIREMENT_FAILED");
    boundary.authorityClose.mockRejectedValue(original);
    const { client, held } = await setup(),
      result = waitResult(client, held);
    await expect(result).rejects.toBe(original);
    await client.cancelPrepare(held);
    await expect(client.recoverCleanup()).rejects.toBe(original);
    const closing = client.close();
    await expect(closing).rejects.toBe(original);
    expect(client.close()).toBe(closing);
    expect(client.cleanupPending()).toBe(true);
    expect(boundary.authorityClose).toHaveBeenCalledTimes(1);
    expect(boundary.open).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "retains a partial factory owner and attempts helper close after code close fails (helper failure=%s)",
    async (helperFailure) => {
      const construction = new Error("CONSTRUCTION_BINDING_FAILED"),
        codeFailure = new Error("PARTIAL_CODE_CLOSE_FAILED"),
        retirement = new Error("PARTIAL_HELPER_CLOSE_FAILED");
      boundary.binding.mockImplementation(async (code) => {
        if (code === waitingCode) throw construction;
        return request.binding;
      });
      boundary.codeClose.mockRejectedValue(codeFailure);
      if (helperFailure) boundary.authorityClose.mockRejectedValue(retirement);
      const { client, held } = await setup(),
        result = waitResult(client, held);
      await expect(result).rejects.toBe(codeFailure);
      expect(waitingCloses()).toHaveLength(0);
      expect(boundary.authorityClose).toHaveBeenCalledWith(waiting);
      await client.cancelPrepare(held);
      expect(client.cleanupPending()).toBe(true);
      if (helperFailure) {
        await expect(client.recoverCleanup()).rejects.toBe(retirement);
        expect(client.cleanupPending()).toBe(true);
      } else {
        await client.recoverCleanup();
        expect(client.cleanupPending()).toBe(false);
        await client.close();
      }
      expect(boundary.codeClose).toHaveBeenCalledTimes(1);
      expect(boundary.authorityClose).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["close", "recover"] as const)(
    "tracks in-construction ownership so %s joins the same factory and retires its returned helper",
    async (operation) => {
      const factory = deferred<StoreNativeAuthority>();
      boundary.open.mockReturnValue(factory.promise);
      const { client, held } = await setup(),
        result = waitResult(client, held);
      await vi.waitFor(() => expect(boundary.open).toHaveBeenCalledTimes(1));
      let finished = false;
      const closing = (
        operation === "close" ? client.close() : client.recoverCleanup()
      ).then(() => {
        finished = true;
      });
      await vi.waitFor(() =>
        expect(
          boundary.session.mock.calls.some(
            ([, , , input]) =>
              (input.command as { action?: string } | undefined)?.action ===
              "prepare_cancel",
          ),
        ).toBe(true),
      );
      expect(finished).toBe(false);
      expect(client.cleanupPending()).toBe(true);
      factory.resolve(waiting);
      await expect(result).rejects.toThrow("STORE_SESSION_CLIENT_DENIED");
      await closing;
      expect(boundary.data).not.toHaveBeenCalled();
      expect(boundary.code).not.toHaveBeenCalled();
      expect(boundary.authorityClose).toHaveBeenCalledExactlyOnceWith(waiting);
      expect(client.cleanupPending()).toBe(false);
      if (operation === "recover") await client.close();
    },
  );
  it("does not infer helper-death proof when the original factory rejects without publishing an authority", async () => {
    const original = new Error("FACTORY_RETIREMENT_UNCONFIRMED");
    boundary.open.mockRejectedValue(original);
    const { client, held } = await setup(),
      result = waitResult(client, held);
    await expect(result).rejects.toBe(original);
    await client.cancelPrepare(held);
    expect(client.cleanupPending()).toBe(true);
    await expect(client.recoverCleanup()).rejects.toBe(original);
    await expect(client.close()).rejects.toBe(original);
    expect(boundary.authorityClose).not.toHaveBeenCalled();
    expect(boundary.open).toHaveBeenCalledTimes(1);
  });
  it("joins waiter retirement even while the processing-role cleanup fails, without reporting the role clean", async () => {
    const gate = deferred<void>(),
      roleFailure = new Error("ORIGINAL_ROLE_CLEANUP_FAILED");
    boundary.authorityClose.mockReturnValue(gate.promise);
    const normal = boundary.session.getMockImplementation()!;
    let failRole = true;
    boundary.session.mockImplementation(async (...args) => {
      if (
        (args[3].command as { action?: string } | undefined)?.action ===
          "prepare_cancel" &&
        failRole
      )
        throw roleFailure;
      return normal(...args);
    });
    const { client, held } = await setup(),
      result = waitResult(client, held);
    await vi.waitFor(() =>
      expect(boundary.authorityClose).toHaveBeenCalledTimes(1),
    );
    const recovery = client.recoverCleanup();
    void recovery.catch(() => undefined);
    gate.resolve();
    await expect(result).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    await expect(recovery).rejects.toBe(roleFailure);
    expect(client.cleanupPending()).toBe(true);
    failRole = false;
    await client.recoverCleanup();
    expect(client.cleanupPending()).toBe(false);
    expect(boundary.authorityClose).toHaveBeenCalledTimes(1);
    await client.close();
  });
});
