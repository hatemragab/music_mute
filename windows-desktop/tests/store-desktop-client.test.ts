import { expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type { StorePreparationOperations } from "../src/main/prepare/store-operations.js";

// Synthetic existing native/operations scope boundaries only. This exercises
// the real connection's lifetime and selectors, not Windows executable proof.
const fixture = vi.hoisted(() => {
  class Authority {
    constructor(private gui: unknown) {}
    creatorProof() {
      if (!(this instanceof Authority)) throw Error("FORGED");
      return { gui: this.gui };
    }
  }
  class Scope {
    closeWork = vi.fn(async () => {});
    close() {
      return this.closeWork();
    }
    recoverWork = vi.fn(async () => {});
    recoverClose() {
      return this.recoverWork();
    }
    peer: unknown;
    currentAuthority() {
      if (!(this instanceof Scope)) throw Error("FORGED");
      return { pid: 400 };
    }
    personalPeer() {
      if (!(this instanceof Scope)) throw Error("FORGED");
      return this.peer;
    }
  }
  class Session {
    originalClose = vi.fn();
    constructor(readonly scope: Scope) {}
    openDesktopLifetime() {
      if (!(this instanceof Session)) throw Error("FORGED");
      return this.scope;
    }
  }
  class Ops {
    calls: unknown[] = [];
    constructor(
      private host: unknown,
      public original?: Session,
    ) {}
    assertHost(host: unknown) {
      if (this.host !== host) throw Error("FOREIGN_HOST");
    }
    async controlSession(signal: AbortSignal, options: unknown) {
      signal.throwIfAborted();
      this.calls.push(options);
      return this.original;
    }
  }
  return {
    Authority,
    Scope,
    Session,
    Ops,
    owners: new WeakMap<object, Authority>(),
  };
});
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreNativeAuthority: fixture.Authority,
  storeAuthorityForDataNative: (native: object) => fixture.owners.get(native),
}));
vi.mock("../src/main/prepare/store-operations.js", () => ({
  StorePreparationOperations: fixture.Ops,
}));
vi.mock("../src/main/session/store-session-client.js", () => ({
  StoreSessionClient: fixture.Session,
  StoreDesktopControlLifetime: fixture.Scope,
}));
import { StoreDesktopConnection } from "../src/main/session/store-desktop-client.js";

function make(absent = false) {
  const peer = {
    sid: "S-1-5-21-1-2-3-1001",
    sessionId: 1,
    pid: 100,
    creationTime: "10",
  };
  const native = { close: vi.fn() },
    authority = new fixture.Authority(peer),
    host = { native, storeAuthority: authority } as unknown as HostContext;
  fixture.owners.set(native, authority);
  const scope = new fixture.Scope();
  scope.peer = peer;
  const session = new fixture.Session(scope),
    operations = new fixture.Ops(host, absent ? undefined : session);
  return {
    host,
    native,
    scope,
    session,
    operations,
    peer,
    open: (launch = false) =>
      StoreDesktopConnection.open(
        host,
        operations as unknown as StorePreparationOperations,
        launch,
        AbortSignal.timeout(1000),
      ),
  };
}
it("returns only actual passive absence and preserves the launch preference", async () => {
  const f = make(true);
  expect(await f.open()).toBeUndefined();
  expect(f.operations.calls).toEqual([{ launchIfAbsent: false }]);
  expect(f.native.close).not.toHaveBeenCalled();
});
it("closes the exact UI scope without closing borrowed Prepare client/native", async () => {
  const f = make(),
    connection = await f.open(true);
  expect(connection).toBeDefined();
  expect(f.operations.calls).toEqual([{ launchIfAbsent: true }]);
  await connection!.close();
  await connection!.close();
  expect(f.scope.closeWork).toHaveBeenCalledOnce();
  expect(f.session.originalClose).not.toHaveBeenCalled();
  expect(f.native.close).not.toHaveBeenCalled();
});
it("retains the original close failure and recovers only the same actual scope", async () => {
  const f = make(),
    connection = (await f.open())!;
  f.scope.closeWork.mockRejectedValueOnce(Error("EXACT_SCOPE_UNCONFIRMED"));
  const original = connection.close();
  await expect(original).rejects.toThrow("EXACT_SCOPE_UNCONFIRMED");
  expect(connection.cleanupPending()).toBe(true);
  await connection.recoverClose();
  expect(f.scope.recoverWork).toHaveBeenCalledOnce();
  expect(connection.cleanupPending()).toBe(false);
  await connection.close();
  await expect(original).rejects.toThrow("EXACT_SCOPE_UNCONFIRMED");
  expect(f.scope.closeWork).toHaveBeenCalledOnce();
  expect(f.session.originalClose).not.toHaveBeenCalled();
});
it("rejects a different host or native association before opening any scope", async () => {
  const f = make();
  fixture.owners.delete(f.host.native);
  await expect(f.open()).rejects.toThrow("DENIED");
  expect(f.operations.calls).toHaveLength(0);
  const other = make();
  await expect(
    StoreDesktopConnection.open(
      other.host,
      f.operations as unknown as StorePreparationOperations,
      false,
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow("FOREIGN_HOST");
});
it("requires the same actual GUI parent rather than helper or caller owner identity", async () => {
  const f = make();
  f.scope.peer = { ...f.peer, pid: 101 };
  await expect(f.open()).rejects.toThrow("DENIED");
  expect(f.scope.closeWork).toHaveBeenCalledOnce();
  expect(f.session.originalClose).not.toHaveBeenCalled();
});
it("borrows only its original live connection for enrollment settlement", async () => {
  const f = make(),
    connection = (await f.open())!,
    operations = f.operations as unknown as StorePreparationOperations;
  expect(() => connection.assertHost(f.host, operations)).not.toThrow();
  expect(() =>
    connection.assertHost({ ...f.host } as HostContext, operations),
  ).toThrow("DENIED");
  expect(() =>
    connection.assertHost(
      f.host,
      make().operations as unknown as StorePreparationOperations,
    ),
  ).toThrow("DENIED");
  expect(() =>
    StoreDesktopConnection.prototype.assertHost.call(
      Object.create(StoreDesktopConnection.prototype),
      f.host,
      operations,
    ),
  ).toThrow();
  fixture.owners.delete(f.native);
  expect(() => connection.assertHost(f.host, operations)).toThrow("DENIED");
  expect(f.scope.closeWork).not.toHaveBeenCalled();
  expect(f.session.originalClose).not.toHaveBeenCalled();
});
it("never borrows a scope after its original close has begun or recovered", async () => {
  const f = make(),
    connection = (await f.open())!,
    operations = f.operations as unknown as StorePreparationOperations;
  f.scope.closeWork.mockRejectedValueOnce(Error("EXACT_SCOPE_UNCONFIRMED"));
  const closing = connection.close();
  expect(() => connection.assertHost(f.host, operations)).toThrow("DENIED");
  await expect(closing).rejects.toThrow("EXACT_SCOPE_UNCONFIRMED");
  await connection.recoverClose();
  expect(() => connection.assertHost(f.host, operations)).toThrow("DENIED");
});
