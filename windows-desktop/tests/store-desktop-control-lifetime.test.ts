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
  binding: vi.fn<(code: object) => Promise<unknown>>(),
  ordinary: vi.fn<() => Promise<void>>(),
  cleanup: vi.fn<() => Promise<void>>(),
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
    creatorProof() {
      return { gui: identity };
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
      return boundary.ordinary();
    }
    revalidateCleanup() {
      return boundary.cleanup();
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
import {
  StoreSessionClient,
  StoreDesktopControlLifetime,
} from "../src/main/session/store-session-client.js";
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
const snapshot = {
  version: 1,
  instance_id: request.requestId,
  release: request.binding.inventorySha256,
  revision: 1,
  phase: "running",
  fleet: { intent: "stopped", phase: "stopped", problem: null },
  personal: { owners: 0, phase: "stopped", problem: null },
  startup: "disabled",
  maintenance: null,
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
let main: StoreNativeAuthority, mainCode: StoreWorkerCodeAuthority;
let next: number,
  helpers: StoreNativeAuthority[],
  codes: Map<object, StoreWorkerCodeAuthority>;
async function setup() {
  const host = {
    native: {},
    storeAuthority: main,
    identity: { sessionId: 1 },
  } as unknown as HostContext;
  return StoreSessionClient.open(host, mainCode, { launchIfAbsent: false });
}
const status = () => ({
  version: 1 as const,
  request_id: request.requestId,
  action: "status" as const,
});
function complete(command: Record<string, unknown>) {
  const input = JSON.parse(
    Buffer.from(command.payload_base64 as string, "base64").toString(),
  ) as { request_id: string };
  return {
    version: 1,
    requestId: command.requestId,
    state: "completed",
    payload_base64: Buffer.from(
      JSON.stringify({
        version: 1,
        request_id: input.request_id,
        ok: true,
        snapshot,
      }),
    ).toString("base64"),
  };
}
const commandRows = () =>
  boundary.session.mock.calls.filter(
    ([, , operation, input]) =>
      operation === "store_session_command" &&
      (input.command as { action: string })?.action === "session_forward",
  );
beforeEach(() => {
  vi.resetAllMocks();
  const fakeProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperties(fakeProcess, {
    platform: { value: "win32" },
    arch: { value: "x64" },
  });
  vi.stubGlobal("process", fakeProcess);
  main = Object.create(StoreNativeAuthority.prototype) as StoreNativeAuthority;
  mainCode = Object.create(
    StoreWorkerCodeAuthority.prototype,
  ) as StoreWorkerCodeAuthority;
  next = 0;
  helpers = [];
  codes = new Map([[main, mainCode]]);
  boundary.open.mockImplementation(async () => {
    const helper = Object.create(
        StoreNativeAuthority.prototype,
      ) as StoreNativeAuthority,
      code = Object.create(
        StoreWorkerCodeAuthority.prototype,
      ) as StoreWorkerCodeAuthority;
    helpers.push(helper);
    codes.set(helper, code);
    next++;
    return helper;
  });
  boundary.data.mockResolvedValue(undefined);
  boundary.code.mockImplementation(async (authority) => codes.get(authority));
  boundary.binding.mockResolvedValue(request.binding);
  boundary.authorityClose.mockResolvedValue(undefined);
  boundary.codeClose.mockResolvedValue(undefined);
  boundary.session.mockImplementation(
    async (_authority, _code, operation, input) => {
      if (operation === "store_session_open") return observation;
      if (operation === "store_session_close") return { closed: true };
      const command = input.command as Record<string, unknown>;
      if (command.action === "session_forward") return complete(command);
      if (command.action === "session_forward_ack")
        return { acknowledged: true };
      if (command.action === "prepare_launch") return launch;
      if (command.action === "prepare_cancel")
        return { ...launch, job: "confirmed", gpu: "confirmed" };
      throw new Error("UNEXPECTED_SYNTHETIC_COMMAND");
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
describe("Store Desktop actual scope lifetime with synthetic native boundary", () => {
  it("rejects caller-created/copied scopes and fences same-turn intake when close begins", async () => {
    const client = await setup();
    expect(
      () => new StoreDesktopControlLifetime(Symbol("caller"), client),
    ).toThrow("STORE_SESSION_CLIENT_DENIED");
    const scope = client.openDesktopLifetime(),
      closing = scope.close();
    expect(() => scope.command(status())).toThrow(
      "STORE_SESSION_CLIENT_DENIED",
    );
    expect(() => scope.personalPeer()).toThrow("STORE_SESSION_CLIENT_DENIED");
    expect(scope.close()).toBe(closing);
    await closing;
    expect(() =>
      Reflect.apply(
        StoreDesktopControlLifetime.prototype.close,
        Object.create(StoreDesktopControlLifetime.prototype),
        [],
      ),
    ).toThrow();
    expect(boundary.authorityClose).not.toHaveBeenCalled();
    expect(client.currentAuthority()).toEqual(observation.owner.identity);
  });
  it("closing one scope preserves a different scope's original event helper and Prepare role", async () => {
    const client = await setup(),
      prepare = await client.launchPrepare(request),
      first = client.openDesktopLifetime(),
      second = client.openDesktopLifetime(),
      gate = deferred<unknown>();
    const handler = boundary.session.getMockImplementation()!;
    boundary.session.mockImplementation((authority, code, operation, input) => {
      const command = input.command as Record<string, unknown> | undefined;
      if (
        operation === "store_session_command" &&
        command?.action === "session_forward" &&
        authority === helpers[1]
      )
        return gate.promise;
      return handler(authority, code, operation, input);
    });
    await first.command(status());
    const pending = second.command(status());
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(commandRows()).toHaveLength(2));
    await first.close();
    expect(boundary.authorityClose).toHaveBeenCalledWith(helpers[0]);
    expect(
      boundary.authorityClose.mock.calls.some(
        ([authority]) => authority === helpers[1],
      ),
    ).toBe(false);
    expect(
      boundary.session.mock.calls.some(
        ([authority, , operation]) =>
          authority === main && operation === "store_session_close",
      ),
    ).toBe(false);
    expect(client.cleanupPending()).toBe(true);
    gate.resolve(
      complete(commandRows()[1]![3].command as Record<string, unknown>),
    );
    await pending;
    await second.close();
    await client.cancelPrepare(prepare);
    expect(client.cleanupPending()).toBe(false);
    expect(next).toBe(2);
  });
  it("joins the exact partial factory while closing and retires it without dispatching a business command", async () => {
    const client = await setup(),
      scope = client.openDesktopLifetime(),
      gate = deferred<unknown>();
    boundary.data.mockImplementation(() => gate.promise);
    const pending = scope.command(status());
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(boundary.data).toHaveBeenCalledTimes(1));
    let finished = false;
    const closing = scope.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    gate.resolve(undefined);
    await expect(pending).rejects.toThrow("STORE_DESKTOP_CONTROL_CLOSING");
    await closing;
    expect(commandRows()).toHaveLength(0);
    expect(boundary.authorityClose).toHaveBeenCalledWith(helpers[0]);
    expect(client.cleanupPending()).toBe(false);
  });
  it("retains failed original helper retirement and refuses replacement cleanup on explicit retry", async () => {
    const client = await setup(),
      scope = client.openDesktopLifetime(),
      failure = new Error("ORIGINAL_HELPER_RETIREMENT_FAILED");
    boundary.authorityClose.mockRejectedValue(failure);
    await expect(scope.command(status())).rejects.toBe(failure);
    const closing = scope.close();
    await expect(closing).rejects.toBe(failure);
    await expect(scope.recoverClose()).rejects.toBe(failure);
    expect(scope.close()).toBe(closing);
    expect(boundary.open).toHaveBeenCalledTimes(1);
    expect(boundary.authorityClose).toHaveBeenCalledTimes(1);
    expect(client.cleanupPending()).toBe(true);
  });
  it("keeps an aborted delivered request in its exact helper scope until original recovery ACK", async () => {
    const client = await setup(),
      scope = client.openDesktopLifetime(),
      gate = deferred<unknown>(),
      handler = boundary.session.getMockImplementation()!;
    boundary.session.mockImplementation((authority, code, operation, input) => {
      const command = input.command as Record<string, unknown> | undefined;
      if (
        operation === "store_session_command" &&
        command?.action === "session_forward"
      )
        return gate.promise;
      return handler(authority, code, operation, input);
    });
    const pending = scope.command(status());
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(commandRows()).toHaveLength(1));
    const original = commandRows()[0]!,
      closing = scope.close();
    gate.resolve(complete(original[3].command as Record<string, unknown>));
    await expect(pending).rejects.toThrow("STORE_DESKTOP_CONTROL_CLOSING");
    await closing;
    const rows = commandRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]![0]).toBe(rows[0]![0]);
    expect(rows[1]![3]).toEqual(rows[0]![3]);
    expect(boundary.open).toHaveBeenCalledTimes(1);
    expect(client.cleanupPending()).toBe(false);
  });
  it("uses the stable actual GUI peer for desktop artifact proof and rejects caller-selected ownership before IO", async () => {
    const client = await setup(),
      scope = client.openDesktopLifetime(),
      handler = boundary.session.getMockImplementation()!;
    boundary.session.mockImplementation((authority, code, operation, input) => {
      const command = input.command as Record<string, unknown> | undefined;
      if (
        operation !== "store_session_command" ||
        command?.action !== "session_forward"
      )
        return handler(authority, code, operation, input);
      const payload = JSON.parse(
        Buffer.from(command.payload_base64 as string, "base64").toString(),
      ) as Record<string, unknown>;
      expect(payload.kind).toBe("personal-owner-proof");
      expect(payload.owner_kind).toBe("desktop");
      expect(payload.original_peer).toEqual(identity);
      const proof = {
        version: 1,
        owner_id: payload.owner_id,
        owner_kind: "desktop",
        job_id: payload.job_id,
        video_id: payload.video_id,
        peer: identity,
        vocals: {
          artifact_id: request.requestId,
          sha256: "d".repeat(64),
          bytes: 20,
          duration_seconds: 12.5,
          content_type: "audio/mpeg",
        },
      };
      return Promise.resolve({
        version: 1,
        requestId: command.requestId,
        state: "completed",
        payload_base64: Buffer.from(
          JSON.stringify({
            version: 1,
            request_id: payload.request_id,
            ok: true,
            proof,
          }),
        ).toString("base64"),
      });
    });
    const wanted = {
      ownerId: request.requestId,
      jobId: request.requestId,
      videoId: "abcdefghijk",
      ownerKind: "desktop" as const,
      peer: scope.personalPeer(),
    };
    await expect(
      scope.provePersonalOwner({
        ...wanted,
        peer: { ...wanted.peer, pid: 999 },
      }),
    ).rejects.toThrow("STORE_SESSION_CLIENT_DENIED");
    expect(boundary.open).not.toHaveBeenCalled();
    expect((await scope.provePersonalOwner(wanted)).peer).toEqual(identity);
    await scope.close();
    expect(client.currentAuthority()).toEqual(observation.owner.identity);
  });
});
